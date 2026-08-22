from __future__ import annotations

import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from usb_sales import CORE_DIRECT_SALE_URL, PAYMENTS, UsbSalesManager, _safe_component, is_visible_browsable_folder


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v"}
FILM_PROFILES = {"original", "mp4_720", "mp4_1080"}
FILM_LAYOUTS = {"folders", "flat"}


def _film_key(path: Path) -> str:
    value = re.sub(r"\s+", " ", path.stem).strip().casefold()
    return re.sub(r"[^a-z0-9çğıöşü]+", "", value)


class UsbFilmSalesManager(UsbSalesManager):
    def __init__(self, data_dir: Path, app_dir: Path):
        super().__init__(data_dir, app_dir)
        self.transaction_file = Path(data_dir) / "usb-film-sale-latest.json"
        self._set_sources_file("usb-film-sources.json")

    def browse_sources(self, requested: str, fallback: Path) -> dict:
        if not str(requested or "").strip() and self.last_browser_folder:
            requested = self.last_browser_folder
        folder = Path(str(requested or "")).expanduser() if str(requested or "").strip() else fallback.expanduser()
        if not folder.is_dir():
            folder = fallback if fallback.is_dir() else Path.home()
        folder = folder.resolve()
        self._remember_browser_folder(folder)
        try:
            entries = list(folder.iterdir())
        except OSError as exc:
            raise PermissionError(f"Bu klasör açılamadı: {folder}") from exc
        folders = sorted((p for p in entries if is_visible_browsable_folder(p)), key=lambda p: p.name.casefold())
        files = sorted((p for p in entries if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS), key=lambda p: p.name.casefold())
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
                if not path.exists() or (not path.is_dir() and not (path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS)):
                    raise ValueError(f"Geçerli film klasörü veya video bulunamadı: {path}")
                key = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()[:16]
                self.extra_sources[key] = path
            self._save_sources_locked()
            return self.sources()

    def _entries(self) -> list[tuple[str, Path, Path]]:
        with self.lock:
            paths = list(self.extra_sources.values())
        selected = []
        for path in paths:
            if not path.exists():
                continue
            base = path if path.is_dir() else path.parent
            label = path.name if path.is_dir() else (path.parent.name or "Filmler")
            selected.append((label, path, base))
        if not selected:
            raise ValueError("Film gezgininden en az bir klasör veya video ekleyin.")
        return selected

    def build_plan(self, data: dict) -> dict:
        drive = self.validate_drive(str(data.get("drive") or ""))
        layout = str(data.get("layout") or "folders").lower()
        profile = str(data.get("profile") or "original").lower()
        if layout not in FILM_LAYOUTS:
            raise ValueError("Geçersiz film klasör düzeni.")
        if profile not in FILM_PROFILES:
            raise ValueError("Geçersiz film uyumluluk profili.")
        destination_root = drive / _safe_component(str(data.get("folder_name") or "Filmler"), "Filmler")
        existing = set()
        if destination_root.exists():
            for path in destination_root.rglob("*"):
                if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
                    existing.add(_film_key(path))
        seen = set(existing)
        planned, duplicate_count, source_count = [], 0, 0
        for label, entry, base in self._entries():
            candidates = [entry] if entry.is_file() else [p for p in entry.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS]
            for source in sorted(candidates, key=lambda p: str(p).casefold()):
                source_count += 1
                key = _film_key(source)
                if key and key in seen:
                    duplicate_count += 1
                    continue
                if key:
                    seen.add(key)
                filename = _safe_component(source.stem, "Film") + (".mp4" if profile != "original" else source.suffix.lower())
                if layout == "folders":
                    destination = destination_root / _safe_component(label, "Filmler") / source.relative_to(base).parent / filename
                else:
                    destination = destination_root / filename
                planned.append({"source": source, "destination": destination})
        return {
            "drive": drive, "destination_root": destination_root, "profile": profile,
            "source_count": source_count, "duplicate_count": duplicate_count,
            "copy_count": len(planned), "total_bytes": sum(x["source"].stat().st_size for x in planned), "items": planned,
        }

    def preview(self, data: dict) -> dict:
        unit_price = round(float(data.get("unit_price") or 0), 2)
        if unit_price < 0:
            raise ValueError("Film fiyatı negatif olamaz.")
        return self.public_plan(self.build_plan(data), unit_price)

    def transfer(self, data: dict) -> dict:
        with self.lock:
            current = self._load_transaction()
            if current and current.get("status") in {"pending", "submitting", "uncertain"}:
                raise RuntimeError("Önce bekleyen film USB satışını onaylayın veya iptal edin.")
            unit_price = round(float(data.get("unit_price") or 0), 2)
            if unit_price < 0:
                raise ValueError("Film fiyatı negatif olamaz.")
            payment = str(data.get("payment_method") or "CASH").upper()
            if payment not in PAYMENTS:
                raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
            plan = self.build_plan(data)
            if not plan["items"]:
                return {**self.public_plan(plan, unit_price), "copied": 0, "failed": 0, "errors": [], "transaction": None}
            if int(plan["total_bytes"] * 1.25) + (64 * 1024 * 1024) > shutil.disk_usage(plan["drive"]).free:
                raise RuntimeError("USB'de seçilen filmler için yeterli boş alan yok.")
            copied_paths, errors = [], []
            items = list(plan["items"])
            if bool(data.get("shuffle", False)):
                random.SystemRandom().shuffle(items)
            for item in items:
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
                    if plan["profile"] == "original":
                        shutil.copy2(source, temp)
                        if temp.stat().st_size != source.stat().st_size:
                            raise IOError("Kopyalama boyutu doğrulanamadı.")
                    else:
                        width = "1280" if plan["profile"] == "mp4_720" else "1920"
                        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                        completed = subprocess.run([
                            self._ffmpeg(), "-hide_banner", "-nostats", "-y", "-i", str(source),
                            "-map", "0:v:0", "-map", "0:a?", "-vf", f"scale={width}:-2:force_original_aspect_ratio=decrease",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
                            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", str(temp)
                        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=21600, creationflags=flags, check=False)
                        if completed.returncode != 0 or not temp.exists() or temp.stat().st_size <= 0:
                            detail = completed.stderr.decode("utf-8", errors="replace")[-600:]
                            raise RuntimeError("Uyumlu MP4 üretilemedi. " + detail)
                    os.replace(temp, destination)
                    copied_paths.append(destination)
                except Exception as exc:
                    errors.append(f"{source.name}: {exc}")
                finally:
                    if temp is not None:
                        temp.unlink(missing_ok=True)
            copied = len(copied_paths)
            transaction = None
            if copied:
                transaction = {
                    "id": uuid.uuid4().hex, "status": "pending", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "drive": str(plan["drive"]), "destination_root": str(plan["destination_root"]),
                    "files": [str(path.relative_to(plan["drive"])) for path in copied_paths], "copied": copied,
                    "duplicates": int(plan["duplicate_count"]), "failed": len(errors), "unit_price": unit_price,
                    "total_price": round(copied * unit_price, 2), "payment_method": payment,
                    "profile": plan["profile"], "sale_id": None,
                }
                self._save_transaction(transaction)
            return {**self.public_plan(plan, unit_price), "copied": copied, "failed": len(errors), "errors": errors[:20], "transaction": transaction}

    def confirm_sale(self, transaction_id: str) -> dict:
        with self.lock:
            tx = self._load_transaction()
            if not tx or tx.get("id") != str(transaction_id or ""):
                raise ValueError("Bekleyen film USB satışı bulunamadı.")
            if tx.get("status") == "completed":
                return tx
            if tx.get("status") != "pending":
                raise RuntimeError("Bu satış otomatik yeniden gönderilemez; KafePin Doğrudan Satış listesini kontrol edin.")
            if float(tx.get("total_price") or 0) <= 0:
                raise ValueError("Satış toplamı 0 TL olamaz.")
            tx["status"] = "submitting"
            self._save_transaction(tx)
            payload = json.dumps({"name": f"Film USB Satışı • {int(tx['copied'])} film", "unitPrice": float(tx["total_price"]), "quantity": 1, "paymentMethod": tx["payment_method"]}, ensure_ascii=False).encode("utf-8")
            try:
                with urlopen(Request(CORE_DIRECT_SALE_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"), timeout=12) as response:
                    result = json.loads(response.read().decode("utf-8"))
                if not result.get("ok") or not result.get("id"):
                    raise RuntimeError(str(result.get("error") or "KafePin satış kimliği dönmedi."))
            except Exception as exc:
                tx["status"], tx["error"] = "uncertain", str(exc)
                self._save_transaction(tx)
                raise RuntimeError("Satış cevabı kesinleşmedi; Doğrudan Satış listesini kontrol edin.") from exc
            tx["status"], tx["sale_id"], tx["completed_at"] = "completed", int(result["id"]), time.strftime("%Y-%m-%dT%H:%M:%S")
            tx.pop("error", None)
            self._save_transaction(tx)
            return tx
