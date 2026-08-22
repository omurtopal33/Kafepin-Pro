from __future__ import annotations
import json
import os
import shutil
from pathlib import Path

APP_ID = "KafePinMp3BotPRO"
LEGACY_APP_ID = "MP3MusteriAsistaniV1"
DATA_DIR = Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / APP_ID
CONFIG_FILE = DATA_DIR / "config.json"
LEGACY_CONFIG_FILE = Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / LEGACY_APP_ID / "config.json"

DEFAULTS = {
    "youtube_results": 5,
    "openai_model": "gpt-5.6",
    "customer_root": str(Path.home() / "Music" / "Musteriler"),
    "favorites_root": str(Path.home() / "Music" / "KafePin Favorilerim"),
    "winamp_folder": str(Path.home() / "Music"),
    "winamp_saved_locations": [],
    "download_method": "native",
    "direct_bitrate_kbps": 320,
    "normalize_audio": True,
    "normalize_lufs": -14.0,
    "normalize_true_peak": -2.0,
    "normalize_lra": 9.0,
    "eq_preset": "Araba Dengeli",
    "listen_eq_preset": "Orijinal / Düz",
    "app_mode": "download",
    "player_volume": 85,
    "usb_unit_price": 10.0,
    "usb_folder_name": "Muzikler",
    "usb_layout": "customer",
    "usb_payment_method": "CASH",
    "usb_bitrate_kbps": 192,
    "usb_shuffle": True,
    "usb_saved_locations": [],
    "usb_film_saved_locations": [],
    "usb_game_saved_locations": [],
    "web_host": "127.0.0.1",
    "web_port": 17890,
}


def _migrate_legacy_config() -> None:
    """v2.26 ayarlarını ilk web kurulumunda tek sefer kopyalar.

    KafePin çekirdeğine hiçbir erişim yoktur; yalnız eski MP3 Bot kullanıcı
    ayarları yeni MP3 Bot veri alanına taşınır.
    """
    if CONFIG_FILE.exists() or not LEGACY_CONFIG_FILE.exists():
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(LEGACY_CONFIG_FILE, CONFIG_FILE)
    except Exception:
        pass


def load_config() -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_config()
    cfg = DEFAULTS.copy()
    if CONFIG_FILE.exists():
        try:
            loaded = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
            if isinstance(loaded, dict):
                cfg.update({key: value for key, value in loaded.items() if key in DEFAULTS})
        except Exception:
            pass
    return cfg


def save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    safe = DEFAULTS.copy()
    safe.update(cfg or {})
    CONFIG_FILE.write_text(
        json.dumps(safe, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
