from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import random
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from duplicate_guard import car_artist_title, car_song_key, filename_song_key


CORE_DIRECT_SALE_URL = "http://127.0.0.1:3000/admin/product-sales/add-custom-direct"
DRIVE_REMOVABLE = 2
LAYOUTS = {"customer", "artist", "flat"}
PAYMENTS = {"CASH", "CARD"}
FILE_ATTRIBUTE_HIDDEN = 0x2
FILE_ATTRIBUTE_SYSTEM = 0x4


def is_visible_browsable_folder(path: Path) -> bool:
    """Satış arşivinde Windows'un gizli/sistem klasörlerini gösterme."""
    try:
        if not path.is_dir():
            return False
        if os.name == "nt":
            attrs = int(getattr(path.stat(), "st_file_attributes", 0))
            if attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM):
                return False
        return path.name.casefold() not in {"$recycle.bin", "system volume information"}
    except OSError:
        return False


def _safe_component(value: str, fallback: str = "Muzikler", limit: int = 80) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(value or ""))
    value = re.sub(r"\s+", " ", value).strip(" .")
    return (value or fallback)[:limit].rstrip(" .")


def _drive_root(value: str) -> str:
    match = re.fullmatch(r"\s*([A-Za-z]):(?:[\\/]*)\s*", str(value or ""))
    if not match:
        raise ValueError("Geçerli bir USB sürücüsü seçin.")
    return match.group(1).upper() + ":\\"


def _formatted_track(source: Path) -> tuple[str, str, str]:
    clean_stem = re.sub(r"^\s*\d{1,4}\s*[.)_-]\s*", "", source.stem)
    artist, title = car_artist_title(clean_stem)
    filename = _safe_component(f"{artist} - {title}" if artist and title else title or source.stem, "Muzik") + ".mp3"
    return artist, title, filename


def _usb_filename_key(filename: str) -> str:
    clean_name = re.sub(r"^\s*\d{1,4}\s*[.)_-]\s*", "", Path(filename).name)
    return filename_song_key(clean_name)


class UsbSalesManager:
    def __init__(self, data_dir: Path, app_dir: Path):
        self.lock = threading.RLock()
        self.data_dir = Path(data_dir)
        self.transaction_file = self.data_dir / "usb-sale-latest.json"
        self.app_dir = Path(app_dir)
        self.extra_sources: dict[str, Path] = {}
        self.last_browser_folder = ""
        self.sources_file = self.data_dir / "usb-mp3-sources.json"
        self._load_sources()

    def _set_sources_file(self, filename: str) -> None:
        with self.lock:
            self.sources_file = self.data_dir / filename
            self.extra_sources = {}
            self._load_sources()

    def _load_sources(self) -> None:
        try:
            raw = json.loads(self.sources_file.read_text(encoding="utf-8"))
            values = raw.get("paths", []) if isinstance(raw, dict) else []
            self.last_browser_folder = str(raw.get("last_browser_folder") or "") if isinstance(raw, dict) else ""
            for value in values if isinstance(values, list) else []:
                path = Path(str(value or "")).expanduser()
                if not str(path):
                    continue
                key = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()[:16]
                self.extra_sources[key] = path
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    def _save_sources_locked(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        payload = {"paths": [str(path) for path in self.extra_sources.values()], "last_browser_folder": self.last_browser_folder}
        temp = self.sources_file.with_suffix(self.sources_file.suffix + ".tmp")
        encoded = json.dumps(payload, ensure_ascii=False, indent=2)
        try:
            temp.write_text(encoded, encoding="utf-8")
            os.replace(temp, self.sources_file)
        except OSError:
            # Bazı kiosk/antivirüs kurulumlarında .tmp yeniden adlandırması
            # engellenir. Kaynak seçimi yine kaybolmasın diye doğrudan yaz.
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
            self.sources_file.write_text(encoded, encoding="utf-8")

    def _remember_browser_folder(self, folder: Path) -> None:
        value = str(folder)
        with self.lock:
            if value == self.last_browser_folder:
                return
            self.last_browser_folder = value
            self._save_sources_locked()

    def _ffmpeg(self) -> str:
        marker = self.app_dir / "ffmpeg_path.txt"
        configured = marker.read_text(encoding="utf-8-sig").strip() if marker.is_file() else ""
        ffmpeg = configured if configured and Path(configured).is_file() else shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("USB uyumlu MP3 dönüşümü için FFmpeg bulunamadı.")
        return str(ffmpeg)

    @staticmethod
    def _drive_type(root: str) -> int:
        if os.name != "nt":
            return 0
        return int(ctypes.windll.kernel32.GetDriveTypeW(ctypes.c_wchar_p(root)))

    def drives(self) -> list[dict]:
        if os.name != "nt":
            return []
        mask = int(ctypes.windll.kernel32.GetLogicalDrives())
        rows = []
        for index in range(26):
            if not mask & (1 << index):
                continue
            root = chr(65 + index) + ":\\"
            if self._drive_type(root) != DRIVE_REMOVABLE:
                continue
            label = ctypes.create_unicode_buffer(261)
            try:
                ctypes.windll.kernel32.GetVolumeInformationW(
                    ctypes.c_wchar_p(root), label, len(label), None, None, None, None, 0
                )
            except Exception:
                pass
            try:
                usage = shutil.disk_usage(root)
                total_gb = round(usage.total / (1024 ** 3), 1)
                free_gb = round(usage.free / (1024 ** 3), 1)
            except OSError:
                total_gb = free_gb = 0.0
            rows.append({"drive": root, "label": label.value or "USB", "total_gb": total_gb, "free_gb": free_gb})
        return rows

    def source_roots(self) -> list[dict]:
        if os.name != "nt":
            return []
        mask = int(ctypes.windll.kernel32.GetLogicalDrives())
        rows = []
        for index in range(26):
            if not mask & (1 << index):
                continue
            root = chr(65 + index) + ":\\"
            drive_type = self._drive_type(root)
            if drive_type not in {2, 3}:
                continue
            rows.append({"name": root, "path": root, "type": "USB" if drive_type == 2 else "Disk"})
        return rows

    def browse_sources(self, requested: str, fallback: Path) -> dict:
        if not str(requested or "").strip() and self.last_browser_folder:
            requested = self.last_browser_folder
        folder = Path(str(requested or "")).expanduser() if str(requested or "").strip() else fallback.expanduser()
        if not folder.is_dir():
            folder = fallback if fallback.is_dir() else Path.home()
        folder = folder.resolve()
        self._remember_browser_folder(folder)
        entries = list(folder.iterdir())
        folders = sorted((p for p in entries if is_visible_browsable_folder(p)), key=lambda p: p.name.casefold())
        files = sorted((p for p in entries if p.is_file() and p.suffix.lower() == ".mp3"), key=lambda p: p.name.casefold())
        parent = folder.parent
        return {
            "folder": str(folder),
            "parent": "" if parent == folder else str(parent),
            "roots": self.source_roots(),
            "folders": [{"name": p.name, "path": str(p)} for p in folders],
            "files": [{"name": p.name, "path": str(p), "size_mb": round(p.stat().st_size / (1024 * 1024), 1)} for p in files],
        }

    def add_sources(self, values: list[str]) -> list[dict]:
        with self.lock:
            for value in values:
                path = Path(str(value or "")).expanduser().resolve()
                if not path.exists() or (not path.is_dir() and not (path.is_file() and path.suffix.lower() == ".mp3")):
                    raise ValueError(f"Geçerli klasör veya MP3 bulunamadı: {path}")
                key = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()[:16]
                self.extra_sources[key] = path
            self._save_sources_locked()
            return self.sources()

    def sources(self) -> list[dict]:
        with self.lock:
            return [{"id": key, "name": path.name, "path": str(path), "kind": "folder" if path.is_dir() else "file"}
                    for key, path in self.extra_sources.items()]

    def remove_source(self, source_id: str) -> list[dict]:
        with self.lock:
            self.extra_sources.pop(str(source_id or ""), None)
            self._save_sources_locked()
            return self.sources()

    def clear_sources(self) -> list[dict]:
        with self.lock:
            self.extra_sources.clear()
            self._save_sources_locked()
            return []

    def validate_drive(self, value: str) -> Path:
        root = _drive_root(value)
        if self._drive_type(root) != DRIVE_REMOVABLE:
            raise ValueError("Güvenlik: yalnız Windows'un çıkarılabilir USB olarak gördüğü sürücü kullanılabilir.")
        path = Path(root)
        if not path.exists():
            raise FileNotFoundError("Seçilen USB artık bağlı değil.")
        return path

    def format_drive(self, value: str, filesystem: str, label: str, confirmation: str) -> dict:
        root = _drive_root(value)
        drive = self.validate_drive(root)
        letter = root[0]
        fs = str(filesystem or "").upper()
        if fs not in {"FAT32", "EXFAT", "NTFS"}:
            raise ValueError("USB biçimi yalnız FAT32, exFAT veya NTFS olabilir.")
        try:
            volume_size = shutil.disk_usage(drive).total
        except OSError:
            volume_size = 0
        if fs == "FAT32" and volume_size > 32 * 1024 ** 3:
            raise ValueError("Bu USB 32 GB'dan büyük. Windows yerleşik biçimlendirme aracıyla FAT32 yapılamaz; exFAT seçin veya 32 GB/altı USB kullanın.")
        if str(confirmation or "").strip().upper() != f"FORMAT {letter}":
            raise ValueError(f"Biçimlendirme onayı geçersiz. FORMAT {letter} yazılmalı.")
        volume_label = re.sub(r"[^A-Za-z0-9 _-]", "", str(label or "KAFEPIN")).strip()[:11] or "KAFEPIN"
        command = (
            f"Format-Volume -DriveLetter '{letter}' -FileSystem '{fs}' "
            f"-NewFileSystemLabel '{volume_label}' -Confirm:$false -Force -ErrorAction Stop | Out-Null"
        )
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            creationflags=flags,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "Biçimlendirme başarısız.").strip()
            raise RuntimeError(detail[-1200:])
        time.sleep(1.0)
        return {"drive": str(drive), "filesystem": fs, "label": volume_label}

    def _source_entries(self, customer_root: Path, customers: list[str]) -> list[tuple[str, Path, Path]]:
        root = customer_root.expanduser().resolve()
        available = {p.name: p.resolve() for p in root.iterdir() if p.is_dir()} if root.is_dir() else {}
        selected = []
        for name in dict.fromkeys(str(x or "").strip() for x in customers):
            folder = available.get(name)
            if folder is None or folder.parent != root:
                raise ValueError(f"Müşteri klasörü bulunamadı: {name}")
            selected.append((name, folder, folder))
        with self.lock:
            extras = list(self.extra_sources.values())
        for path in extras:
            if not path.exists():
                continue
            base = path if path.is_dir() else path.parent
            selected.append((path.name if path.is_dir() else path.parent.name or "Secilen Sarkilar", path, base))
        if not selected:
            raise ValueError("Dosya gezgininden en az bir klasör veya MP3 ekleyin.")
        return selected

    def build_plan(self, customer_root: Path, data: dict) -> dict:
        drive = self.validate_drive(str(data.get("drive") or ""))
        layout = str(data.get("layout") or "customer").lower()
        if layout not in LAYOUTS:
            raise ValueError("Geçersiz USB klasör düzeni.")
        base_name = _safe_component(str(data.get("folder_name") or "Muzikler"), "Muzikler")
        destination_root = drive / base_name
        sources = self._source_entries(customer_root, list(data.get("customers") or []))

        existing_keys = set()
        if destination_root.exists():
            for path in destination_root.rglob("*.mp3"):
                if path.is_file():
                    key = _usb_filename_key(path.name)
                    if key:
                        existing_keys.add(key)

        planned = []
        seen = set(existing_keys)
        duplicate_count = 0
        source_count = 0
        for customer, entry, base in sources:
            candidates = [entry] if entry.is_file() else [p for p in entry.rglob("*.mp3") if p.is_file()]
            for source in sorted(candidates, key=lambda p: str(p).casefold()):
                source_count += 1
                artist, title, filename = _formatted_track(source)
                key = car_song_key(artist, title) or filename_song_key(filename)
                if key and key in seen:
                    duplicate_count += 1
                    continue
                if key:
                    seen.add(key)
                if layout == "customer":
                    relative_parent = source.relative_to(base).parent
                    destination = destination_root / _safe_component(customer, "Musteri") / relative_parent / filename
                elif layout == "artist":
                    destination = destination_root / _safe_component(artist, "Diger") / filename
                else:
                    destination = destination_root / filename
                planned.append({"source": source, "destination": destination, "artist": artist, "title": title})

        total_bytes = sum(item["source"].stat().st_size for item in planned)
        return {
            "drive": drive,
            "destination_root": destination_root,
            "layout": layout,
            "source_count": source_count,
            "duplicate_count": duplicate_count,
            "copy_count": len(planned),
            "total_bytes": total_bytes,
            "items": planned,
        }

    @staticmethod
    def public_plan(plan: dict, unit_price: float) -> dict:
        count = int(plan["copy_count"])
        return {
            "drive": str(plan["drive"]),
            "destination": str(plan["destination_root"]),
            "source_count": int(plan["source_count"]),
            "duplicate_count": int(plan["duplicate_count"]),
            "copy_count": count,
            "size_mb": round(int(plan["total_bytes"]) / (1024 * 1024), 1),
            "unit_price": unit_price,
            "total_price": round(count * unit_price, 2),
        }

    def preview(self, customer_root: Path, data: dict) -> dict:
        unit_price = round(float(data.get("unit_price") or 0), 2)
        if unit_price < 0:
            raise ValueError("Şarkı fiyatı negatif olamaz.")
        return self.public_plan(self.build_plan(customer_root, data), unit_price)

    def _load_transaction(self) -> dict | None:
        try:
            data = json.loads(self.transaction_file.read_text(encoding="utf-8-sig"))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _save_transaction(self, transaction: dict) -> None:
        self.transaction_file.parent.mkdir(parents=True, exist_ok=True)
        temp = self.transaction_file.with_name(self.transaction_file.name + "." + uuid.uuid4().hex + ".tmp")
        temp.write_text(json.dumps(transaction, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.replace(temp, self.transaction_file)
        finally:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _write_shuffle_playlists(destination_root: Path) -> None:
        all_tracks = [p for p in destination_root.rglob("*.mp3") if p.is_file()] if destination_root.exists() else []
        m3u8 = destination_root / "Karisik Cal.m3u8"
        m3u = destination_root / "Karisik Cal.m3u"
        if not all_tracks:
            m3u8.unlink(missing_ok=True)
            m3u.unlink(missing_ok=True)
            return
        random.SystemRandom().shuffle(all_tracks)
        relative_tracks = [str(p.relative_to(destination_root)).replace("/", "\\") for p in all_tracks]
        m3u8.write_text("#EXTM3U\n" + "\n".join(relative_tracks) + "\n", encoding="utf-8-sig")
        m3u.write_text("#EXTM3U\n" + "\n".join(relative_tracks) + "\n", encoding="cp1254", errors="replace")

    def transaction(self) -> dict | None:
        with self.lock:
            return self._load_transaction()

    def transfer(self, customer_root: Path, data: dict) -> dict:
        with self.lock:
            current = self._load_transaction()
            if current and current.get("status") in {"pending", "submitting", "uncertain"}:
                raise RuntimeError("Önce bekleyen USB satışını onaylayın veya iptal edin.")
            unit_price = round(float(data.get("unit_price") or 0), 2)
            if unit_price < 0:
                raise ValueError("Şarkı fiyatı negatif olamaz.")
            payment = str(data.get("payment_method") or "CASH").upper()
            if payment not in PAYMENTS:
                raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
            raw_bitrate = str(data.get("bitrate_kbps", 192)).lower()
            bitrate = 0 if raw_bitrate in {"0", "original"} else int(raw_bitrate)
            if bitrate not in {0, 128, 192, 320}:
                raise ValueError("USB MP3 kalitesi yalnız Orijinal, 128, 192 veya 320 kbps olabilir.")
            shuffle_enabled = bool(data.get("shuffle", False))
            plan = self.build_plan(customer_root, data)
            if not plan["items"]:
                return {**self.public_plan(plan, unit_price), "copied": 0, "failed": 0, "errors": [], "transaction": None}
            free = shutil.disk_usage(plan["drive"]).free
            if int(plan["total_bytes"]) + (16 * 1024 * 1024) > free:
                raise RuntimeError("USB'de seçilen şarkılar için yeterli boş alan yok.")

            copied = 0
            copied_paths: list[Path] = []
            errors = []
            copy_items = list(plan["items"])
            if shuffle_enabled:
                random.SystemRandom().shuffle(copy_items)
            for item in copy_items:
                source, destination = item["source"], item["destination"]
                temp = None
                try:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if destination.exists():
                        stem, suffix, number = destination.stem, destination.suffix, 2
                        while destination.exists():
                            destination = destination.with_name(f"{stem} ({number}){suffix}")
                            number += 1
                    temp = destination.with_name("." + destination.name + "." + uuid.uuid4().hex + ".copying")
                    if bitrate:
                        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                        completed = subprocess.run(
                            [self._ffmpeg(), "-hide_banner", "-nostats", "-y", "-i", str(source),
                             "-map_metadata", "-1", "-vn", "-ar", "44100", "-ac", "2",
                             "-c:a", "libmp3lame", "-b:a", f"{bitrate}k",
                             "-metadata", f"artist={item['artist']}", "-metadata", f"title={item['title']}",
                             "-id3v2_version", "3", "-f", "mp3", str(temp)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=900,
                            creationflags=flags, check=False,
                        )
                        if completed.returncode != 0 or not temp.exists() or temp.stat().st_size <= 0:
                            detail = completed.stderr.decode("utf-8", errors="replace")[-600:]
                            raise RuntimeError("Araç uyumlu MP3 üretilemedi. " + detail)
                    else:
                        shutil.copy2(source, temp)
                        if temp.stat().st_size != source.stat().st_size:
                            raise IOError("Kopyalama boyutu doğrulanamadı.")
                    os.replace(temp, destination)
                    copied += 1
                    copied_paths.append(destination)
                except Exception as exc:
                    errors.append(f"{source.name}: {exc}")
                finally:
                    if temp is not None:
                        temp.unlink(missing_ok=True)

            if shuffle_enabled and copied:
                self._write_shuffle_playlists(plan["destination_root"])

            transaction = None
            if copied:
                transaction = {
                    "id": uuid.uuid4().hex,
                    "status": "pending",
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "drive": str(plan["drive"]),
                    "destination_root": str(plan["destination_root"]),
                    "files": [str(path.relative_to(plan["drive"])) for path in copied_paths],
                    "copied": copied,
                    "duplicates": int(plan["duplicate_count"]),
                    "failed": len(errors),
                    "unit_price": unit_price,
                    "total_price": round(copied * unit_price, 2),
                    "payment_method": payment,
                    "bitrate_kbps": bitrate,
                    "shuffle": shuffle_enabled,
                    "sale_id": None,
                }
                self._save_transaction(transaction)
            return {
                **self.public_plan(plan, unit_price),
                "copied": copied,
                "failed": len(errors),
                "errors": errors[:20],
                "transaction": transaction,
            }

    def confirm_sale(self, transaction_id: str) -> dict:
        with self.lock:
            tx = self._load_transaction()
            if not tx or tx.get("id") != str(transaction_id or ""):
                raise ValueError("Bekleyen USB satışı bulunamadı.")
            if tx.get("status") == "completed":
                return tx
            if tx.get("status") != "pending":
                raise RuntimeError("Bu satış otomatik yeniden gönderilemez; KafePin Doğrudan Satış listesini kontrol edin.")
            if float(tx.get("total_price") or 0) <= 0:
                raise ValueError("Satış toplamı 0 TL olamaz.")
            tx["status"] = "submitting"
            self._save_transaction(tx)
            payload = json.dumps({
                "name": f"MP3 USB Satışı • {int(tx['copied'])} şarkı",
                "unitPrice": float(tx["total_price"]),
                "quantity": 1,
                "paymentMethod": tx["payment_method"],
            }, ensure_ascii=False).encode("utf-8")
            try:
                with urlopen(Request(CORE_DIRECT_SALE_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"), timeout=12) as response:
                    result = json.loads(response.read().decode("utf-8"))
                if not result.get("ok") or not result.get("id"):
                    raise RuntimeError(str(result.get("error") or "KafePin satış kimliği dönmedi."))
            except Exception as exc:
                tx["status"] = "uncertain"
                tx["error"] = str(exc)
                self._save_transaction(tx)
                raise RuntimeError("Satış cevabı kesinleşmedi; çift kayıt riskine karşı yeniden gönderilmedi. Doğrudan Satış listesini kontrol edin.") from exc
            tx["status"] = "completed"
            tx["sale_id"] = int(result["id"])
            tx["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            tx.pop("error", None)
            self._save_transaction(tx)
            return tx

    def cancel_sale(self, transaction_id: str, remove_files: bool = False) -> dict:
        with self.lock:
            tx = self._load_transaction()
            if not tx or tx.get("id") != str(transaction_id or ""):
                raise ValueError("Bekleyen USB satışı bulunamadı.")
            if tx.get("status") != "pending":
                raise RuntimeError("Yalnız henüz gönderilmemiş satış iptal edilebilir.")
            removed = 0
            if remove_files:
                drive = self.validate_drive(str(tx.get("drive") or ""))
                drive_resolved = drive.resolve()
                for relative in list(tx.get("files") or []):
                    candidate = (drive / str(relative)).resolve()
                    if drive_resolved not in candidate.parents:
                        raise RuntimeError("USB silme hedefi güvenlik sınırı dışında.")
                    if candidate.is_file():
                        candidate.unlink()
                        removed += 1
                    parent = candidate.parent
                    while parent != drive_resolved and drive_resolved in parent.parents:
                        try:
                            parent.rmdir()
                        except OSError:
                            break
                        parent = parent.parent
                destination_root = Path(str(tx.get("destination_root") or ""))
                try:
                    destination_resolved = destination_root.resolve()
                    if destination_resolved == drive_resolved or drive_resolved in destination_resolved.parents:
                        self._write_shuffle_playlists(destination_resolved)
                except OSError:
                    pass
            tx["status"] = "cancelled"
            tx["cancelled_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            tx["removed_files"] = removed
            self._save_transaction(tx)
            return tx
