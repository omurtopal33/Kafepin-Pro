from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import unicodedata
import webbrowser
from pathlib import Path
from typing import Any

import pyperclip
import requests as http_requests
from yt_dlp import YoutubeDL
from flask import Flask, Response, jsonify, request, send_file, send_from_directory, stream_with_context

try:
    from mutagen import File as MutagenFile
except Exception:
    MutagenFile = None

from audio_normalizer import get_eq_presets
from library_metadata import display_name_for_path, duration_seconds_for_path

LISTEN_EQ_PRESETS = (
    "Orijinal / Düz",
    "Normal Dengeli",
    "Araba Dengeli",
    "Araba Baslı",
    "Pop Canlı",
    "Rock Güçlü",
    "Vokal Net",
    "Kulaklık Dengeli",
    "Gece Yumuşak",
    "Derin Bas",
)

from audio_player import Mp3Player
from config import DATA_DIR, load_config, save_config
from direct_downloader import direct_engine_status, download_mp3
from duplicate_guard import car_artist_title, dedupe_song_texts, find_duplicate_mp3, normalize_youtube_url, row_key
from eq_preview import EqPreviewEngine
from file_mover import (
    ensure_customer_folder,
    safe_customer_name,
)
from phone_upload import PhoneUploadServer
from song_parser import clean_song_lines, parse_text
from youtube_search import discover_youtube, search_youtube, find_artist_collections, load_artist_collection, split_song
from usb_sales import AUDIO_EXTENSIONS, UsbSalesManager
from usb_film_sales import VIDEO_EXTENSIONS, UsbFilmSalesManager
from usb_game_sales import PACKAGE_EXTENSIONS, UsbGameSalesManager

try:
    from clipboard_image import copy_image, copy_image_and_text
except Exception:
    copy_image = None
    copy_image_and_text = None


APP_VERSION = "2.34.31-winamp-queue-library"
FUNCTIONAL_BASELINE = "2.26"
HOST = "127.0.0.1"
PORT = 17890

# Doğrulanmış eski arşiv eşleştirmeleri. Kaynak dosyaya dokunmadan, eksik
# Title etiketi olan Track01 benzeri kayıtları gerçek parça adıyla gösterir.
CURATED_ALBUM_TRACKS = {
    "askin nur yengi gozumun bebegi": (
        "Öpeyim Geçsin", "Gözümün Bebeği", "Hayırlı Olsun", "Başka Sözüm Yok", "Tutmadım",
        "Yasak Elmam", "Bekleyenim Var", "Kibrit ve Alev", "Kahve Bahane", "Ayrı Gayrı",
    ),
}


def _catalog_key(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).replace("ı", "i")
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def _catalog_title_for_track(path: Path) -> str:
    match = re.fullmatch(r"(?:track|parca|parça|song)?[ ._-]*0*(\d+)", path.stem, flags=re.IGNORECASE)
    if not match:
        return ""
    index = int(match.group(1)) - 1
    folder_key = _catalog_key(path.parent.name)
    for album_key, titles in CURATED_ALBUM_TRACKS.items():
        if album_key in folder_key and 0 <= index < len(titles):
            return titles[index]
    return ""


def _library_track_label(path: Path) -> str:
    """Tek ortak adlandırma kuralı: her yerde Sanatçı - Şarkı."""
    return display_name_for_path(path)
APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
PID_FILE = DATA_DIR / "web_service.pid"

# KAFEPIN_YOUTUBE_INSTANT_STREAM_V2348
_YT_STREAM_CACHE: dict[str, dict[str, Any]] = {}
_YT_STREAM_CACHE_LOCK = threading.RLock()
_YT_STREAM_CACHE_TTL = 15 * 60
_YT_STREAM_PREWARM_EVENTS: dict[str, threading.Event] = {}
_YT_STREAM_PREWARM_SEM = threading.BoundedSemaphore(4)


def _instant_stream_profiles() -> list[dict[str, Any]]:
    return [
        {"name": "Normal + IPv4", "source_address": "0.0.0.0"},
        {
            "name": "Android VR",
            "source_address": "0.0.0.0",
            "extractor_args": {"youtube": {"player_client": ["android_vr"]}},
        },
        {
            "name": "Web Embedded",
            "source_address": "0.0.0.0",
            "extractor_args": {"youtube": {"player_client": ["web_embedded"]}},
        },
        {"name": "Chrome", "source_address": "0.0.0.0", "impersonate": "chrome"},
    ]


def _direct_audio_row(info: dict[str, Any]) -> dict[str, Any] | None:
    def usable(row: Any) -> bool:
        if not isinstance(row, dict):
            return False
        url = str(row.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            return False
        return str(row.get("acodec") or "").casefold() != "none"

    if usable(info):
        return info

    for key in ("requested_downloads", "requested_formats"):
        rows = info.get(key)
        if isinstance(rows, list):
            for row in rows:
                if usable(row):
                    return row

    rows = info.get("formats")
    if isinstance(rows, list):
        candidates = [row for row in rows if usable(row)]
        if candidates:
            candidates.sort(
                key=lambda row: (
                    1 if str(row.get("vcodec") or "none").casefold() == "none" else 0,
                    1 if str(row.get("protocol") or "").casefold().startswith("http") else 0,
                    float(row.get("abr") or row.get("tbr") or 0.0),
                ),
                reverse=True,
            )
            return candidates[0]
    return None


def _resolve_youtube_instant_stream(
    source_url: str,
    *,
    start_profile: int = 0,
    bypass_cache: bool = False,
) -> dict[str, Any]:
    source_url = normalize_youtube_url(source_url)
    if not source_url:
        raise RuntimeError("Geçerli YouTube bağlantısı yok.")

    now = time.monotonic()
    if not bypass_cache and start_profile <= 0:
        with _YT_STREAM_CACHE_LOCK:
            cached = _YT_STREAM_CACHE.get(source_url)
            if cached and (now - float(cached.get("cached_at") or 0.0)) < _YT_STREAM_CACHE_TTL:
                return dict(cached)

    errors: list[str] = []
    profiles = _instant_stream_profiles()
    for profile_index in range(max(0, int(start_profile)), len(profiles)):
        profile = profiles[profile_index]
        options: dict[str, Any] = {
            "format": "bestaudio[protocol^=http][vcodec=none]/bestaudio[protocol^=http]/bestaudio/best",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "cachedir": False,
            "socket_timeout": 10,
            "retries": 1,
            "fragment_retries": 1,
        }
        if profile.get("source_address"):
            options["source_address"] = profile["source_address"]
        if profile.get("extractor_args"):
            options["extractor_args"] = profile["extractor_args"]
        if profile.get("impersonate"):
            options["impersonate"] = profile["impersonate"]

        try:
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(source_url, download=False)
            if not isinstance(info, dict):
                raise RuntimeError("YouTube ses bilgisi alınamadı.")
            row = _direct_audio_row(info)
            if not row:
                raise RuntimeError("Doğrudan ses akışı bulunamadı.")
            result = {
                "source_url": source_url,
                "stream_url": str(row.get("url") or ""),
                "http_headers": dict(row.get("http_headers") or info.get("http_headers") or {}),
                "profile_index": profile_index,
                "profile_name": str(profile.get("name") or profile_index),
                "cached_at": time.monotonic(),
            }
            with _YT_STREAM_CACHE_LOCK:
                _YT_STREAM_CACHE[source_url] = dict(result)
            return result
        except Exception as exc:
            errors.append(f"{profile.get('name')}: {exc}")

    raise RuntimeError("YouTube anlık ses akışı çözülemedi. " + " | ".join(errors[-4:]))


def _prewarm_youtube_stream_urls(rows: list[dict[str, Any]], limit: int = 8) -> None:
    """Resolve a few visible search results in RAM only. No MP3/file download occurs."""
    urls: list[str] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        url = normalize_youtube_url(str(row.get("url") or ""))
        if url and url not in urls:
            urls.append(url)
        if len(urls) >= max(1, int(limit)):
            break

    now = time.monotonic()
    for url in urls:
        with _YT_STREAM_CACHE_LOCK:
            cached = _YT_STREAM_CACHE.get(url)
            if cached and (now - float(cached.get("cached_at") or 0.0)) < _YT_STREAM_CACHE_TTL:
                continue
            if url in _YT_STREAM_PREWARM_EVENTS:
                continue
            event = threading.Event()
            _YT_STREAM_PREWARM_EVENTS[url] = event

        def work(source_url: str = url, done: threading.Event = event) -> None:
            try:
                with _YT_STREAM_PREWARM_SEM:
                    _resolve_youtube_instant_stream(source_url)
            except Exception:
                pass
            finally:
                with _YT_STREAM_CACHE_LOCK:
                    current = _YT_STREAM_PREWARM_EVENTS.get(source_url)
                    if current is done:
                        _YT_STREAM_PREWARM_EVENTS.pop(source_url, None)
                    done.set()

        threading.Thread(target=work, daemon=True, name="mp3-youtube-stream-prewarm").start()


def _wait_for_prewarm(source_url: str, timeout: float = 12.0) -> bool:
    """Join the single in-flight resolver instead of starting a duplicate yt-dlp call.

    A click immediately after search can arrive while the RAM prewarm is still
    resolving the same signed URL. Waiting for that one resolver is faster and
    avoids the concurrent YouTube requests that previously caused 403/retry
    delays. ``False`` only means no prewarm was active or it exceeded the
    bounded wait; callers may then perform their own resolution.
    """
    with _YT_STREAM_CACHE_LOCK:
        event = _YT_STREAM_PREWARM_EVENTS.get(source_url)
    if event is not None:
        return bool(event.wait(max(0.0, float(timeout))))
    return False


def _upstream_headers(resolved: dict[str, Any], browser_range: str = "") -> dict[str, str]:
    blocked = {"host", "content-length", "connection", "transfer-encoding", "accept-encoding"}
    headers: dict[str, str] = {}
    for key, value in dict(resolved.get("http_headers") or {}).items():
        if str(key).casefold() in blocked or value is None:
            continue
        headers[str(key)] = str(value)
    headers.setdefault("User-Agent", "Mozilla/5.0")
    headers["Accept-Encoding"] = "identity"
    if browser_range:
        headers["Range"] = browser_range
    return headers




def _int_value(value: Any, default: int) -> int:
    try:
        if value is None or value == "":
            return int(default)
        return int(value)
    except Exception:
        return int(default)

CHATGPT_LIST_PROMPT = (
    "Bu fotoğraftaki el yazısı müzik listesini oku. "
    "Sanatçı ile hemen altındaki şarkı adını eşleştir. "
    "Sonucu SADECE her satırda 'SANATÇI - ŞARKI' biçiminde ver. "
    "Numara, açıklama, madde işareti veya ek yorum yazma. "
    "Emin olmadığın satırı uydurma."
)


def _json_error(message: str, status: int = 400, *, detail: str | None = None):
    payload = {"ok": False, "error": str(message)}
    if detail:
        payload["detail"] = detail
    return jsonify(payload), status


def _clean_chatgpt_text(text: str) -> list[str]:
    cleaned_lines: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("```") or line.endswith("```"):
            continue
        line = re.sub(r"^\s*(?:\d+[\.\)\-:]|[-•*])\s*", "", line)
        line = line.strip(" `\t")
        if " - " in line:
            cleaned_lines.append(line)
        elif "-" in line and len(line.split("-", 1)[0].strip()) >= 2:
            left, right = line.split("-", 1)
            cleaned_lines.append(f"{left.strip()} - {right.strip()}")
    return clean_song_lines(cleaned_lines)


class Mp3WebCore:
    def __init__(self):
        self.lock = threading.RLock()
        self.cfg = load_config()
        self.rows: list[dict[str, Any]] = []
        self.status = "Hazır"
        self.stop_event = threading.Event()
        self.move_stop_event = threading.Event()
        self.move_thread: threading.Thread | None = None
        self.download_thread: threading.Thread | None = None
        self.download_running = False
        self.download_summary = ""
        self.moved_count = 0

        self.player = Mp3Player()
        self.player_customer = ""
        self.player_paths: list[Path] = []
        self.winamp_folder: Path | None = None
        self.winamp_paths: list[Path] = []
        self.winamp_stream_paths: dict[str, Path] = {}
        self.winamp_search_cache: dict[str, list[tuple[Path, str, int]]] = {}
        self.winamp_library_index: dict[str, list[Path]] = {}
        self.favorite_paths: list[Path] = []
        self.player_index: int | None = None
        self.player_message = "Hazır — müşteri ve şarkı seç."

        self.eq_preview = EqPreviewEngine()
        self.preview_loading = False
        self.preview_message = "Önizleme hazır."

        self.phone_server: PhoneUploadServer | None = None
        self.last_phone_photo: str | None = None
        self.phone_message = "Telefon fotoğraf servisi kapalı."

        self._player_monitor_thread = threading.Thread(
            target=self._player_monitor_loop,
            daemon=True,
            name="mp3-web-player-monitor",
        )
        self._player_monitor_thread.start()

    # ---------- generic state ----------
    def set_status(self, text: str) -> None:
        with self.lock:
            self.status = str(text)

    def public_config(self) -> dict[str, Any]:
        with self.lock:
            cfg = dict(self.cfg)
        return {
            "customer_root": str(cfg.get("customer_root") or ""),
            "favorites_root": str(cfg.get("favorites_root") or ""),
            "winamp_folder": str(cfg.get("winamp_folder") or ""),
            "winamp_saved_locations": list(cfg.get("winamp_saved_locations") or []),
            "download_method": "native",
            "direct_bitrate_kbps": int(cfg.get("direct_bitrate_kbps", 320) or 320),
            "eq_preset": str(cfg.get("eq_preset") or "Araba Dengeli"),
            "listen_eq_preset": str(cfg.get("listen_eq_preset") or "Orijinal / Düz"),
            "player_volume": max(0, min(100, _int_value(cfg.get("player_volume"), 85))),
            "usb_unit_price": max(0.0, float(cfg.get("usb_unit_price", 10.0) or 0)),
            "usb_folder_name": str(cfg.get("usb_folder_name") or "Muzikler"),
            "usb_layout": str(cfg.get("usb_layout") or "customer"),
            "usb_payment_method": str(cfg.get("usb_payment_method") or "CASH"),
            "usb_bitrate_kbps": int(cfg.get("usb_bitrate_kbps", 192)),
            "usb_shuffle": bool(cfg.get("usb_shuffle", True)),
            "usb_saved_locations": list(cfg.get("usb_saved_locations") or []),
            "usb_film_unit_price": max(0.0, float(cfg.get("usb_film_unit_price", 50.0) or 0)),
            "usb_film_folder_name": str(cfg.get("usb_film_folder_name") or "Filmler"),
            "usb_film_layout": str(cfg.get("usb_film_layout") or "folders"),
            "usb_film_payment_method": str(cfg.get("usb_film_payment_method") or "CASH"),
            "usb_film_profile": str(cfg.get("usb_film_profile") or "original"),
            "usb_film_shuffle": bool(cfg.get("usb_film_shuffle", False)),
            "usb_film_saved_locations": list(cfg.get("usb_film_saved_locations") or []),
            "usb_game_unit_price": max(0.0, float(cfg.get("usb_game_unit_price", 100.0) or 0)),
            "usb_game_folder_name": str(cfg.get("usb_game_folder_name") or "Oyunlar"),
            "usb_game_payment_method": str(cfg.get("usb_game_payment_method") or "CASH"),
            "usb_game_saved_locations": list(cfg.get("usb_game_saved_locations") or []),
            "eq_presets": list(get_eq_presets()),
            "listen_eq_presets": list(LISTEN_EQ_PRESETS),
        }

    def update_config(self, data: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "customer_root",
            "favorites_root",
            "winamp_saved_locations",
            "direct_bitrate_kbps",
            "eq_preset",
            "listen_eq_preset",
            "player_volume",
            "usb_unit_price",
            "usb_folder_name",
            "usb_layout",
            "usb_payment_method",
            "usb_bitrate_kbps",
            "usb_shuffle",
            "usb_saved_locations",
            "usb_film_unit_price",
            "usb_film_folder_name",
            "usb_film_layout",
            "usb_film_payment_method",
            "usb_film_profile",
            "usb_film_shuffle",
            "usb_film_saved_locations",
            "usb_game_unit_price",
            "usb_game_folder_name",
            "usb_game_payment_method",
            "usb_game_saved_locations",
        }
        with self.lock:
            for key in allowed:
                if key not in data:
                    continue
                value = data[key]
                if key in {"winamp_saved_locations", "usb_saved_locations", "usb_film_saved_locations", "usb_game_saved_locations"}:
                    if not isinstance(value, list):
                        raise ValueError("Arşiv konumları liste olmalıdır.")
                    cleaned: list[str] = []
                    for item in value:
                        path = str(item or "").strip()
                        if not path or path in cleaned:
                            continue
                        if len(path) > 240:
                            raise ValueError("Arşiv yolu çok uzun.")
                        cleaned.append(path)
                    value = cleaned[:12]
                elif key == "direct_bitrate_kbps":
                    value = int(value)
                    if value not in (128, 320):
                        raise ValueError("MP3 kalitesi yalnız 128 veya 320 kbps olabilir.")
                elif key == "player_volume":
                    value = max(0, min(100, int(value)))
                elif key == "usb_unit_price":
                    value = round(float(value), 2)
                    if value < 0:
                        raise ValueError("Şarkı fiyatı negatif olamaz.")
                elif key == "usb_layout":
                    value = str(value or "customer").lower()
                    if value not in {"customer", "artist", "flat"}:
                        raise ValueError("Geçersiz USB klasör düzeni.")
                elif key == "usb_payment_method":
                    value = str(value or "CASH").upper()
                    if value not in {"CASH", "CARD"}:
                        raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
                elif key == "usb_bitrate_kbps":
                    value = int(value)
                    if value not in {0, 128, 192, 320}:
                        raise ValueError("USB MP3 kalitesi yalnız Orijinal, 128, 192 veya 320 kbps olabilir.")
                elif key == "usb_shuffle":
                    value = bool(value)
                elif key == "usb_film_unit_price":
                    value = round(float(value), 2)
                    if value < 0:
                        raise ValueError("Film fiyatı negatif olamaz.")
                elif key == "usb_film_layout":
                    value = str(value or "folders").lower()
                    if value not in {"folders", "flat"}:
                        raise ValueError("Geçersiz film klasör düzeni.")
                elif key == "usb_film_payment_method":
                    value = str(value or "CASH").upper()
                    if value not in {"CASH", "CARD"}:
                        raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
                elif key == "usb_film_profile":
                    value = str(value or "original").lower()
                    if value not in {"original", "mp4_720", "mp4_1080"}:
                        raise ValueError("Geçersiz film uyumluluk profili.")
                elif key == "usb_film_shuffle":
                    value = bool(value)
                elif key == "usb_game_unit_price":
                    value = round(float(value), 2)
                    if value < 0:
                        raise ValueError("Oyun fiyatı negatif olamaz.")
                elif key == "usb_game_payment_method":
                    value = str(value or "CASH").upper()
                    if value not in {"CASH", "CARD"}:
                        raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
                elif key == "eq_preset":
                    if value not in get_eq_presets():
                        raise ValueError("Geçersiz indirme EQ seçimi.")
                elif key == "listen_eq_preset":
                    if value not in LISTEN_EQ_PRESETS:
                        raise ValueError("Geçersiz dinleme EQ seçimi.")
                else:
                    value = str(value or "").strip()
                    if key == "favorites_root" and not value:
                        continue
                self.cfg[key] = value
            save_config(self.cfg)
            try:
                self.player.volume = int(self.cfg.get("player_volume", 85))
            except Exception:
                pass
        return self.public_config()

    # ---------- list / search ----------
    def rows_public(self) -> list[dict[str, Any]]:
        with self.lock:
            out = []
            for i, row in enumerate(self.rows):
                out.append({
                    "index": i,
                    "query": str(row.get("query") or ""),
                    "title": str(row.get("title") or ""),
                    "url": str(row.get("url") or ""),
                    "score": row.get("score", ""),
                    "status": str(row.get("status") or ""),
                    "artist": str(row.get("artist") or ""),
                    "track_title": str(row.get("track_title") or ""),
                    "artist_id": str(row.get("artist_id") or ""),
                })
            return out

    def set_text_list(self, text: str) -> dict[str, Any]:
        songs = parse_text(text or "")
        songs, dropped = dedupe_song_texts(songs)
        with self.lock:
            self.rows = [
                {
                    "query": q,
                    "title": "",
                    "url": "",
                    "score": "",
                    "status": "Hazır",
                    "candidates": [],
                    "artist": car_artist_title(q)[0],
                    "track_title": car_artist_title(q)[1],
                    "artist_id": "",
                }
                for q in songs
            ]
            self.status = (
                f"{len(songs)} şarkı | {len(dropped)} tekrar engellendi"
                if dropped else f"{len(songs)} şarkı hazır"
            )
        return {"rows": self.rows_public(), "dropped": dropped}

    def add_candidates(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        with self.lock:
            existing = {row_key(row) for row in self.rows if row_key(row)}
            added = 0
            duplicate = 0
            for item in items or []:
                raw_title = str(item.get("track_title") or item.get("title") or "").strip()
                raw_artist = str(item.get("artist") or item.get("channel") or "").strip()
                url = normalize_youtube_url(str(item.get("url") or "").strip())
                if not raw_title or not url:
                    continue
                artist, track_title = car_artist_title(
                    raw_title,
                    fallback_artist=raw_artist,
                    fallback_title=raw_title,
                )
                query = f"{artist} - {track_title}" if artist and track_title else (track_title or raw_title)
                temp = {"query": query, "title": raw_title, "url": url}
                key = row_key(temp)
                if key and key in existing:
                    duplicate += 1
                    continue
                self.rows.append({
                    "query": query,
                    "title": raw_title,
                    "url": url,
                    "score": item.get("score", "Seçildi"),
                    "status": "İndirmeye hazır",
                    "candidates": [],
                    "artist": artist,
                    "track_title": track_title,
                    "artist_id": str(item.get("artist_id") or "").strip(),
                })
                if key:
                    existing.add(key)
                added += 1
            self.status = f"Listeye {added} şarkı eklendi"
            if duplicate:
                self.status += f" | {duplicate} tekrar engellendi"
        return {"added": added, "duplicate": duplicate, "rows": self.rows_public()}

    def delete_rows(self, indices: list[int]) -> None:
        with self.lock:
            for index in sorted({int(x) for x in indices}, reverse=True):
                if 0 <= index < len(self.rows):
                    self.rows.pop(index)
            self.status = f"Listede {len(self.rows)} şarkı"

    def clear_rows(self) -> None:
        with self.lock:
            self.rows = []
            self.status = "Liste temizlendi"

    def youtube_search(self, query: str, max_results: int = 40) -> list[dict[str, Any]]:
        query = str(query or "").strip()
        if not query:
            raise ValueError("Sanatçı veya şarkı adı yaz.")
        # Discovery behaves like normal YouTube search: the literal user query
        # is sent unchanged and the primary YouTube result order is preserved.
        # Exact/fail-closed matching is used only by automatic text-list
        # resolution, not to hide normal YouTube search results from the user.
        found = discover_youtube(query, max(1, min(60, int(max_results))))
        out = []
        for position, c in enumerate(found, start=1):
            artist, track_title = car_artist_title(
                c.title, fallback_artist=c.channel, fallback_title=c.title
            )
            out.append({
                "title": c.title,
                "channel": c.channel,
                "artist": artist or c.channel,
                "track_title": track_title or c.title,
                "artist_id": c.artist_id,
                "channel_id": c.channel_id,
                "channel_url": c.channel_url,
                "url": c.url,
                "duration": c.duration,
                "score": c.score,
                "match_score": c.match_score,
                "strict_match": c.strict_match,
                "match_reason": c.match_reason,
                "youtube_rank": position,
            })
        return out

    def artist_lists(self, artist_name: str, artist_id: str = "", channel_url: str = "", channel_id: str = "", channel_name: str = "") -> dict[str, Any]:
        return find_artist_collections(
            artist_name, artist_id, max_collections=70,
            selected_channel_url=channel_url, selected_channel_id=channel_id,
            selected_channel_name=channel_name,
        )

    def artist_collection_tracks(self, collection_id: str, kind: str, artist_name: str = "") -> list[dict[str, Any]]:
        rows = load_artist_collection(collection_id, kind, artist_name, limit=150)
        return [
            {
                "title": c.title,
                "channel": c.channel,
                "artist": c.channel or artist_name,
                "artist_id": c.artist_id,
                "channel_id": c.channel_id,
                "channel_url": c.channel_url,
                "url": c.url,
                "duration": c.duration,
                "score": c.score,
                "match_score": c.match_score,
                "strict_match": c.strict_match,
                "match_reason": c.match_reason,
            }
            for c in rows
        ]

    def resolve_all_async(self) -> None:
        with self.lock:
            if self.download_running:
                raise RuntimeError("İndirme/çözümleme işlemi zaten çalışıyor.")
            if not self.rows:
                raise ValueError("Önce şarkı listesi oluştur.")
            self.download_running = True
            self.stop_event.clear()
            self.status = "YouTube bağlantıları hazırlanıyor..."

        def work():
            try:
                self._resolve_missing_rows()
                self.set_status("YouTube araması tamamlandı")
            finally:
                with self.lock:
                    self.download_running = False

        self.download_thread = threading.Thread(target=work, daemon=True, name="mp3-web-resolve")
        self.download_thread.start()

    def _resolve_missing_rows(self) -> tuple[int, int]:
        success = 0
        failed = 0
        with self.lock:
            indices = [i for i, row in enumerate(self.rows) if not row.get("url")]
        for i in indices:
            if self.stop_event.is_set():
                break
            with self.lock:
                if i >= len(self.rows):
                    continue
                query = str(self.rows[i].get("query") or "")
                self.rows[i]["status"] = "YouTube aranıyor"
            try:
                cands = search_youtube(query, int(self.cfg.get("youtube_results", 5)))
                with self.lock:
                    if i >= len(self.rows):
                        continue
                    self.rows[i]["candidates"] = cands
                    if cands:
                        c = cands[0]
                        self.rows[i]["title"] = c.title
                        self.rows[i]["url"] = c.url
                        self.rows[i]["score"] = c.score
                        req_artist, req_title = car_artist_title(query, fallback_artist=c.channel, fallback_title=c.title)
                        self.rows[i]["artist"] = req_artist or c.channel
                        self.rows[i]["track_title"] = req_title or c.title
                        self.rows[i]["artist_id"] = c.artist_id
                        self.rows[i]["status"] = "İndirmeye hazır" if c.score >= 55 else "Eşleşme düşük / indirilecek"
                        success += 1
                    else:
                        self.rows[i]["status"] = "Tam sanatçı + şarkı eşleşmesi bulunamadı"
                        self.rows[i]["url"] = ""
                        failed += 1
            except Exception as exc:
                with self.lock:
                    if i < len(self.rows):
                        self.rows[i]["status"] = "Arama hatası"
                        self.rows[i]["title"] = str(exc)[:120]
                failed += 1
        return success, failed

    # ---------- customer / filesystem ----------
    def customer_root(self) -> Path:
        root = Path(str(self.cfg.get("customer_root") or "")).expanduser()
        if not str(root).strip():
            raise ValueError("Müşteri kayıt ana yolu boş.")
        return root

    def customer_folder(self, customer: str, create: bool = False) -> Path:
        root = self.customer_root()
        name = safe_customer_name(str(customer or ""))
        if not name:
            raise ValueError("Müşteri adı boş.")
        if create:
            return ensure_customer_folder(root, name)
        return root / name

    def favorites_root(self, create: bool = False) -> Path:
        root = Path(str(self.cfg.get("favorites_root") or "")).expanduser()
        if not str(root).strip():
            raise ValueError("Favori klasörü seçilmedi.")
        if create:
            root.mkdir(parents=True, exist_ok=True)
        return root

    def list_customers(self) -> list[str]:
        root = self.customer_root()
        if not root.exists():
            return []
        return sorted([p.name for p in root.iterdir() if p.is_dir()], key=str.casefold)

    def list_tracks(self, customer: str) -> list[dict[str, Any]]:
        folder = self.customer_folder(customer, create=False)
        if not folder.exists():
            return []
        tracks = []
        for p in sorted(folder.glob("*.mp3"), key=lambda x: x.name.casefold()):
            if not p.is_file():
                continue
            try:
                size_mb = p.stat().st_size / (1024 * 1024)
            except Exception:
                size_mb = 0.0
            tracks.append({"name": p.name, "size_mb": round(size_mb, 1)})
        return tracks

    def track_path(self, customer: str, index: int) -> Path:
        folder = self.customer_folder(customer, create=False)
        if not folder.exists():
            raise FileNotFoundError("Müşteri klasörü bulunamadı.")
        paths = sorted(
            [p for p in folder.glob("*.mp3") if p.is_file()],
            key=lambda p: p.name.casefold(),
        )
        if not paths:
            raise FileNotFoundError("Bu müşteri klasöründe MP3 yok.")
        index = int(index)
        if index < 0 or index >= len(paths):
            raise IndexError("Şarkı sırası geçersiz.")
        return paths[index]

    def delete_track(self, customer: str, index: int) -> str:
        path = self.track_path(customer, index)
        name = path.name
        try:
            path.unlink()
        except PermissionError as exc:
            raise RuntimeError("Şarkı kullanımda. Önce DURDUR'a basıp tekrar dene.") from exc
        if path.exists():
            raise RuntimeError("Şarkı silinemedi.")
        with self.lock:
            if self.player_customer == customer:
                self.player_paths = [p for p in self.player_paths if p != path]
                if self.player_index is not None and self.player_index >= len(self.player_paths):
                    self.player_index = None
        self.set_status(f"Silindi: {name}")
        return name

    def delete_customer_folder(self, customer: str) -> str:
        if self.download_running:
            raise RuntimeError("İndirme sürerken müşteri klasörü silinemez.")
        folder = self.customer_folder(customer, create=False)
        root = self.customer_root()
        if not folder.exists() or not folder.is_dir():
            raise FileNotFoundError("Müşteri klasörü bulunamadı.")
        if folder.is_symlink():
            raise RuntimeError("Bağlantı olan müşteri klasörü güvenlik nedeniyle silinmedi.")
        root_resolved = root.resolve()
        folder_resolved = folder.resolve()
        if folder_resolved.parent != root_resolved:
            raise RuntimeError("Silme hedefi müşteri ana klasörünün doğrudan altında değil.")
        favorite_resolved = self.favorites_root(create=True).resolve()
        if favorite_resolved == folder_resolved or folder_resolved in favorite_resolved.parents:
            raise RuntimeError("Favori klasörü bu müşteri klasörünün içinde. Önce Favori klasörünü dışarı taşı.")
        with self.lock:
            active = self.player_customer == customer
        if active:
            try:
                self.player.stop()
            except Exception:
                pass
            with self.lock:
                self.player_customer = ""
                self.player_paths = []
                self.player_index = None
                self.player_message = "■ Müşteri klasörü silindi"
        try:
            shutil.rmtree(folder_resolved)
        except PermissionError as exc:
            raise RuntimeError("Müşteri klasöründeki bir dosya kullanımda. Müziği DURDUR ve tekrar dene.") from exc
        if folder_resolved.exists():
            raise RuntimeError("Müşteri klasörü tamamen silinemedi.")
        self.set_status(f"Müşteri klasörü silindi: {folder.name}")
        return folder.name

    @staticmethod
    def _bring_window_to_front(hwnd: int) -> bool:
        """Restore and foreground a native Windows window without keeping it topmost."""
        if os.name != "nt" or not hwnd:
            return False
        try:
            import ctypes
            from ctypes import wintypes

            user32 = ctypes.WinDLL("user32", use_last_error=True)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

            user32.GetForegroundWindow.restype = wintypes.HWND
            user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
            user32.GetWindowThreadProcessId.restype = wintypes.DWORD
            user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
            user32.AttachThreadInput.restype = wintypes.BOOL
            user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.ShowWindow.restype = wintypes.BOOL
            user32.BringWindowToTop.argtypes = [wintypes.HWND]
            user32.BringWindowToTop.restype = wintypes.BOOL
            user32.SetForegroundWindow.argtypes = [wintypes.HWND]
            user32.SetForegroundWindow.restype = wintypes.BOOL
            user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
            user32.SetWindowPos.restype = wintypes.BOOL
            kernel32.GetCurrentThreadId.restype = wintypes.DWORD

            SW_RESTORE = 9
            HWND_TOPMOST = wintypes.HWND(-1)
            HWND_NOTOPMOST = wintypes.HWND(-2)
            SWP_NOSIZE = 0x0001
            SWP_NOMOVE = 0x0002
            SWP_SHOWWINDOW = 0x0040
            flags = SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW

            target = wintypes.HWND(int(hwnd))
            foreground = user32.GetForegroundWindow()
            current_tid = kernel32.GetCurrentThreadId()
            target_tid = user32.GetWindowThreadProcessId(target, None)
            foreground_tid = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
            attached: list[int] = []

            try:
                for tid in (foreground_tid, target_tid):
                    if tid and tid != current_tid and tid not in attached:
                        if user32.AttachThreadInput(current_tid, tid, True):
                            attached.append(int(tid))

                user32.ShowWindow(target, SW_RESTORE)
                # A short TOPMOST -> NOTOPMOST pulse reliably lifts Explorer above
                # the KafePin WebView without leaving Explorer permanently topmost.
                user32.SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, flags)
                user32.SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, flags)
                user32.BringWindowToTop(target)
                focused = bool(user32.SetForegroundWindow(target))
                return focused or bool(user32.GetForegroundWindow() == target)
            finally:
                for tid in reversed(attached):
                    try:
                        user32.AttachThreadInput(current_tid, tid, False)
                    except Exception:
                        pass
        except Exception:
            return False

    @staticmethod
    def _find_explorer_window(folder: Path, timeout: float = 3.0) -> int | None:
        """Return the Explorer HWND currently showing *folder* (works with reused Win11 Explorer windows/tabs)."""
        if os.name != "nt":
            return None
        expected = os.path.normcase(os.path.abspath(str(folder)))
        deadline = time.monotonic() + max(0.5, float(timeout))
        pythoncom = None
        try:
            import pythoncom as _pythoncom
            import win32com.client
            pythoncom = _pythoncom
            pythoncom.CoInitialize()
            shell = win32com.client.Dispatch("Shell.Application")
            while time.monotonic() < deadline:
                try:
                    windows = shell.Windows()
                    count = int(windows.Count)
                except Exception:
                    count = 0
                for i in range(count):
                    try:
                        window = windows.Item(i)
                        hwnd = int(window.HWND)
                        shown = str(window.Document.Folder.Self.Path or "")
                        if shown and os.path.normcase(os.path.abspath(shown)) == expected:
                            return hwnd
                    except Exception:
                        continue
                time.sleep(0.10)
        except Exception:
            return None
        finally:
            if pythoncom is not None:
                try:
                    pythoncom.CoUninitialize()
                except Exception:
                    pass
        return None

    def _open_folder(self, folder: Path) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            raise RuntimeError("Klasör açma yalnız Windows testinde kullanılabilir.")

        import subprocess

        # Explorer may reuse an existing Windows 11 window/tab, so first request
        # the exact folder and then locate the Explorer HWND by its real path.
        try:
            subprocess.Popen(
                ["explorer.exe", str(folder)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        except Exception:
            os.startfile(str(folder))

        hwnd = self._find_explorer_window(folder, timeout=3.0)
        if hwnd:
            self._bring_window_to_front(hwnd)

    def open_customer_folder(self, customer: str) -> None:
        self._open_folder(self.customer_folder(customer, create=True))

    def open_favorites_folder(self) -> None:
        self._open_folder(self.favorites_root(create=True))

    def choose_customer_root(self) -> str:
        if os.name != "nt":
            raise RuntimeError("Klasör seçimi yalnız Windows'ta kullanılabilir.")
        import tkinter as tk
        from tkinter import filedialog

        current = Path(str(self.cfg.get("customer_root") or Path.home())).expanduser()
        initial = current if current.exists() else Path.home()
        root_window = tk.Tk()
        root_window.withdraw()
        root_window.attributes("-topmost", True)
        try:
            selected = filedialog.askdirectory(
                parent=root_window,
                title="GÖZ AT — Müşteri müzikleri için ana klasörü seç",
                initialdir=str(initial),
                mustexist=True,
            )
        finally:
            root_window.destroy()
        if not selected:
            raise ValueError("Müşteri müzik klasörü seçilmedi.")
        target = Path(selected).resolve()
        self._ensure_writable_folder(target, "Müşteri müzik")
        with self.lock:
            self.cfg["customer_root"] = str(target)
            save_config(self.cfg)
        return str(target)

    def _row_artist_title(self, row: dict[str, Any]) -> tuple[str, str]:
        artist = str(row.get("artist") or "").strip()
        title = str(row.get("track_title") or "").strip()
        if artist and title:
            return car_artist_title(title, fallback_artist=artist, fallback_title=title)
        return car_artist_title(
            str(row.get("query") or row.get("title") or ""),
            fallback_artist=artist,
            fallback_title=str(row.get("title") or title),
        )

    # ---------- download ----------
    def start_download(self, data: dict[str, Any]) -> None:
        customer = str(data.get("customer") or "").strip()
        if not customer:
            raise ValueError("Müşteri adı boş.")

        method = "native"
        bitrate = int(data.get("bitrate") or self.cfg.get("direct_bitrate_kbps", 320))
        eq_preset = str(data.get("eq_preset") or self.cfg.get("eq_preset") or "Araba Dengeli")
        if bitrate not in (128, 320):
            raise ValueError("128 veya 320 kbps seç.")
        if eq_preset not in get_eq_presets():
            raise ValueError("Geçersiz EQ seçimi.")

        with self.lock:
            if self.download_running:
                raise RuntimeError("İndirme zaten çalışıyor.")
            if not self.rows:
                raise ValueError("Önce listeye şarkı ekle.")
            self.download_running = True
            self.stop_event.clear()
            self.move_stop_event.set()
            self.moved_count = 0
            self.download_summary = ""
            self.cfg["download_method"] = "native"
            self.cfg["direct_bitrate_kbps"] = bitrate
            self.cfg["eq_preset"] = eq_preset
            if "customer_root" in data:
                self.cfg["customer_root"] = str(data.get("customer_root") or "").strip()
            save_config(self.cfg)
            self.status = "İndirme hazırlanıyor..."

        target_folder = self.customer_folder(customer, create=True)

        ok, text = direct_engine_status()
        if not ok:
            with self.lock:
                self.download_running = False
            raise RuntimeError(text)

        def work():
            try:
                self._resolve_missing_rows()
                if self.stop_event.is_set():
                    self.set_status("İndirme hazırlığı durduruldu")
                    return
                with self.lock:
                    ready = [dict(row) for row in self.rows if row.get("url")]
                if not ready:
                    raise RuntimeError("İndirilecek YouTube bağlantısı bulunamadı.")

                filtered = []
                skipped = 0
                for row in ready:
                    artist, title = self._row_artist_title(row)
                    duplicate = find_duplicate_mp3(target_folder, artist, title)
                    if duplicate is not None:
                        skipped += 1
                        self._update_row_by_url(str(row.get("url") or ""), status=f"ZATEN VAR — {duplicate.name}")
                    else:
                        filtered.append(row)
                ready = filtered
                if skipped:
                    self.set_status(f"{skipped} şarkı klasörde zaten var — tekrar indirilmeyecek")
                if not ready:
                    with self.lock:
                        self.download_summary = f"{skipped} şarkı zaten vardı, yeni indirme yok"
                    return

                self._download_direct_rows(ready, target_folder, bitrate, eq_preset)
            except Exception as exc:
                self.set_status("İndirme hatası: " + str(exc)[:220])
                with self.lock:
                    self.download_summary = str(exc)
            finally:
                with self.lock:
                    self.download_running = False

        self.download_thread = threading.Thread(target=work, daemon=True, name="mp3-web-download")
        self.download_thread.start()

    def _update_row_by_url(self, url: str, **values: Any) -> None:
        url = normalize_youtube_url(url)
        with self.lock:
            for row in self.rows:
                if normalize_youtube_url(str(row.get("url") or "")) == url:
                    row.update(values)
                    break

    def _download_direct_rows(self, rows: list[dict[str, Any]], target_folder: Path, bitrate: int, eq_preset: str) -> None:
        success = 0
        failed = 0
        total = len(rows)

        # Her şarkı tam olarak bittikten (indirme + EQ + dosya doğrulama)
        # sonra sıradakine geçilir. Aynı anda iki şarkı/proses çalışmaz.
        for queue_index, row in enumerate(rows, start=1):
            if self.stop_event.is_set():
                break
            url = normalize_youtube_url(str(row.get("url") or ""))
            artist, track_title = self._row_artist_title(row)
            song_name = f"{artist} - {track_title}" if artist and track_title else str(row.get("query") or row.get("title") or "muzik")
            queue_label = f"Sıra {queue_index}/{total}"
            self._update_row_by_url(url, status=f"{queue_label} — İndiriliyor | {bitrate} kbps | EQ {eq_preset}")

            def progress(percent, stage, current_url=url):
                text = f"Doğrudan: {stage}" if percent is None else f"Doğrudan: {stage} %{percent}"
                self._update_row_by_url(current_url, status=text)
                self.set_status(f"{queue_label} — {song_name}: {text}")

            try:
                output = download_mp3(
                    url=url,
                    target_folder=target_folder,
                    filename_hint=song_name,
                    bitrate_kbps=bitrate,
                    eq_preset=eq_preset,
                    progress_cb=progress,
                )
                success += 1
                with self.lock:
                    self.moved_count = success
                self._update_row_by_url(url, status=f"MP3 hazır ✓ {bitrate} kbps ✓ EQ {eq_preset} ✓ Ses dengeli")
                self.set_status(f"MP3 hazır: {output.name}")
            except FileExistsError as exc:
                self._update_row_by_url(url, status="ZATEN VAR — tekrar indirilmedi")
                self.set_status(str(exc))
            except Exception as exc:
                failed += 1
                self._update_row_by_url(url, status="İNDİRME HATASI — " + str(exc))
                self.set_status("Doğrudan indirme hatası: " + str(exc)[:180])

        with self.lock:
            self.download_summary = f"{success} başarılı, {failed} hata"
        if self.stop_event.is_set():
            self.set_status(f"Durduruldu — {success} MP3 hazır")
        else:
            self.set_status(f"Doğrudan indirme tamamlandı — {success} başarılı, {failed} hata")

    def stop_all(self) -> None:
        self.stop_event.set()
        self.move_stop_event.set()
        try:
            self.eq_preview.stop()
        except Exception:
            pass
        try:
            self.player.stop()
            with self.lock:
                self.player_message = "■ Durduruldu"
        except Exception:
            pass
        self.set_status("Durduruldu")

    # ---------- player ----------
    def choose_winamp_folder(self) -> dict[str, Any]:
        if os.name != "nt":
            raise RuntimeError("Klasör seçimi yalnız Windows'ta kullanılabilir.")
        # pythonw altında açılan yerel Windows klasör iletişim kutusu: terminal
        # veya PowerShell penceresi görünmez.
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        current = self.winamp_folder or Path(str(self.cfg.get("winamp_folder") or Path.home() / "Music"))
        initial = current if current.is_dir() else Path.home()
        try:
            selected = filedialog.askdirectory(
                parent=root,
                title="Winamp Modu: müzik klasörü seç",
                initialdir=str(initial),
                mustexist=True,
            )
        finally:
            root.destroy()
        if not selected:
            raise ValueError("Klasör seçilmedi.")
        selected_path = str(Path(selected).resolve())
        with self.lock:
            saved = [str(item) for item in (self.cfg.get("winamp_saved_locations") or []) if str(item).strip()]
            saved = [item for item in saved if item.casefold() != selected_path.casefold()]
            saved.append(selected_path)
            self.cfg["winamp_saved_locations"] = saved[-12:]
            save_config(self.cfg)
        return self.browse_winamp_folder(selected_path)

    def browse_winamp_folder(self, requested: str | None = None) -> dict[str, Any]:
        if requested:
            folder = Path(str(requested)).expanduser()
        elif self.winamp_folder:
            folder = self.winamp_folder
        else:
            folder = Path(str(self.cfg.get("winamp_folder") or Path.home() / "Music")).expanduser()
        if not folder.is_dir():
            fallback = Path.home() / "Music"
            folder = fallback if fallback.is_dir() else Path.home()
        folder = folder.resolve()
        if not folder.is_dir():
            raise ValueError("Seçilen klasör bulunamadı.")
        try:
            entries = list(folder.iterdir())
        except PermissionError as exc:
            raise RuntimeError("Bu klasörü görüntüleme izni yok.") from exc
        hidden_system_folders = {"$recycle.bin", "recycler", "recycled", "system volume information"}
        # Kapak/resim klasörleri Winamp gezgininin parçası değildir.  Bunlar
        # hiçbir seviyede klasör listesine düşmez; listede yalnız müzik ve
        # gerçek albüm/arsiv klasörleri kalır.
        artwork_folders = {"cover", "covers", "artwork", "album art", "albumart", "folder art", "scans"}
        def visible_music_folder(path: Path) -> bool:
            if (
                not path.is_dir()
                or path.name.casefold().strip() in hidden_system_folders
                or path.name.casefold().strip() in artwork_folders
            ):
                return False
            try:
                attributes = int(getattr(path.stat(), "st_file_attributes", 0) or 0)
                # Windows FILE_ATTRIBUTE_HIDDEN (0x2) / SYSTEM (0x4): these are
                # never useful as a music-library navigation destination.
                return not bool(attributes & 0x6)
            except OSError:
                return False
        paths = sorted(
            [path for path in entries if path.is_file() and path.suffix.lower() in self._supported_audio_suffixes()],
            key=lambda path: path.name.casefold(),
        )
        # Album artwork often lives in a sibling Cover/Artwork folder.  It is
        # not a music navigation target; when this directory already contains
        # playable audio, keep the Winamp view focused on those tracks.
        folders = sorted(
            [
                path
                for path in entries
                if visible_music_folder(path)
            ],
            key=lambda path: path.name.casefold(),
        )
        tracks: list[dict[str, Any]] = []
        token_paths: dict[str, Path] = {}
        for path in paths:
            resolved = path.resolve()
            token = hashlib.sha256(str(resolved).casefold().encode("utf-8")).hexdigest()[:24]
            token_paths[token] = resolved
            tracks.append({
                # Görünüm için metadata kullanılır; gerçek dosya adı/token
                # korunur, dolayısıyla eski arşiv dosyalarına dokunulmaz.
                "name": _library_track_label(path),
                "source_name": path.name,
                "duration_seconds": duration_seconds_for_path(path),
                "size_mb": round(path.stat().st_size / 1024 / 1024, 1),
                "token": token,
                "format": path.suffix.lower().lstrip(".").upper(),
            })
        with self.lock:
            self.winamp_folder, self.winamp_paths = folder, paths
            self.winamp_stream_paths.update(token_paths)
            self.cfg["winamp_folder"] = str(folder)
            save_config(self.cfg)
        parent = folder.parent
        return {
            "folder": str(folder),
            "parent": "" if parent == folder else str(parent),
            "folders": [{"name": path.name, "path": str(path)} for path in folders],
            "tracks": tracks,
            "saved_locations": list(self.cfg.get("winamp_saved_locations") or []),
        }

    def winamp_path(self, index: int, token: str = "") -> Path:
        with self.lock:
            paths = list(self.winamp_paths)
            token_path = self.winamp_stream_paths.get(str(token or ""))
        if token_path and token_path.is_file():
            return token_path
        if not paths:
            raise FileNotFoundError("Önce Winamp klasörü seç.")
        return paths[max(0, min(int(index), len(paths) - 1))]

    def search_winamp_library(self, query: str, root_value: str = "") -> dict[str, Any]:
        """Fast local Artist/Title search in the selected saved library root."""
        needle = _catalog_key(str(query or ""))
        if len(needle) < 2:
            raise ValueError("Arama için en az 2 harf yaz.")
        root = Path(str(root_value or self.winamp_folder or self.cfg.get("winamp_folder") or Path.home() / "Music")).expanduser()
        if not root.is_dir():
            raise ValueError("Müzik arşivi bulunamadı.")
        root = root.resolve()
        root_key = str(root).casefold()
        cache_key = f"{root_key}|{needle}"
        with self.lock:
            matches = self.winamp_search_cache.get(cache_key)
        if matches is None:
            excluded = {"$recycle.bin", "recycler", "recycled", "system volume information", "cover", "covers", "artwork", "album art", "albumart", "folder art", "scans"}
            with self.lock:
                catalog = self.winamp_library_index.get(root_key)
            if catalog is None:
                catalog = []
                try:
                    for directory, folders, files in os.walk(root):
                        folders[:] = [name for name in folders if name.casefold().strip() not in excluded]
                        for filename in files:
                            path = Path(directory) / filename
                            if path.suffix.lower() in self._supported_audio_suffixes():
                                catalog.append(path.resolve())
                except (OSError, PermissionError) as exc:
                    raise RuntimeError("Müzik arşivi taranamadı.") from exc
                with self.lock:
                    self.winamp_library_index[root_key] = catalog
            matched_paths = [path for path in catalog if needle in _catalog_key(f"{path.parent.name} {path.name}")][:250]
            matches = [(path, _library_track_label(path), duration_seconds_for_path(path)) for path in matched_paths]
            with self.lock:
                self.winamp_search_cache[cache_key] = matches
        token_paths: dict[str, Path] = {}
        tracks: list[dict[str, Any]] = []
        for path, label, seconds in matches:
            token = hashlib.sha256(str(path).casefold().encode("utf-8")).hexdigest()[:24]
            token_paths[token] = path
            tracks.append({"name": label, "source_name": path.name, "duration_seconds": seconds, "size_mb": round(path.stat().st_size / 1024 / 1024, 1), "token": token, "format": path.suffix.lstrip(".").upper()})
        with self.lock:
            self.winamp_paths = [path for path, _, _ in matches]
            self.winamp_stream_paths.update(token_paths)
        return {"folder": str(root), "parent": "", "folders": [], "tracks": tracks, "saved_locations": list(self.cfg.get("winamp_saved_locations") or []), "search": needle, "search_total": len(matches)}

    def rebuild_winamp_library_index(self, root_value: str = "") -> tuple[str, int]:
        root = Path(str(root_value or self.winamp_folder or self.cfg.get("winamp_folder") or Path.home() / "Music")).expanduser()
        if not root.is_dir():
            raise ValueError("Müzik arşivi bulunamadı.")
        root = root.resolve()
        excluded = {"$recycle.bin", "recycler", "recycled", "system volume information", "cover", "covers", "artwork", "album art", "albumart", "folder art", "scans"}
        catalog: list[Path] = []
        try:
            for directory, folders, files in os.walk(root):
                folders[:] = [name for name in folders if name.casefold().strip() not in excluded]
                catalog.extend((Path(directory) / name).resolve() for name in files if (Path(directory) / name).suffix.lower() in self._supported_audio_suffixes())
        except (OSError, PermissionError) as exc:
            raise RuntimeError("Müzik arşivi taranamadı.") from exc
        root_key = str(root).casefold()
        with self.lock:
            self.winamp_library_index[root_key] = catalog
            self.winamp_search_cache = {key: value for key, value in self.winamp_search_cache.items() if not key.startswith(root_key + "|")}
        return str(root), len(catalog)

    @staticmethod
    def _supported_audio_suffixes() -> set[str]:
        return {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".wma"}

    @staticmethod
    def _favorite_playlist_file() -> Path:
        return DATA_DIR / "winamp_favorilerim.json"

    def _save_favorite_paths(self, paths: list[Path]) -> None:
        playlist_file = self._favorite_playlist_file()
        playlist_file.parent.mkdir(parents=True, exist_ok=True)
        unique: dict[str, Path] = {}
        for path in paths:
            if path.is_file():
                unique[str(path.resolve()).casefold()] = path.resolve()
        playlist_file.write_text(
            json.dumps([str(path) for path in unique.values()], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _copy_to_favorites(self, source: Path, target_root: Path | None = None) -> Path:
        source = source.resolve()
        if not source.is_file() or source.suffix.lower() not in self._supported_audio_suffixes():
            raise FileNotFoundError("Favoriye eklenecek ses dosyası bulunamadı.")
        root = (target_root or self.favorites_root(create=True)).resolve()
        root.mkdir(parents=True, exist_ok=True)
        self._ensure_writable_folder(root, "Favori Listem")
        destination = root / source.name
        if destination.exists():
            return destination
        fd, temp_name = tempfile.mkstemp(prefix=f".{destination.stem}-", suffix=".copying", dir=str(root))
        os.close(fd)
        temp = Path(temp_name)
        try:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    shutil.copy2(source, temp)
                    os.replace(temp, destination)
                    return destination
                except PermissionError as exc:
                    last_error = exc
                    if attempt < 2:
                        time.sleep(0.15 * (attempt + 1))
            raise RuntimeError(
                "Favori klasörüne yazılamadı. Klasörün yazma iznini kontrol edin veya GÖZ AT ile başka klasör seçin."
            ) from last_error
        finally:
            try:
                if temp.exists():
                    temp.unlink()
            except Exception:
                pass

    @staticmethod
    def _ensure_writable_folder(folder: Path, label: str) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        try:
            fd, probe_name = tempfile.mkstemp(prefix=".kafepin-write-test-", suffix=".tmp", dir=str(folder))
            os.close(fd)
            Path(probe_name).unlink()
        except PermissionError as exc:
            raise RuntimeError(
                f"{label} klasörüne yazma izni yok: {folder}. GÖZ AT ile yazılabilir bir klasör seçin."
            ) from exc

    def _load_favorite_paths(self) -> list[Path]:
        playlist_file = self._favorite_playlist_file()
        try:
            saved = [Path(str(x)) for x in json.loads(playlist_file.read_text(encoding="utf-8"))]
        except Exception:
            saved = []
        root = self.favorites_root(create=True).resolve()
        migrated: list[Path] = []
        for source in saved:
            try:
                if not source.is_file():
                    continue
                path = source.resolve()
                if path.parent != root:
                    path = self._copy_to_favorites(path, root)
                migrated.append(path)
            except Exception:
                continue
        for path in root.iterdir():
            if path.is_file() and path.suffix.lower() in self._supported_audio_suffixes():
                migrated.append(path.resolve())
        unique = sorted(
            {str(path).casefold(): path for path in migrated if path.is_file()}.values(),
            key=lambda path: path.name.casefold(),
        )
        self._save_favorite_paths(unique)
        return unique

    def choose_favorites_folder(self) -> str:
        if os.name != "nt":
            raise RuntimeError("Klasör seçimi yalnız Windows'ta kullanılabilir.")
        import tkinter as tk
        from tkinter import filedialog
        current = self._load_favorite_paths()
        root_window = tk.Tk()
        root_window.withdraw()
        root_window.attributes("-topmost", True)
        selected = filedialog.askdirectory(
            parent=root_window,
            title="GÖZ AT — Favori Listem için kayıt klasörünü seç",
            initialdir=str(self.favorites_root(create=True)),
            mustexist=True,
        )
        root_window.destroy()
        if not selected:
            raise ValueError("Favori klasörü seçilmedi.")
        target = Path(selected).resolve()
        target.mkdir(parents=True, exist_ok=True)
        self._ensure_writable_folder(target, "Favori Listem")
        copied = [self._copy_to_favorites(path, target) for path in current if path.is_file()]
        with self.lock:
            self.cfg["favorites_root"] = str(target)
            save_config(self.cfg)
        self._save_favorite_paths(copied)
        return str(target)

    def add_winamp_favorites(self, indexes: list[int]) -> int:
        with self.lock:
            chosen = [self.winamp_paths[i] for i in indexes if 0 <= i < len(self.winamp_paths)]
        if not chosen:
            raise ValueError("Favoriye eklenecek şarkı seç.")
        saved = self._load_favorite_paths()
        existing = {str(path.resolve()).casefold() for path in saved}
        added = 0
        for source in chosen:
            destination = self._copy_to_favorites(source)
            key = str(destination.resolve()).casefold()
            if key not in existing:
                saved.append(destination)
                existing.add(key)
                added += 1
        self._save_favorite_paths(saved)
        return added

    def add_customer_favorite(self, customer: str, index: int) -> int:
        source = self.track_path(customer, index)
        saved = self._load_favorite_paths()
        keys = {str(path.resolve()).casefold() for path in saved}
        destination = self.favorites_root(create=True).resolve() / source.name
        added = 0 if str(destination.resolve()).casefold() in keys else 1
        destination = self._copy_to_favorites(source)
        saved.append(destination)
        self._save_favorite_paths(saved)
        return added

    def toggle_customer_favorite(self, customer: str, index: int) -> bool:
        source = self.track_path(customer, index)
        return self._toggle_favorite_source(source)

    def _toggle_favorite_source(self, source: Path) -> bool:
        saved = self._load_favorite_paths()
        matching = [path for path in saved if path.name.casefold() == source.name.casefold()]
        if matching:
            for path in matching:
                try:
                    path.unlink()
                except PermissionError as exc:
                    raise RuntimeError("Favori şarkı kullanımda. Önce DURDUR'a bas.") from exc
            self._save_favorite_paths([path for path in saved if path not in matching])
            return False
        destination = self._copy_to_favorites(source)
        saved.append(destination)
        self._save_favorite_paths(saved)
        return True

    def toggle_winamp_favorite(self, index: int) -> bool:
        return self._toggle_favorite_source(self.winamp_path(index))

    def winamp_favorite_indexes(self) -> list[int]:
        favorite_names = {path.name.casefold() for path in self._load_favorite_paths()}
        with self.lock:
            paths = list(self.winamp_paths)
        return [i for i, path in enumerate(paths) if path.name.casefold() in favorite_names]

    def customer_favorite_indexes(self, customer: str) -> list[int]:
        favorite_names = {path.name.casefold() for path in self._load_favorite_paths()}
        folder = self.customer_folder(customer, create=False)
        paths = [] if not folder.exists() else sorted(
            [p for p in folder.glob("*.mp3") if p.is_file()],
            key=lambda p: p.name.casefold(),
        )
        return [i for i, path in enumerate(paths) if path.name.casefold() in favorite_names]

    def list_winamp_favorites(self) -> list[dict[str, Any]]:
        paths = self._load_favorite_paths()
        with self.lock:
            self.favorite_paths = paths
        return [{"name": p.name, "size_mb": round(p.stat().st_size / 1024 / 1024, 1)} for p in paths]

    def favorite_path(self, index: int) -> Path:
        paths = self._load_favorite_paths()
        with self.lock:
            self.favorite_paths = paths
        index = int(index)
        if index < 0 or index >= len(paths):
            raise IndexError("Favori şarkı sırası geçersiz.")
        return paths[index]

    def remove_favorite(self, index: int) -> str:
        path = self.favorite_path(index)
        name = path.name
        try:
            path.unlink()
        except PermissionError as exc:
            raise RuntimeError("Favori şarkı kullanımda. Önce DURDUR'a bas.") from exc
        remaining = [item for item in self._load_favorite_paths() if item.name.casefold() != name.casefold()]
        self._save_favorite_paths(remaining)
        with self.lock:
            self.favorite_paths = remaining
        return name
    def _refresh_player_paths(self, customer: str) -> list[Path]:
        folder = self.customer_folder(customer, create=False)
        paths = [] if not folder.exists() else sorted([p for p in folder.glob("*.mp3") if p.is_file()], key=lambda p: p.name.casefold())
        with self.lock:
            self.player_customer = customer
            self.player_paths = paths
        return paths

    def player_play(self, customer: str, index: int) -> None:
        paths = self._refresh_player_paths(customer)
        if not paths:
            raise ValueError("Bu müşteri klasöründe MP3 yok.")
        index = max(0, min(int(index), len(paths) - 1))
        volume = max(0, min(100, _int_value(self.cfg.get("player_volume"), 85)))
        try:
            self.eq_preview.stop()
        except Exception:
            pass
        self.player.play(paths[index], volume=volume, start_seconds=0.0)
        with self.lock:
            self.player_index = index
            self.player_message = f"▶ {paths[index].name}"

    def player_next(self, auto: bool = False, customer_hint: str = "", index_hint: int | None = None) -> None:
        with self.lock:
            customer_hint = str(customer_hint or "").strip()
            customer = customer_hint or self.player_customer
            index = index_hint if customer_hint and index_hint is not None else self.player_index
            if index is None:
                index = index_hint
        paths = self._refresh_player_paths(customer) if customer else []
        if not paths:
            return
        next_index = 0 if index is None else index + 1
        if next_index >= len(paths):
            if auto:
                self.player.stop()
                with self.lock:
                    self.player_message = "■ Çalma listesi bitti."
                    self.player_index = None
                return
            next_index = len(paths) - 1
        self.player_play(customer, next_index)

    def player_previous(self, customer_hint: str = "", index_hint: int | None = None) -> None:
        with self.lock:
            customer_hint = str(customer_hint or "").strip()
            customer = customer_hint or self.player_customer
            index = index_hint if customer_hint and index_hint is not None else self.player_index
            if index is None:
                index = index_hint
        paths = self._refresh_player_paths(customer) if customer else []
        if not paths:
            return
        prev_index = 0 if index is None else max(0, index - 1)
        self.player_play(customer, prev_index)

    def player_stop(self) -> None:
        # Dinleme modundaki DURDUR kullanici icin mutlak sessizliktir:
        # hem MP3 player hem olasi EQ preview kesin durur.
        try:
            self.eq_preview.stop()
        except Exception:
            pass
        self.player.stop()
        with self.lock:
            self.player_message = "■ Durduruldu"
            self.preview_message = "■ Önizleme durduruldu"

    def player_seek(self, seconds: float, absolute: bool = False) -> None:
        if absolute:
            self.player.seek_to(float(seconds))
        else:
            self.player.seek(float(seconds))

    def player_volume(self, volume: int) -> None:
        """Dinleme sesini çalışan ffplay prosesine uygular; 0 mute korunur."""
        volume = max(0, min(100, int(volume)))
        self.player.set_volume(volume)
        with self.lock:
            self.cfg["player_volume"] = volume
            save_config(self.cfg)

    def shared_volume(self, volume: int) -> None:
        """İndirme önizlemesi ve Dinleme Modu için ortak canlı ses ayarı."""
        volume = max(0, min(100, int(volume)))

        if self.player.current is not None and self.player.is_playing():
            self.player.set_volume(volume)

        if self.eq_preview.has_source() and self.eq_preview.is_active():
            self.eq_preview.switch_eq_live(
                self.eq_preview.current_eq,
                volume=volume,
            )

        with self.lock:
            self.cfg["player_volume"] = volume
            save_config(self.cfg)

    def player_state(self) -> dict[str, Any]:
        with self.lock:
            customer = self.player_customer
            index = self.player_index
            message = self.player_message
            volume = max(0, min(100, _int_value(self.cfg.get("player_volume"), 85)))
            paths = list(self.player_paths)
        current_name = ""
        if self.player.current is not None:
            try:
                current_name = Path(self.player.current).name
            except Exception:
                pass
        return {
            "playing": self.player.is_playing(),
            "current": current_name,
            "customer": customer,
            "index": index,
            "position": round(self.player.position(), 2),
            "duration": round(float(self.player.duration or 0.0), 2),
            "volume": volume,
            "message": message,
            "track_count": len(paths),
        }

    def _player_monitor_loop(self) -> None:
        while True:
            try:
                if self.player.is_finished():
                    self.player_next(auto=True)
            except Exception:
                pass
            time.sleep(0.4)

    # ---------- EQ preview ----------
    def preview_start_async(self, url: str, eq_preset: str, volume: int) -> None:
        url = normalize_youtube_url(url)
        if not url:
            raise ValueError("Önizleme için YouTube bağlantısı yok.")
        if eq_preset not in get_eq_presets():
            raise ValueError("Geçersiz EQ seçimi.")
        with self.lock:
            if self.preview_loading:
                raise RuntimeError("Önizleme kaynağı zaten hazırlanıyor.")
            self.preview_loading = True
            self.preview_message = "Önizleme kaynağı hazırlanıyor..."

        def status_cb(text: str):
            with self.lock:
                self.preview_message = text

        def work():
            try:
                self.player.stop()
                self.eq_preview.play(url, eq_preset=eq_preset, volume=volume, status_cb=status_cb)
                with self.lock:
                    self.preview_message = f"▶ EQ Önizleme: {eq_preset}"
                    self.cfg["eq_preset"] = eq_preset
                    save_config(self.cfg)
            except Exception as exc:
                with self.lock:
                    self.preview_message = "Önizleme hatası: " + str(exc)
            finally:
                with self.lock:
                    self.preview_loading = False

        threading.Thread(target=work, daemon=True, name="mp3-web-eq-preview").start()

    def preview_switch(self, eq_preset: str, volume: int | None = None) -> None:
        if eq_preset not in get_eq_presets():
            raise ValueError("Geçersiz EQ seçimi.")
        self.eq_preview.switch_eq_live(eq_preset, volume=volume)
        with self.lock:
            self.preview_message = f"▶ Canlı EQ: {eq_preset}"
            self.cfg["eq_preset"] = eq_preset
            save_config(self.cfg)

    def preview_stop(self) -> None:
        self.eq_preview.stop()
        with self.lock:
            self.preview_message = "■ EQ önizleme durduruldu"

    def preview_state(self) -> dict[str, Any]:
        with self.lock:
            loading = self.preview_loading
            message = self.preview_message
        return {
            "loading": loading,
            "active": self.eq_preview.is_active(),
            "has_source": self.eq_preview.has_source(),
            "eq": self.eq_preview.current_eq,
            "position": round(self.eq_preview.position(), 2),
            "duration": round(float(self.eq_preview.duration or 0.0), 2),
            "message": message,
        }

    # ---------- phone / ChatGPT ----------
    def _phone_photo_received(self, path: str) -> None:
        with self.lock:
            self.last_phone_photo = path
            self.phone_message = "Fotoğraf PC'ye geldi"
        try:
            if copy_image_and_text is not None:
                copy_image_and_text(path, CHATGPT_LIST_PROMPT)
                with self.lock:
                    self.phone_message = "Fotoğraf + talimat panoya hazır — ChatGPT'de Ctrl+V"
            elif copy_image is not None:
                copy_image(path)
        except Exception:
            pass
        try:
            webbrowser.open("https://chatgpt.com/")
        except Exception:
            pass

    def phone_start(self) -> dict[str, Any]:
        with self.lock:
            if self.phone_server is None:
                self.phone_server = PhoneUploadServer(self._phone_photo_received)
                self.phone_server.start()
            server = self.phone_server
            self.phone_message = "Telefon QR hazır — fotoğraf bekleniyor"
        qr = server.qr_image()
        buf = io.BytesIO()
        qr.save(buf, format="PNG")
        data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        return {"url": server.url, "qr": data_uri}

    def phone_state(self) -> dict[str, Any]:
        with self.lock:
            return {
                "message": self.phone_message,
                "photo": bool(self.last_phone_photo and Path(self.last_phone_photo).exists()),
            }

    def copy_phone_photo(self) -> None:
        with self.lock:
            path = self.last_phone_photo
        if not path or not Path(path).exists():
            raise ValueError("Henüz telefondan alınmış fotoğraf yok.")
        if copy_image is None:
            raise RuntimeError("Windows resim panosu bileşeni yüklenemedi.")
        copy_image(path)
        with self.lock:
            self.phone_message = "Telefon fotoğrafı panoya kopyalandı — ChatGPT'de Ctrl+V"

    def copy_prompt(self) -> None:
        pyperclip.copy(CHATGPT_LIST_PROMPT)

    def load_chatgpt_clipboard(self) -> dict[str, Any]:
        text = pyperclip.paste()
        if not text or not text.strip():
            raise ValueError("Panoda metin yok.")
        songs = _clean_chatgpt_text(text)
        if not songs:
            raise ValueError("Panoda 'SANATÇI - ŞARKI' biçiminde liste bulunamadı.")
        result = self.set_text_list("\n".join(songs))
        self.set_status(f"ChatGPT listesinden {len(songs)} şarkı yüklendi")
        return result

    # ---------- summary ----------
    def state(self) -> dict[str, Any]:
        with self.lock:
            return {
                "version": APP_VERSION,
                "baseline": FUNCTIONAL_BASELINE,
                "status": self.status,
                "download_running": self.download_running,
                "download_summary": self.download_summary,
                "moved_count": self.moved_count,
                "rows": self.rows_public(),
                "config": self.public_config(),
            }


core = Mp3WebCore()
usb_sales = UsbSalesManager(DATA_DIR, APP_DIR)
usb_film_sales = UsbFilmSalesManager(DATA_DIR, APP_DIR)
usb_game_sales = UsbGameSalesManager(DATA_DIR, APP_DIR)
app = Flask(__name__, static_folder=None)


def _local_audio_response(path: Path):
    """Serve browser-native formats directly; transcode WMA as a live MP3 stream."""
    if path.suffix.lower() != ".wma":
        mime = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".wav": "audio/wav",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
            ".ogg": "audio/ogg",
        }.get(path.suffix.lower(), "application/octet-stream")
        return send_file(path, mimetype=mime, conditional=True, etag=True, max_age=0)

    marker = Path(__file__).resolve().parent / "ffmpeg_path.txt"
    configured = marker.read_text(encoding="utf-8-sig").strip() if marker.is_file() else ""
    ffmpeg = configured if configured and Path(configured).is_file() else shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("WMA oynatmak için FFmpeg bulunamadı.")
    process = subprocess.Popen(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-f", "mp3", "-b:a", "192k", "pipe:1"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    def generate():
        try:
            while True:
                chunk = process.stdout.read(64 * 1024) if process.stdout else b""
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                if process.stdout:
                    process.stdout.close()
            except Exception:
                pass
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        content_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-KafePin-Audio": "wma-live-transcode"},
    )


@app.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-KafePin-MP3-Isolation"] = "separate-loopback-service"
    return response


@app.get("/")
def home():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/web/<path:name>")
def web_asset(name: str):
    return send_from_directory(WEB_DIR, name)


@app.get("/api/health")
def health():
    ok, engine_text = direct_engine_status()
    return jsonify({
        "ok": True,
        "service": "KafePin MP3 Bot PRO",
        "version": APP_VERSION,
        "functionalBaseline": FUNCTIONAL_BASELINE,
        "host": HOST,
        "port": PORT,
        "directEngine": {"ok": ok, "text": engine_text},
        "isolation": "KafePin core/DB/session/finance/EveryCafe access yok",
    })


@app.get("/api/state")
def state():
    return jsonify({"ok": True, **core.state(), "player": core.player_state(), "preview": core.preview_state(), "phone": core.phone_state()})


@app.post("/api/config")
def config_update():
    try:
        cfg = core.update_config(request.get_json(silent=True) or {})
        return jsonify({"ok": True, "config": cfg})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/customers")
def customers():
    try:
        return jsonify({"ok": True, "customers": core.list_customers()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb/state")
def usb_state_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or core.customer_root()))
        return jsonify({
            "ok": True,
            "drives": usb_sales.drives(),
            "customers": core.list_customers(),
            "config": core.public_config(),
            "transaction": usb_sales.transaction(),
            "sources": usb_sales.sources(),
            "browser": usb_sales.browse_sources("", fallback),
        })
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb/browser")
def usb_browser_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or core.customer_root()))
        return jsonify({"ok": True, **usb_sales.browse_sources(request.args.get("path", ""), fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb/browser/choose")
def usb_browser_choose_api():
    try:
        requested = str(request.args.get("path", "") or "")
        selected = _choose_usb_archive_folder("USB MP3 At: müzik klasörü seç", requested)
        fallback = Path(str(core.public_config().get("winamp_folder") or core.customer_root()))
        return jsonify({"ok": True, **usb_sales.browse_sources(selected or requested, fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/sources/add")
def usb_sources_add_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_sales.add_sources(list(data.get("paths") or []))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/sources/remove")
def usb_sources_remove_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_sales.remove_source(str(data.get("id") or ""))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/sources/clear")
def usb_sources_clear_api():
    try:
        return jsonify({"ok": True, "sources": usb_sales.clear_sources()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/preview")
def usb_preview_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "plan": usb_sales.preview(core.customer_root(), data)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/transfer")
def usb_transfer_api():
    try:
        data = request.get_json(silent=True) or {}
        core.update_config({
            "usb_unit_price": data.get("unit_price", 0),
            "usb_folder_name": data.get("folder_name", "Muzikler"),
            "usb_layout": data.get("layout", "customer"),
            "usb_payment_method": data.get("payment_method", "CASH"),
            "usb_bitrate_kbps": data.get("bitrate_kbps", 192),
            "usb_shuffle": bool(data.get("shuffle", False)),
        })
        result = usb_sales.transfer(core.customer_root(), data)
        core.set_status(f"USB aktarımı: {result['copied']} başarılı • {result['duplicate_count']} tekrar atlandı")
        return jsonify({"ok": True, "result": result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/confirm-sale")
def usb_confirm_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_sales.confirm_sale(str(data.get("transaction_id") or ""))
        core.set_status(f"MP3 USB satışı KafePin'e işlendi • #{transaction['sale_id']}")
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/cancel-sale")
def usb_cancel_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_sales.cancel_sale(str(data.get("transaction_id") or ""), bool(data.get("remove_files", False)))
        core.set_status("USB aktarımı satışa eklenmeden kapatıldı" + (f" • {transaction.get('removed_files', 0)} dosya silindi" if data.get("remove_files") else ""))
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb/format")
def usb_format_api():
    try:
        data = request.get_json(silent=True) or {}
        result = usb_sales.format_drive(
            str(data.get("drive") or ""),
            str(data.get("filesystem") or "FAT32"),
            str(data.get("label") or "KAFEPIN"),
            str(data.get("confirmation") or ""),
        )
        core.set_status(f"USB biçimlendirildi: {result['drive']} • {result['filesystem']}")
        return jsonify({"ok": True, "result": result, "drives": usb_sales.drives()})
    except Exception as exc:
        return _json_error(str(exc))


def _choose_usb_archive_folder(title: str, requested: str) -> str:
    if os.name != "nt":
        raise RuntimeError("Klasör seçimi yalnız Windows'ta kullanılabilir.")
    import tkinter as tk
    from tkinter import filedialog

    initial = Path(str(requested or "")).expanduser() if str(requested or "").strip() else Path.home()
    try:
        if not initial.is_dir():
            initial = Path.home()
    except OSError:
        initial = Path.home()
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return str(filedialog.askdirectory(parent=root, title=title, initialdir=str(initial), mustexist=True) or "")
    finally:
        root.destroy()


@app.get("/api/usb-film/state")
def usb_film_state_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, "drives": usb_film_sales.drives(), "config": core.public_config(),
                        "transaction": usb_film_sales.transaction(), "sources": usb_film_sales.sources(),
                        "browser": usb_film_sales.browse_sources("", fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-film/browser")
def usb_film_browser_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, **usb_film_sales.browse_sources(request.args.get("path", ""), fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-film/search")
def usb_film_search_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, **usb_film_sales.search_browser(request.args.get("root", ""), fallback, request.args.get("query", ""), VIDEO_EXTENSIONS)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/search/refresh")
def usb_film_search_refresh_api():
    try:
        data = request.get_json(silent=True) or {}
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, "folder": usb_film_sales.refresh_browser_search(str(data.get("root") or ""), fallback, VIDEO_EXTENSIONS)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-film/browser/choose")
def usb_film_browser_choose_api():
    try:
        requested = str(request.args.get("path", "") or "")
        selected = _choose_usb_archive_folder("USB Film At: film klasörü seç", requested)
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, **usb_film_sales.browse_sources(selected or requested, fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/sources/add")
def usb_film_sources_add_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_film_sales.add_sources(list(data.get("paths") or []))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/sources/remove")
def usb_film_sources_remove_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_film_sales.remove_source(str(data.get("id") or ""))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/sources/clear")
def usb_film_sources_clear_api():
    try:
        return jsonify({"ok": True, "sources": usb_film_sales.clear_sources()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/preview")
def usb_film_preview_api():
    try:
        return jsonify({"ok": True, "plan": usb_film_sales.preview(request.get_json(silent=True) or {})})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/transfer")
def usb_film_transfer_api():
    try:
        data = request.get_json(silent=True) or {}
        core.update_config({"usb_film_unit_price": data.get("unit_price", 0), "usb_film_folder_name": data.get("folder_name", "Filmler"),
                            "usb_film_layout": data.get("layout", "folders"), "usb_film_payment_method": data.get("payment_method", "CASH"),
                            "usb_film_profile": data.get("profile", "original"), "usb_film_shuffle": bool(data.get("shuffle", False))})
        result = usb_film_sales.transfer(data)
        core.set_status(f"Film USB aktarımı: {result['copied']} başarılı • {result['duplicate_count']} tekrar atlandı")
        return jsonify({"ok": True, "result": result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/confirm-sale")
def usb_film_confirm_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_film_sales.confirm_sale(str(data.get("transaction_id") or ""))
        core.set_status(f"Film USB satışı KafePin'e işlendi • #{transaction['sale_id']}")
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/cancel-sale")
def usb_film_cancel_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_film_sales.cancel_sale(str(data.get("transaction_id") or ""), bool(data.get("remove_files", False)))
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-film/format")
def usb_film_format_api():
    try:
        data = request.get_json(silent=True) or {}
        result = usb_film_sales.format_drive(str(data.get("drive") or ""), str(data.get("filesystem") or "EXFAT"),
                                             str(data.get("label") or "KAFEPIN-FILM"), str(data.get("confirmation") or ""))
        return jsonify({"ok": True, "result": result, "drives": usb_film_sales.drives()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-game/state")
def usb_game_state_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, "drives": usb_game_sales.drives(), "config": core.public_config(),
                        "transaction": usb_game_sales.transaction(), "sources": usb_game_sales.sources(),
                        "browser": usb_game_sales.browse_sources("", fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-game/browser")
def usb_game_browser_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, **usb_game_sales.browse_sources(request.args.get("path", ""), fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-game/search")
def usb_game_search_api():
    try:
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, **usb_game_sales.search_browser(request.args.get("root", ""), fallback, request.args.get("query", ""), PACKAGE_EXTENSIONS)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/search/refresh")
def usb_game_search_refresh_api():
    try:
        data = request.get_json(silent=True) or {}
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        return jsonify({"ok": True, "folder": usb_game_sales.refresh_browser_search(str(data.get("root") or ""), fallback, PACKAGE_EXTENSIONS)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/usb-game/browser/choose")
def usb_game_browser_choose_api():
    try:
        requested = str(request.args.get("path", "") or "").strip()
        selected = _choose_usb_archive_folder("USB Oyun At: oyun klasörü seç", requested)
        fallback = Path(str(core.public_config().get("winamp_folder") or Path.home()))
        if not selected:
            return jsonify({"ok": True, **usb_game_sales.browse_sources(requested, fallback)})
        return jsonify({"ok": True, **usb_game_sales.browse_sources(str(selected), fallback)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/sources/add")
def usb_game_sources_add_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_game_sales.add_sources(list(data.get("paths") or []))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/sources/remove")
def usb_game_sources_remove_api():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "sources": usb_game_sales.remove_source(str(data.get("id") or ""))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/sources/clear")
def usb_game_sources_clear_api():
    try:
        return jsonify({"ok": True, "sources": usb_game_sales.clear_sources()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/preview")
def usb_game_preview_api():
    try:
        return jsonify({"ok": True, "plan": usb_game_sales.preview(request.get_json(silent=True) or {})})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/transfer")
def usb_game_transfer_api():
    try:
        data = request.get_json(silent=True) or {}
        core.update_config({"usb_game_unit_price": data.get("unit_price", 0), "usb_game_folder_name": data.get("folder_name", "Oyunlar"),
                            "usb_game_payment_method": data.get("payment_method", "CASH")})
        result = usb_game_sales.transfer(data)
        core.set_status(f"Oyun USB aktarımı: {result['copied']} başarılı • {result['duplicate_count']} tekrar atlandı")
        return jsonify({"ok": True, "result": result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/confirm-sale")
def usb_game_confirm_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_game_sales.confirm_sale(str(data.get("transaction_id") or ""))
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/cancel-sale")
def usb_game_cancel_sale_api():
    try:
        data = request.get_json(silent=True) or {}
        transaction = usb_game_sales.cancel_sale(str(data.get("transaction_id") or ""), bool(data.get("remove_files", False)))
        return jsonify({"ok": True, "transaction": transaction})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/usb-game/format")
def usb_game_format_api():
    try:
        data = request.get_json(silent=True) or {}
        result = usb_game_sales.format_drive(str(data.get("drive") or ""), str(data.get("filesystem") or "NTFS"),
                                             str(data.get("label") or "KAFEPIN-OYUN"), str(data.get("confirmation") or ""))
        return jsonify({"ok": True, "result": result, "drives": usb_game_sales.drives()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/tracks")
def tracks():
    try:
        customer = request.args.get("customer", "")
        return jsonify({"ok": True, "tracks": core.list_tracks(customer)})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/choose-folder")
def winamp_choose_folder():
    try:
        return jsonify({"ok": True, **core.choose_winamp_folder()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/winamp/current-folder")
def winamp_current_folder():
    try:
        return jsonify({"ok": True, **core.browse_winamp_folder()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/browse-folder")
def winamp_browse_folder():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, **core.browse_winamp_folder(str(data.get("path") or ""))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/search")
def winamp_search():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, **core.search_winamp_library(str(data.get("query") or ""), str(data.get("root") or ""))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/search/refresh")
def winamp_search_refresh():
    try:
        data = request.get_json(silent=True) or {}
        root = Path(str(data.get("root") or core.winamp_folder or core.cfg.get("winamp_folder") or Path.home() / "Music")).expanduser().resolve()
        folder, count = core.rebuild_winamp_library_index(str(root))
        return jsonify({"ok": True, "folder": folder, "count": count})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/library/sync-all")
def library_sync_all():
    try:
        cfg = core.public_config()
        result = {"mp3": 0, "usb_mp3": 0, "film": 0, "oyun": 0, "skipped": []}
        for root in cfg.get("winamp_saved_locations") or []:
            try:
                _folder, count = core.rebuild_winamp_library_index(str(root))
                result["mp3"] += count
            except Exception:
                result["skipped"].append(str(root))
        fallback = Path(str(cfg.get("winamp_folder") or Path.home()))
        groups = (("usb_mp3", usb_sales, cfg.get("usb_saved_locations") or [], AUDIO_EXTENSIONS), ("film", usb_film_sales, cfg.get("usb_film_saved_locations") or [], VIDEO_EXTENSIONS), ("oyun", usb_game_sales, cfg.get("usb_game_saved_locations") or [], PACKAGE_EXTENSIONS))
        for key, manager, roots, extensions in groups:
            for root in roots:
                try:
                    manager.refresh_browser_search(str(root), fallback, extensions)
                    manager.search_browser(str(root), fallback, "aa", extensions)
                    result[key] += 1
                except Exception:
                    result["skipped"].append(str(root))
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/favorites/choose-folder")
def favorites_choose_folder():
    try:
        folder = core.choose_favorites_folder()
        return jsonify({"ok": True, "folder": folder, "config": core.public_config()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/favorites/open-folder")
def favorites_open_folder():
    try:
        core.open_favorites_folder()
        return jsonify({"ok": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/winamp/stream")
def winamp_stream():
    try:
        path = core.winamp_path(int(request.args.get("index", "0")), request.args.get("token", ""))
        return _local_audio_response(path)
    except Exception as exc:
        return _json_error(str(exc), 404)


@app.post("/api/winamp/favorites/add")
def winamp_favorites_add():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "added": core.add_winamp_favorites([int(x) for x in data.get("indexes", [])])})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/favorites/toggle")
def winamp_favorites_toggle():
    try:
        data = request.get_json(silent=True) or {}
        favorite = core.toggle_winamp_favorite(int(data.get("index", -1)))
        return jsonify({"ok": True, "favorite": favorite})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/winamp/favorites/state")
def winamp_favorites_state():
    try:
        return jsonify({"ok": True, "indexes": core.winamp_favorite_indexes()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/favorites/add-customer")
def winamp_favorite_customer_add():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify({"ok": True, "added": core.add_customer_favorite(str(data.get("customer") or ""), int(data.get("index", -1)))})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/winamp/favorites/toggle-customer")
def winamp_favorite_customer_toggle():
    try:
        data = request.get_json(silent=True) or {}
        favorite = core.toggle_customer_favorite(str(data.get("customer") or ""), int(data.get("index", -1)))
        return jsonify({"ok": True, "favorite": favorite})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/winamp/favorites/customer-state")
def winamp_favorite_customer_state():
    try:
        customer = str(request.args.get("customer") or "")
        return jsonify({"ok": True, "indexes": core.customer_favorite_indexes(customer)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/winamp/favorites")
def winamp_favorites():
    try:
        return jsonify({"ok": True, "tracks": core.list_winamp_favorites()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/favorites/stream")
def favorites_stream():
    try:
        path = core.favorite_path(int(request.args.get("index", "0")))
        return _local_audio_response(path)
    except Exception as exc:
        return _json_error(str(exc), 404)


@app.post("/api/favorites/remove")
def favorites_remove():
    try:
        data = request.get_json(silent=True) or {}
        removed = core.remove_favorite(int(data.get("index", -1)))
        return jsonify({"ok": True, "removed": removed, "tracks": core.list_winamp_favorites()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/tracks/delete")
def track_delete():
    try:
        data = request.get_json(silent=True) or {}
        customer = str(data.get("customer") or "")
        index = int(data.get("index", -1))
        deleted = core.delete_track(customer, index)
        return jsonify({"ok": True, "deleted": deleted, "tracks": core.list_tracks(customer)})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/audio/stream")
def audio_stream():
    """Same-origin MP3 stream for the embedded WebView player.

    Flask/Werkzeug conditional responses preserve HTTP Range support, so
    the browser can seek without restarting ffplay or the MP3 service.
    """
    try:
        customer = request.args.get("customer", "")
        index = int(request.args.get("index", "0"))
        path = core.track_path(customer, index)
        response = send_file(
            path,
            mimetype="audio/mpeg",
            conditional=True,
            etag=True,
            last_modified=path.stat().st_mtime,
            max_age=0,
        )
        response.headers["Cache-Control"] = "no-store"
        response.headers["Accept-Ranges"] = "bytes"
        return response
    except Exception as exc:
        return _json_error(str(exc), 404)


@app.get("/api/youtube/instant-stream")
def youtube_instant_stream_api():
    """Proxy the selected YouTube audio stream without downloading an MP3 file.

    yt-dlp only resolves the signed audio URL. Bytes are relayed directly to the
    WebView audio element. Range is forwarded when Chromium requests it.
    """
    upstream = None
    try:
        source_url = normalize_youtube_url(request.args.get("url", ""))
        if not source_url:
            return _json_error("Geçerli YouTube bağlantısı yok.", 400)

        browser_range = str(request.headers.get("Range") or "").strip()
        # Do not race the background resolver for the same signed URL. The
        # previous 0.75 s wait frequently launched a second yt-dlp extraction,
        # producing avoidable YouTube 403/retry cycles before audio began.
        _wait_for_prewarm(source_url, timeout=12.0)
        resolved = _resolve_youtube_instant_stream(source_url)

        def open_upstream(item: dict[str, Any]):
            return http_requests.get(
                str(item.get("stream_url") or ""),
                headers=_upstream_headers(item, browser_range),
                stream=True,
                allow_redirects=True,
                timeout=(7, 30),
            )

        upstream = open_upstream(resolved)
        if upstream.status_code in (403, 410):
            upstream.close()
            with _YT_STREAM_CACHE_LOCK:
                _YT_STREAM_CACHE.pop(source_url, None)
            next_profile = int(resolved.get("profile_index") or 0) + 1
            resolved = _resolve_youtube_instant_stream(
                source_url,
                start_profile=next_profile,
                bypass_cache=True,
            )
            upstream = open_upstream(resolved)

        if upstream.status_code >= 400:
            status = upstream.status_code
            upstream.close()
            upstream = None
            raise RuntimeError(f"YouTube ses sunucusu HTTP {status} döndürdü.")

        out_headers = {
            "Cache-Control": "no-store",
            "Accept-Ranges": str(upstream.headers.get("Accept-Ranges") or "bytes"),
            "X-KafePin-YT-Stream": "direct-no-download",
        }
        for name in ("Content-Length", "Content-Range", "ETag", "Last-Modified"):
            value = upstream.headers.get(name)
            if value:
                out_headers[name] = value
        content_type = str(upstream.headers.get("Content-Type") or "audio/mp4")
        status_code = int(upstream.status_code)

        def generate():
            try:
                for chunk in upstream.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        yield chunk
            finally:
                upstream.close()

        return Response(
            stream_with_context(generate()),
            status=status_code,
            headers=out_headers,
            content_type=content_type,
            direct_passthrough=True,
        )
    except Exception as exc:
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass
        return _json_error(str(exc), 502)


@app.post("/api/customer/open-folder")
def open_folder():
    try:
        data = request.get_json(silent=True) or {}
        core.open_customer_folder(str(data.get("customer") or ""))
        return jsonify({"ok": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/customer/choose-root")
def choose_customer_root():
    try:
        folder = core.choose_customer_root()
        return jsonify({"ok": True, "folder": folder, "config": core.public_config()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/customer/delete-folder")
def delete_customer_folder():
    try:
        data = request.get_json(silent=True) or {}
        deleted = core.delete_customer_folder(str(data.get("customer") or ""))
        return jsonify({"ok": True, "deleted": deleted, "customers": core.list_customers()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/youtube/search")
def youtube_search_api():
    try:
        data = request.get_json(silent=True) or {}
        results = core.youtube_search(data.get("query", ""), data.get("max_results", 40))
        _prewarm_youtube_stream_urls(results, limit=8)
        return jsonify({"ok": True, "results": results})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/youtube/artist-lists")
def youtube_artist_lists_api():
    try:
        data = request.get_json(silent=True) or {}
        result = core.artist_lists(
            str(data.get("artist") or ""),
            str(data.get("artist_id") or ""),
            str(data.get("channel_url") or ""),
            str(data.get("channel_id") or ""),
            str(data.get("channel") or ""),
        )
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/youtube/collection-tracks")
def youtube_collection_tracks_api():
    try:
        data = request.get_json(silent=True) or {}
        tracks = core.artist_collection_tracks(
            str(data.get("id") or ""),
            str(data.get("kind") or ""),
            str(data.get("artist") or ""),
        )
        return jsonify({"ok": True, "tracks": tracks})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/list/set-text")
def list_set_text():
    try:
        data = request.get_json(silent=True) or {}
        result = core.set_text_list(str(data.get("text") or ""))
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/list/add")
def list_add():
    try:
        data = request.get_json(silent=True) or {}
        result = core.add_candidates(data.get("items") or [])
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/list/delete")
def list_delete():
    try:
        data = request.get_json(silent=True) or {}
        core.delete_rows(data.get("indices") or [])
        return jsonify({"ok": True, "rows": core.rows_public()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/list/clear")
def list_clear():
    core.clear_rows()
    return jsonify({"ok": True, "rows": []})


@app.post("/api/list/resolve")
def list_resolve():
    try:
        core.resolve_all_async()
        return jsonify({"ok": True, "started": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/download")
def download_api():
    try:
        core.start_download(request.get_json(silent=True) or {})
        return jsonify({"ok": True, "started": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/stop")
def stop_api():
    core.stop_all()
    return jsonify({"ok": True})


@app.post("/api/player/play")
def player_play_api():
    try:
        data = request.get_json(silent=True) or {}
        core.player_play(str(data.get("customer") or ""), int(data.get("index", 0)))
        return jsonify({"ok": True, "player": core.player_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/player/next")
def player_next_api():
    try:
        data = request.get_json(silent=True) or {}
        hint = data.get("index")
        core.player_next(auto=False, customer_hint=str(data.get("customer") or ""), index_hint=None if hint is None else int(hint))
        return jsonify({"ok": True, "player": core.player_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/player/previous")
def player_previous_api():
    try:
        data = request.get_json(silent=True) or {}
        hint = data.get("index")
        core.player_previous(customer_hint=str(data.get("customer") or ""), index_hint=None if hint is None else int(hint))
        return jsonify({"ok": True, "player": core.player_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/player/stop")
def player_stop_api():
    core.player_stop()
    return jsonify({"ok": True, "player": core.player_state()})


@app.post("/api/player/seek")
def player_seek_api():
    try:
        data = request.get_json(silent=True) or {}
        core.player_seek(float(data.get("seconds", 0)), bool(data.get("absolute", False)))
        return jsonify({"ok": True, "player": core.player_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/player/volume")
def player_volume_api():
    try:
        data = request.get_json(silent=True) or {}
        core.player_volume(int(data.get("volume", 85)))
        return jsonify({"ok": True, "player": core.player_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/volume")
def shared_volume_api():
    try:
        data = request.get_json(silent=True) or {}
        volume = max(0, min(100, int(data.get("volume", 85))))
        core.shared_volume(volume)
        return jsonify({
            "ok": True,
            "player": core.player_state(),
            "preview": core.preview_state(),
            "volume": volume,
        })
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/preview/start")
def preview_start_api():
    try:
        data = request.get_json(silent=True) or {}
        core.preview_start_async(str(data.get("url") or ""), str(data.get("eq_preset") or core.cfg.get("eq_preset", "Araba Dengeli")), int(data.get("volume", core.cfg.get("player_volume", 85))))
        return jsonify({"ok": True, "started": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/preview/switch")
def preview_switch_api():
    try:
        data = request.get_json(silent=True) or {}
        volume = data.get("volume")
        core.preview_switch(str(data.get("eq_preset") or ""), None if volume is None else int(volume))
        return jsonify({"ok": True, "preview": core.preview_state()})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/preview/stop")
def preview_stop_api():
    core.preview_stop()
    return jsonify({"ok": True, "preview": core.preview_state()})


@app.post("/api/phone/start")
def phone_start_api():
    try:
        return jsonify({"ok": True, **core.phone_start()})
    except Exception as exc:
        return _json_error(str(exc))


@app.get("/api/phone/state")
def phone_state_api():
    return jsonify({"ok": True, **core.phone_state()})


@app.post("/api/phone/copy-photo")
def phone_copy_photo_api():
    try:
        core.copy_phone_photo()
        return jsonify({"ok": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/chatgpt/copy-prompt")
def chatgpt_copy_prompt_api():
    try:
        core.copy_prompt()
        return jsonify({"ok": True, "prompt": CHATGPT_LIST_PROMPT})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/chatgpt/open")
def chatgpt_open_api():
    try:
        webbrowser.open("https://chatgpt.com/")
        return jsonify({"ok": True})
    except Exception as exc:
        return _json_error(str(exc))


@app.post("/api/chatgpt/load-clipboard")
def chatgpt_load_clipboard_api():
    try:
        result = core.load_chatgpt_clipboard()
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return _json_error(str(exc))


@app.errorhandler(Exception)
def unhandled_error(exc):
    detail = traceback.format_exc(limit=5)
    return _json_error(str(exc), 500, detail=detail[-1800:])


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="ascii")
    except Exception:
        pass
    import logging
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    try:
        app.run(host=HOST, port=PORT, debug=False, use_reloader=False, threaded=True)
    finally:
        try:
            PID_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            core.eq_preview.clear()
        except Exception:
            pass
        try:
            core.player.stop()
        except Exception:
            pass


if __name__ == "__main__":
    main()
