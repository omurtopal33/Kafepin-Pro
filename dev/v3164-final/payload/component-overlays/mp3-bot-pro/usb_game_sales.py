from __future__ import annotations

import ctypes
import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from usb_sales import CORE_DIRECT_SALE_URL, PAYMENTS, UsbSalesManager, _safe_component, is_visible_browsable_folder


PACKAGE_EXTENSIONS = {".exe", ".msi", ".iso", ".zip", ".rar", ".7z"}


class UsbGameSalesManager(UsbSalesManager):
    def __init__(self, data_dir: Path, app_dir: Path):
        super().__init__(data_dir, app_dir)
        self.transaction_file = Path(data_dir) / "usb-game-sale-latest.json"
        self._set_sources_file("usb-game-sources.json")

    @staticmethod
    def _is_reparse_path(path: Path) -> bool:
        try:
            if path.is_symlink():
                return True
            is_junction = getattr(path, "is_junction", None)
            return bool(is_junction and is_junction())
        except OSError:
            return True

    @classmethod
    def _safe_is_dir(cls, path: Path) -> bool:
        if cls._is_reparse_path(path):
            return False
        try:
            return path.is_dir()
        except OSError:
            return False

    @classmethod
    def _safe_is_package_file(cls, path: Path) -> bool:
        if cls._is_reparse_path(path):
            return False
        try:
            return path.is_file() and path.suffix.lower() in PACKAGE_EXTENSIONS
        except OSError:
            return False

    def browse_sources(self, requested: str, fallback: Path) -> dict:
        if not str(requested or "").strip() and self.last_browser_folder:
            requested = self.last_browser_folder
        folder = Path(str(requested or "")).expanduser() if str(requested or "").strip() else fallback.expanduser()
        if not self._safe_is_dir(folder):
            folder = fallback if self._safe_is_dir(fallback) else Path.home()
        # UNC paths must not be resolved here: resolving a remote reparse point can
        # raise WinError 1463 before the browser has a chance to skip it.
        try:
            entries = list(folder.iterdir())
        except OSError as exc:
            raise PermissionError(f"Bu klasör açılamadı: {folder}") from exc
        self._remember_browser_folder(folder)
        folders = sorted((p for p in entries if self._safe_is_dir(p) and is_visible_browsable_folder(p)), key=lambda p: p.name.casefold())
        files = sorted((p for p in entries if self._safe_is_package_file(p)), key=lambda p: p.name.casefold())
        parent = folder.parent
        return {"folder": str(folder), "parent": "" if parent == folder else str(parent), "roots": self.source_roots(),
                "folders": [{"name": p.name, "path": str(p)} for p in folders],
                "files": [{"name": p.name, "path": str(p), "size_mb": round(p.stat().st_size / (1024 * 1024), 1)} for p in files]}

    def add_sources(self, values: list[str]) -> list[dict]:
        with self.lock:
            for value in values:
                path = Path(str(value or "")).expanduser()
                if self._is_reparse_path(path):
                    raise ValueError(f"Bu oyun yolu sembolik bağlantı/junction. Gerçek klasörü seçin: {path}")
                try:
                    valid = path.exists() and (path.is_dir() or (path.is_file() and path.suffix.lower() in PACKAGE_EXTENSIONS))
                except OSError:
                    valid = False
                if not valid:
                    raise ValueError(f"Geçerli oyun klasörü veya kurulum paketi bulunamadı: {path}")
                key = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8")).hexdigest()[:16]
                self.extra_sources[key] = path
            self._save_sources_locked()
            return self.sources()

    @staticmethod
    def _path_size(path: Path) -> tuple[int, int]:
        if path.is_file():
            return path.stat().st_size, path.stat().st_size
        total, largest = 0, 0
        for child in path.rglob("*"):
            if child.is_file():
                size = child.stat().st_size
                total += size
                largest = max(largest, size)
        return total, largest

    @staticmethod
    def _filesystem(drive: Path) -> str:
        if os.name != "nt":
            return ""
        fs = ctypes.create_unicode_buffer(64)
        ctypes.windll.kernel32.GetVolumeInformationW(str(drive), None, 0, None, None, None, fs, len(fs))
        return fs.value.upper()

    def build_plan(self, data: dict) -> dict:
        drive = self.validate_drive(str(data.get("drive") or ""))
        destination_root = drive / _safe_component(str(data.get("folder_name") or "Oyunlar"), "Oyunlar")
        with self.lock:
            sources = [p for p in self.extra_sources.values() if p.exists()]
        if not sources:
            raise ValueError("Oyun gezgininden en az bir oyun klasörü veya kurulum paketi ekleyin.")
        planned, duplicates, total, largest = [], 0, 0, 0
        seen = {p.name.casefold() for p in destination_root.iterdir()} if destination_root.is_dir() else set()
        for source in sources:
            destination = destination_root / _safe_component(source.name, "Oyun")
            key = destination.name.casefold()
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            size, max_file = self._path_size(source)
            total += size
            largest = max(largest, max_file)
            planned.append({"source": source, "destination": destination, "size": size})
        return {"drive": drive, "destination_root": destination_root, "source_count": len(sources),
                "duplicate_count": duplicates, "copy_count": len(planned), "total_bytes": total,
                "largest_file": largest, "items": planned}

    def preview(self, data: dict) -> dict:
        unit_price = round(float(data.get("unit_price") or 0), 2)
        if unit_price < 0:
            raise ValueError("Oyun fiyatı negatif olamaz.")
        plan = self.build_plan(data)
        public = self.public_plan(plan, unit_price)
        public["filesystem"] = self._filesystem(plan["drive"])
        public["fat32_blocked"] = public["filesystem"] == "FAT32" and int(plan["largest_file"]) > 4 * 1024 ** 3
        return public

    def transfer(self, data: dict) -> dict:
        with self.lock:
            current = self._load_transaction()
            if current and current.get("status") in {"pending", "submitting", "uncertain"}:
                raise RuntimeError("Önce bekleyen oyun USB satışını onaylayın veya iptal edin.")
            unit_price = round(float(data.get("unit_price") or 0), 2)
            if unit_price < 0:
                raise ValueError("Oyun fiyatı negatif olamaz.")
            payment = str(data.get("payment_method") or "CASH").upper()
            if payment not in PAYMENTS:
                raise ValueError("Ödeme şekli yalnız Nakit veya Kart olabilir.")
            plan = self.build_plan(data)
            if self._filesystem(plan["drive"]) == "FAT32" and int(plan["largest_file"]) > 4 * 1024 ** 3:
                raise RuntimeError("Seçimde 4 GB'dan büyük dosya var; oyun USB'sini exFAT veya NTFS biçimlendirin.")
            if int(plan["total_bytes"]) + 64 * 1024 * 1024 > shutil.disk_usage(plan["drive"]).free:
                raise RuntimeError("USB'de seçilen oyunlar için yeterli boş alan yok.")
            copied_paths, errors = [], []
            for item in plan["items"]:
                source, destination = item["source"], item["destination"]
                temp = destination.with_name("." + destination.name + "." + uuid.uuid4().hex + ".copying")
                try:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if source.is_dir():
                        shutil.copytree(source, temp)
                        copied_size, _ = self._path_size(temp)
                    else:
                        shutil.copy2(source, temp)
                        copied_size = temp.stat().st_size
                    if copied_size != int(item["size"]):
                        raise IOError("Oyun paketi boyutu doğrulanamadı.")
                    os.replace(temp, destination)
                    copied_paths.append(destination)
                except Exception as exc:
                    errors.append(f"{source.name}: {exc}")
                    if temp.is_dir():
                        shutil.rmtree(temp, ignore_errors=True)
                    else:
                        temp.unlink(missing_ok=True)
            copied = len(copied_paths)
            transaction = None
            if copied:
                transaction = {"id": uuid.uuid4().hex, "status": "pending", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                               "drive": str(plan["drive"]), "destination_root": str(plan["destination_root"]),
                               "files": [str(path.relative_to(plan["drive"])) for path in copied_paths], "copied": copied,
                               "duplicates": int(plan["duplicate_count"]), "failed": len(errors), "unit_price": unit_price,
                               "total_price": round(copied * unit_price, 2), "payment_method": payment, "sale_id": None}
                self._save_transaction(transaction)
            return {**self.public_plan(plan, unit_price), "copied": copied, "failed": len(errors), "errors": errors[:20], "transaction": transaction}

    def confirm_sale(self, transaction_id: str) -> dict:
        with self.lock:
            tx = self._load_transaction()
            if not tx or tx.get("id") != str(transaction_id or ""):
                raise ValueError("Bekleyen oyun USB satışı bulunamadı.")
            if tx.get("status") == "completed":
                return tx
            if tx.get("status") != "pending":
                raise RuntimeError("Bu satış otomatik yeniden gönderilemez; KafePin Doğrudan Satış listesini kontrol edin.")
            if float(tx.get("total_price") or 0) <= 0:
                raise ValueError("Satış toplamı 0 TL olamaz.")
            tx["status"] = "submitting"
            self._save_transaction(tx)
            payload = json.dumps({"name": f"Oyun USB Satışı • {int(tx['copied'])} oyun", "unitPrice": float(tx["total_price"]), "quantity": 1, "paymentMethod": tx["payment_method"]}, ensure_ascii=False).encode("utf-8")
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

    def cancel_sale(self, transaction_id: str, remove_files: bool = False) -> dict:
        with self.lock:
            tx = self._load_transaction()
            if not tx or tx.get("id") != str(transaction_id or ""):
                raise ValueError("Bekleyen oyun USB satışı bulunamadı.")
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
                    if candidate.is_dir():
                        shutil.rmtree(candidate)
                        removed += 1
                    elif candidate.is_file():
                        candidate.unlink()
                        removed += 1
            tx["status"], tx["cancelled_at"], tx["removed_files"] = "cancelled", time.strftime("%Y-%m-%dT%H:%M:%S"), removed
            self._save_transaction(tx)
            return tx
