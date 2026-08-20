from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory

from config import APP_DIR, APP_NAME, documents_dir, load_config, save_config
from document_engine import apply_adjustments, build_identity, build_normal, build_photo_sheet
from pdf_engine import SUPPORTED_EXTENSIONS, merge_to_pdf


APP_VERSION = "3.1.48-cumulative"
# Resim Tarama API rotaları bu yerel servis içinde çalışır.
PORT = 17891
WEB_DIR = APP_DIR / "web"
PS_WIA = APP_DIR / "wia_bridge.ps1"
PS_PRINT = APP_DIR / "print_image.ps1"
PS_OPEN_FOLDER = APP_DIR / "open_folder.ps1"
PS_DOCX_TO_PDF = APP_DIR / "convert_docx_to_pdf.ps1"
TEMP_ROOT = Path(tempfile.gettempdir()) / "KafePinYaziciPRO"


def _hidden_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run_powershell(script: Path, *args: str, timeout: int = 90) -> str:
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), *map(str, args)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=_hidden_flags())
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Windows işlem hatası.").strip()[-900:])
    return (result.stdout or "").strip()


def _windows_printers() -> list[dict]:
    script = "Get-CimInstance Win32_Printer | Sort-Object Name | Select-Object Name,Default,DriverName,PortName | ConvertTo-Json -Compress"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=_hidden_flags())
    if result.returncode != 0:
        return _registered_windows_printers()
    try:
        data = json.loads(result.stdout or "[]")
        if isinstance(data, dict):
            data = [data]
        printers = [{"name": str(x.get("Name") or ""), "default": bool(x.get("Default")), "driver": str(x.get("DriverName") or ""), "port": str(x.get("PortName") or "")} for x in data if x.get("Name")]
        return printers or _registered_windows_printers()
    except Exception:
        return _registered_windows_printers()


def _registered_windows_printers() -> list[dict]:
    """CIM erişimi engellense bile oturumdaki Windows yazıcılarını oku."""
    try:
        import winreg
        device_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Devices")
        devices: dict[str, str] = {}
        index = 0
        while True:
            try:
                name, port, _ = winreg.EnumValue(device_key, index)
                devices[str(name)] = str(port)
                index += 1
            except OSError:
                break
        default = ""
        try:
            windows_key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Windows")
            default = str(winreg.QueryValueEx(windows_key, "Device")[0]).split(",")[0].strip()
        except OSError:
            pass
        return [{"name": name, "default": name.casefold() == default.casefold(), "driver": "Windows yazıcı", "port": port.split(",")[-1]} for name, port in sorted(devices.items())]
    except Exception:
        return []


def _available_document_path(folder: Path, stem: str, suffix: str) -> Path:
    candidate = folder / f"{stem}{suffix}"
    number = 2
    while candidate.exists():
        candidate = folder / f"{stem} ({number}){suffix}"
        number += 1
    return candidate


class PrintCore:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.cfg = load_config()
        self.job_dir: Path | None = None
        self.identity: dict[str, Path] = {}
        self.normal_pages: list[Path] = []
        self.photo_pages: list[Path] = []
        self.preview: Path | None = None
        self.pdf: Path | None = None
        self.convert_files: list[dict[str, str]] = []
        self.convert_dir: Path | None = None
        self.status = "Hazır — tarayıcı ve yazıcı seç."

    def _ensure_job(self) -> Path:
        if self.job_dir and self.job_dir.exists():
            return self.job_dir
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.job_dir = TEMP_ROOT / f"job_{uuid.uuid4().hex}"
        self.job_dir.mkdir(parents=True, exist_ok=False)
        return self.job_dir

    def _reset_preview(self) -> None:
        self.preview = None
        self.pdf = None

    def devices(self) -> dict:
        scanners = []
        scanner_error = ""
        try:
            raw = _run_powershell(PS_WIA, "-Mode", "list", timeout=12)
            parsed = json.loads(raw or "[]")
            scanners = parsed if isinstance(parsed, list) else [parsed]
        except Exception as exc:
            scanner_error = str(exc)
        return {"printers": _windows_printers(), "scanners": scanners, "scanner_error": scanner_error}

    def config(self, updates: dict | None = None) -> dict:
        with self.lock:
            if updates:
                for key in ("printer", "scanner_id", "dpi", "color_mode", "identity_layout"):
                    if key in updates:
                        self.cfg[key] = updates[key]
                self.cfg["dpi"] = max(75, min(600, int(self.cfg.get("dpi") or 300)))
                self.cfg["color_mode"] = "gray" if self.cfg.get("color_mode") == "gray" else "color"
                self.cfg["identity_layout"] = "vertical" if self.cfg.get("identity_layout") == "vertical" else "side_by_side"
                self.cfg = save_config(self.cfg)
            return dict(self.cfg)

    def scan(self, side: str, data: dict) -> dict:
        side = str(side or "").lower()
        if side not in {"front", "back", "normal", "photo"}:
            raise ValueError("Geçersiz tarama türü.")
        scanner_id = str(data.get("scanner_id") or self.cfg.get("scanner_id") or "").strip()
        if not scanner_id:
            raise ValueError("Önce Windows listesinden tarayıcı seç.")
        dpi = max(75, min(600, int(data.get("dpi") or self.cfg.get("dpi") or 300)))
        # Kimlikte küçük yazıların okunabilir kalması için kullanıcı arayüzünde
        # daha düşük DPI seçilse bile tarama 600 DPI alınır.
        if side in {"front", "back"}:
            dpi = 600
        color_mode = "gray" if str(data.get("color_mode") or self.cfg.get("color_mode")) == "gray" else "color"
        with self.lock:
            job = self._ensure_job()
            path = job / f"scan_{side}_{int(time.time())}_{uuid.uuid4().hex[:6]}.bmp"
            self.status = "Tarayıcıdan görüntü alınıyor…"
        _run_powershell(PS_WIA, "-Mode", "scan", "-DeviceId", scanner_id, "-Dpi", str(dpi), "-ColorMode", color_mode, "-Output", str(path), timeout=120)
        if not path.exists() or path.stat().st_size <= 0:
            raise RuntimeError("Tarayıcı görüntü üretmedi.")
        png = path.with_suffix(".png")
        from PIL import Image, ImageOps
        with Image.open(path) as source:
            source.convert("RGB").save(png, "PNG", optimize=True)
        try:
            path.unlink()
        except Exception:
            pass
        apply_adjustments(png, grayscale=(color_mode == "gray"))
        with self.lock:
            if side == "normal":
                self.normal_pages.append(png)
                self.status = f"Normal tarama eklendi — {len(self.normal_pages)} sayfa"
            elif side == "photo":
                self.photo_pages.append(png)
                self.status = f"Resim eklendi — {len(self.photo_pages)} resim"
            else:
                self.identity[side] = png
                self.status = "Kimlik ön ve arka yüzü hazır." if len(self.identity) == 2 else "Tarama alındı — diğer yüzü tara."
            self._reset_preview()
        return self.state()

    def _render(self, mode: str, layout: str | None = None) -> tuple[Path, Path]:
        job = self._ensure_job()
        preview = job / "a4_preview.png"
        pdf = job / "document.pdf"
        if mode == "identity":
            if not self.identity.get("front") or not self.identity.get("back"):
                raise ValueError("Kimliğin ön ve arka yüzünü tara.")
            build_identity(self.identity["front"], self.identity["back"], layout or self.cfg["identity_layout"], preview, pdf)
        elif mode == "normal":
            build_normal(self.normal_pages, preview, pdf)
        elif mode == "photos":
            paper, template, fit = (layout or "A4|4|fit").split("|")
            build_photo_sheet(self.photo_pages, paper, int(template), fit, preview, pdf)
        else:
            raise ValueError("Geçersiz belge modu.")
        self.preview, self.pdf = preview, pdf
        return preview, pdf

    def preview_document(self, mode: str, layout: str | None = None) -> dict:
        with self.lock:
            self._render(mode, layout)
            self.status = "A4 önizleme hazır."
            return self.state()

    def print_document(self, mode: str, data: dict) -> dict:
        printer = str(data.get("printer") or self.cfg.get("printer") or "").strip()
        if not printer:
            raise ValueError("Önce Windows listesinden yazıcı seç.")
        copies = max(1, min(99, int(data.get("copies") or 1)))
        layout = str(data.get("layout") or self.cfg.get("identity_layout") or "side_by_side")
        with self.lock:
            preview, _ = self._render(mode, layout)
            # Normal taramada her kaynak sayfa ayrı Windows yazdırma işi olur.
            # Böylece ADF/multi-page akışında yalnız ilk A4 önizleme basılmaz.
            print_images = list(self.normal_pages) if mode == "normal" else [preview]
            self.status = f"{printer} yazıcısına gönderiliyor…"
        for image in print_images:
            _run_powershell(PS_PRINT, "-ImagePath", str(image), "-PrinterName", printer, "-Copies", str(copies), timeout=90)
        with self.lock:
            page_note = f" ({len(print_images)} sayfa)" if len(print_images) > 1 else ""
            self.status = "Yazdırma Windows kuyruğuna gönderildi" + page_note + ". Geçici görüntüler Kaydet/TEMİZLE ile silinir."
            return self.state()

    def save_document(self, mode: str, data: dict) -> dict:
        kind = str(data.get("kind") or "pdf").lower()
        if kind not in {"pdf", "jpg"}:
            raise ValueError("Yalnız PDF veya JPG kaydedilebilir.")
        if mode not in {"normal", "photos"}:
            raise ValueError("Kimlik fotokopileri kalıcı kaydedilmez.")
        requested_name = str(data.get("name") or "").strip()
        requested_name = "".join(ch for ch in requested_name if ch not in '<>:"/\\|?*' and ord(ch) >= 32).rstrip(". ")[:96]
        if not requested_name:
            raise ValueError("Kaydetmek için geçerli bir dosya adı gir.")
        layout = str(data.get("layout") or self.cfg.get("identity_layout") or "side_by_side")
        with self.lock:
            preview, pdf = self._render(mode, layout)
            folder = documents_dir()
            prefix = requested_name
            saved: list[Path] = []
            if kind == "pdf":
                target = _available_document_path(folder, prefix, ".pdf")
                shutil.copy2(pdf, target)
                saved.append(target)
            elif mode == "photos" or len(self.normal_pages) == 1:
                target = _available_document_path(folder, prefix, ".jpg")
                from PIL import Image
                with Image.open(preview) as image:
                    image.convert("RGB").save(target, "JPEG", quality=95)
                saved.append(target)
            else:
                from PIL import Image
                for index, source in enumerate(self.normal_pages, start=1):
                    target = _available_document_path(folder, f"{prefix}_{index:02d}", ".jpg")
                    with Image.open(source) as image:
                        image.convert("RGB").save(target, "JPEG", quality=95)
                    saved.append(target)
            self.status = f"{len(saved)} dosya Belgeler\\KafePin Belgeler içine kaydedildi."
            return {**self.state(), "saved": [str(path) for path in saved]}

    def clear(self) -> dict:
        with self.lock:
            path = self.job_dir
            self.job_dir = None
            self.identity = {}
            self.normal_pages = []
            self.photo_pages = []
            self.preview = None
            self.pdf = None
            self.status = "Geçici taramalar silindi."
        if path:
            shutil.rmtree(path, ignore_errors=True)
        return self.state()

    def reorder_photos(self, order: list[int]) -> dict:
        with self.lock:
            if sorted(order) != list(range(len(self.photo_pages))):
                raise ValueError("Resim sırası geçersiz.")
            self.photo_pages = [self.photo_pages[index] for index in order]
            self._reset_preview()
            self.status = "Resim sırası güncellendi."
            return self.state()

    def add_photo_uploads(self, uploads) -> dict:
        from PIL import Image, ImageOps
        accepted = 0
        with self.lock:
            job = self._ensure_job()
            for upload in uploads:
                if not upload or not upload.filename:
                    continue
                target = job / f"photo_import_{uuid.uuid4().hex[:8]}.png"
                try:
                    with Image.open(upload.stream) as image:
                        ImageOps.exif_transpose(image).convert("RGB").save(target, "PNG", optimize=True)
                    self.photo_pages.append(target)
                    accepted += 1
                except Exception:
                    target.unlink(missing_ok=True)
            if not accepted:
                raise ValueError("Geçerli bir JPG, PNG veya diğer resim dosyası seç.")
            self._reset_preview()
            self.status = f"Bilgisayardan {accepted} resim eklendi — toplam {len(self.photo_pages)} resim"
            return self.state()

    def open_folder(self) -> dict:
        folder = documents_dir()
        _run_powershell(PS_OPEN_FOLDER, "-Folder", str(folder), timeout=12)
        with self.lock:
            self.status = "KafePin Belgeler klasörü açıldı ve öne getirildi."
        return self.state()

    def _ensure_convert_dir(self) -> Path:
        if self.convert_dir and self.convert_dir.exists():
            return self.convert_dir
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.convert_dir = TEMP_ROOT / f"convert_{uuid.uuid4().hex}"
        self.convert_dir.mkdir(parents=True, exist_ok=False)
        return self.convert_dir

    @staticmethod
    def _safe_name(value: str) -> str:
        return "".join(ch for ch in str(value or "") if ch not in '<>:\"/\\|?*' and ord(ch) >= 32).rstrip(". ")[:96]

    def add_convert_uploads(self, uploads) -> dict:
        accepted: list[str] = []
        rejected: list[str] = []
        with self.lock:
            folder = self._ensure_convert_dir()
            for upload in uploads:
                name = self._safe_name(getattr(upload, "filename", ""))
                suffix = Path(name).suffix.lower()
                if not name or suffix not in SUPPORTED_EXTENSIONS:
                    rejected.append(name or "adsız dosya")
                    continue
                target = folder / f"source_{uuid.uuid4().hex[:12]}{suffix}"
                upload.save(target)
                if target.stat().st_size <= 0:
                    target.unlink(missing_ok=True)
                    rejected.append(name)
                    continue
                if target.stat().st_size > 100 * 1024 * 1024:
                    target.unlink(missing_ok=True)
                    rejected.append(name + " (100 MB sınırı)")
                    continue
                self.convert_files.append({"id": target.stem, "name": name, "path": str(target), "type": suffix[1:].upper()})
                accepted.append(name)
            if not accepted:
                raise ValueError("Geçerli PDF, JPG, PNG, TIFF, WEBP, DOC veya DOCX dosyası seç.")
            self.status = f"Dönüştürme listesine {len(accepted)} dosya eklendi."
            return {**self.state(), "convert_files": self.convert_files, "rejected": rejected}

    def reorder_convert_files(self, order: list[str]) -> dict:
        with self.lock:
            current = {item["id"]: item for item in self.convert_files}
            if len(order) != len(current) or set(order) != set(current):
                raise ValueError("Dosya sırası geçersiz.")
            self.convert_files = [current[item_id] for item_id in order]
            self.status = "Dönüştürme sırası güncellendi."
            return {**self.state(), "convert_files": self.convert_files}

    def remove_convert_file(self, item_id: str) -> dict:
        with self.lock:
            remaining = []
            removed = False
            for item in self.convert_files:
                if item["id"] == item_id:
                    Path(item["path"]).unlink(missing_ok=True)
                    removed = True
                else:
                    remaining.append(item)
            if not removed:
                raise ValueError("Dosya listede bulunamadı.")
            self.convert_files = remaining
            self.status = "Dosya dönüştürme listesinden çıkarıldı."
            return {**self.state(), "convert_files": self.convert_files}

    def compose_convert_pdf(self, data: dict) -> dict:
        requested_name = self._safe_name(data.get("name") or "")
        if not requested_name:
            raise ValueError("PDF için geçerli bir dosya adı gir.")
        with self.lock:
            if not self.convert_files:
                raise ValueError("Önce dosya ekle.")
            folder = self._ensure_convert_dir()
            sources = [Path(item["path"]) for item in self.convert_files]
            target = _available_document_path(documents_dir(), requested_name, ".pdf")
            self.status = "Dosyalar PDF'e çevriliyor ve birleştiriliyor…"
        pages = merge_to_pdf(sources, target, folder, PS_DOCX_TO_PDF)
        with self.lock:
            self.status = f"{len(sources)} dosya, {pages} sayfa olarak tek PDF'e çevrildi ve kaydedildi."
            return {**self.state(), "saved": [str(target)], "page_count": pages}

    def clear_convert_files(self) -> dict:
        with self.lock:
            folder = self.convert_dir
            self.convert_dir = None
            self.convert_files = []
            self.status = "Dönüştürme listesi temizlendi."
        if folder:
            shutil.rmtree(folder, ignore_errors=True)
        return {**self.state(), "convert_files": []}

    def state(self) -> dict:
        with self.lock:
            return {"ok": True, "version": APP_VERSION, "status": self.status, "config": dict(self.cfg), "identity": {key: True for key in self.identity}, "normal_page_count": len(self.normal_pages), "photo_count": len(self.photo_pages), "convert_files": self.convert_files, "has_preview": bool(self.preview and self.preview.exists())}


core = PrintCore()
app = Flask(__name__, static_folder=None)


@app.after_request
def headers(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["X-KafePin-Yazici-Isolation"] = "separate-loopback-service"
    return response


@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/web/<path:name>")
def assets(name: str):
    return send_from_directory(WEB_DIR, name)


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": APP_NAME, "version": APP_VERSION, "isolation": "KafePin core/DB/session access yok"})


@app.get("/api/state")
def state():
    return jsonify(core.state())


@app.get("/api/devices")
def devices():
    return jsonify({"ok": True, **core.devices()})


@app.post("/api/config")
def config():
    return jsonify({"ok": True, "config": core.config(request.get_json(silent=True) or {})})


@app.post("/api/scan/<side>")
def scan(side: str):
    try:
        return jsonify(core.scan(side, request.get_json(silent=True) or {}))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/document/preview")
def preview():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.preview_document(str(data.get("mode") or ""), str(data.get("layout") or "")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/preview")
def preview_file():
    if not core.preview or not core.preview.exists():
        return jsonify({"ok": False, "error": "Önizleme henüz hazırlanmadı."}), 404
    return send_file(core.preview, mimetype="image/png", max_age=0)


@app.post("/api/document/print")
def print_document():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.print_document(str(data.get("mode") or ""), data))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/document/save")
def save_document():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.save_document(str(data.get("mode") or ""), data))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/document/clear")
def clear_document():
    return jsonify(core.clear())


@app.post("/api/photos/reorder")
def reorder_photos():
    try:
        return jsonify(core.reorder_photos(list((request.get_json(silent=True) or {}).get("order") or [])))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/photos/upload")
def upload_photos():
    try:
        return jsonify(core.add_photo_uploads(request.files.getlist("images")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/convert/upload")
def upload_convert_files():
    try:
        return jsonify(core.add_convert_uploads(request.files.getlist("files")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/convert/reorder")
def reorder_convert_files():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.reorder_convert_files(list(data.get("order") or [])))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/convert/remove")
def remove_convert_file():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.remove_convert_file(str(data.get("id") or "")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/convert/compose")
def compose_convert_pdf():
    try:
        return jsonify(core.compose_convert_pdf(request.get_json(silent=True) or {}))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/convert/clear")
def clear_convert_files():
    return jsonify(core.clear_convert_files())


@app.post("/api/documents/open-folder")
def open_folder():
    return jsonify(core.open_folder())


if __name__ == "__main__":
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
