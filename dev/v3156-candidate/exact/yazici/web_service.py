from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
import secrets
import socket
import sys
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory, Response

from config import APP_DIR, APP_NAME, documents_dir, load_config, save_config
from document_engine import apply_adjustments, build_identity, build_normal, build_photo_sheet
from pdf_engine import SUPPORTED_EXTENSIONS, merge_to_pdf


APP_VERSION = "3.1.55-candidate1"
# Resim Tarama API rotaları bu yerel servis içinde çalışır.
PORT = 17891
WEB_DIR = APP_DIR / "web"
PS_WIA = APP_DIR / "wia_bridge.ps1"
PS_PRINT = APP_DIR / "print_image.ps1"
PS_OPEN_FOLDER = APP_DIR / "open_folder.ps1"
PS_DOCX_TO_PDF = APP_DIR / "convert_docx_to_pdf.ps1"
TEMP_ROOT = Path(tempfile.gettempdir()) / "KafePinYaziciPRO"
PROGRAM_DATA = Path(os.environ.get("ProgramData") or r"C:\ProgramData")
AI_SECRET_FILE = PROGRAM_DATA / "KafePinPro" / "secrets" / "openai_api_key.txt"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
AI_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))
import qrcode


def _lan_ipv4() -> str:
    """Yerel ağda telefondan erişilebilecek IPv4 adresini bul; internete veri göndermez."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        value = str(sock.getsockname()[0])
        if value and not value.startswith("127.") and not value.startswith("169.254."):
            return value
    except Exception:
        pass
    finally:
        try: sock.close()
        except Exception: pass
    try:
        for value in socket.gethostbyname_ex(socket.gethostname())[2]:
            if value and not value.startswith("127.") and not value.startswith("169.254."):
                return value
    except Exception:
        pass
    raise RuntimeError("Yerel ağ IP adresi bulunamadı. Telefon ve ana makinenin aynı ağda olduğundan emin ol.")


def _remote_is_loopback() -> bool:
    value = str(request.remote_addr or "")
    return value in {"127.0.0.1", "::1", "localhost"} or value.startswith("127.")


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


def _safe_stem(value: str, fallback: str = "KafePin_AI_Belge") -> str:
    cleaned = "".join(ch for ch in str(value or "") if ch not in '<>:"/\\|?*' and ord(ch) >= 32).strip().rstrip(". ")[:80]
    return cleaned or fallback


def _openai_api_key() -> str:
    for env_name in ("KAFEPIN_OPENAI_API_KEY", "OPENAI_API_KEY"):
        value = str(os.environ.get(env_name) or "").strip()
        if value:
            return value
    try:
        value = AI_SECRET_FILE.read_text(encoding="utf-8-sig").strip()
        if value:
            return value
    except Exception:
        pass
    raise RuntimeError("AI anahtarı ayarlı değil. KafePin_AI_Ayarla.cmd ile OpenAI API anahtarını sunucu tarafına kaydet.")


def _openai_model() -> str:
    return str(os.environ.get("KAFEPIN_OPENAI_MODEL") or "gpt-5.6-terra").strip()


def _image_data_url(path: Path) -> str:
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((2400, 2400))
        buf = io.BytesIO()
        image.save(buf, "JPEG", quality=90, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _response_text(payload: dict) -> str:
    chunks: list[str] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "output_text" and part.get("text"):
                chunks.append(str(part.get("text")))
    return "\n".join(chunks).strip()


def _openai_image_to_text(path: Path) -> tuple[str, str]:
    prompt = (
        "Bu görseldeki belgeyi mümkün olduğunca birebir metne çevir. Uydurma yapma. "
        "Basılı yazıyı ve el yazısını okumayı dene; satır ve paragraf düzenini koru. "
        "Emin olmadığın her kelimeyi veya kritik değeri çift köşeli parantezle işaretle: [[örnek]]. "
        "İsim, soyisim, T.C. kimlik numarası, tarih, telefon, adres ve tutar gibi kritik alanlarda en küçük tereddütte işaret koy. "
        "Okunamayan bölümü [[OKUNAMADI]] yaz. Açıklama ekleme; yalnızca çıkarılan metni döndür."
    )
    body = {
        "model": _openai_model(),
        "store": False,
        "max_output_tokens": 6000,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": _image_data_url(path), "detail": "high"},
            ],
        }],
    }
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=raw,
        method="POST",
        headers={"Authorization": f"Bearer {_openai_api_key()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:1200]
        except Exception:
            pass
        raise RuntimeError(f"OpenAI isteği başarısız (HTTP {exc.code}). {detail}".strip()) from exc
    except Exception as exc:
        raise RuntimeError(f"OpenAI bağlantısı kurulamadı: {exc}") from exc
    text = _response_text(data)
    if not text:
        raise RuntimeError("AI metin döndürmedi.")
    return text, str(data.get("model") or _openai_model())


def _run_inline_powershell(script: str, timeout: int = 60) -> str:
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, creationflags=_hidden_flags()
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Windows işlemi başarısız.").strip()[-1200:])
    return (result.stdout or "").strip()


def _ps_quote(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _word_export(text: str, stem: str, *, pdf: bool, open_word: bool) -> Path:
    folder = documents_dir()
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = _safe_stem(stem, f"KafePin_AI_Belge_{stamp}")
    if not safe.lower().startswith("kafepin_ai_"):
        safe = "KafePin_AI_" + safe
    txt_path = TEMP_ROOT / f"ai_text_{uuid.uuid4().hex}.txt"
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    txt_path.write_text(text, encoding="utf-8")
    docx_path = _available_document_path(folder, safe, ".docx")
    pdf_path = docx_path.with_suffix(".pdf")
    if pdf and pdf_path.exists():
        pdf_path = _available_document_path(folder, docx_path.stem, ".pdf")
    script = f"""
$ErrorActionPreference='Stop'
$txt=[System.IO.File]::ReadAllText({_ps_quote(txt_path)}, [System.Text.Encoding]::UTF8)
$word=New-Object -ComObject Word.Application
$word.Visible=$false
$doc=$word.Documents.Add()
$doc.Content.Text=$txt
$doc.Content.Font.Name='Calibri'
$doc.Content.Font.Size=11
$doc.SaveAs2({_ps_quote(docx_path)},16)
"""
    if pdf:
        script += f"""
$doc.ExportAsFixedFormat({_ps_quote(pdf_path)},17)
$doc.Close($false)
$word.Quit()
"""
    elif open_word:
        script += """
$word.Visible=$true
$doc.Activate()
"""
    else:
        script += """
$doc.Close($false)
$word.Quit()
"""
    try:
        _run_inline_powershell(script, timeout=90)
    finally:
        txt_path.unlink(missing_ok=True)
    target = pdf_path if pdf else docx_path
    if not target.exists():
        raise RuntimeError("Word belgeyi oluşturamadı. Microsoft Word kurulumunu kontrol et.")
    return target


def _copy_text_to_clipboard(text: str) -> None:
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    txt_path = TEMP_ROOT / f"ai_clip_{uuid.uuid4().hex}.txt"
    txt_path.write_text(text, encoding="utf-8")
    try:
        script = f"$t=[IO.File]::ReadAllText({_ps_quote(txt_path)},[Text.Encoding]::UTF8); Set-Clipboard -Value $t"
        _run_inline_powershell(script, timeout=15)
    finally:
        txt_path.unlink(missing_ok=True)


def _downloads_dir() -> Path:
    profile = Path(os.environ.get("USERPROFILE") or Path.home())
    return profile / "Downloads"


def _recent_download_images() -> list[dict]:
    folder = _downloads_dir()
    rows: list[dict] = []
    try:
        for path in folder.iterdir():
            if not path.is_file() or path.suffix.lower() not in AI_IMAGE_EXTENSIONS:
                continue
            stat = path.stat()
            rows.append({"name": path.name, "size": stat.st_size, "mtime": stat.st_mtime})
    except Exception:
        return []
    rows.sort(key=lambda x: x["mtime"], reverse=True)
    return rows[:30]


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
        self.ai_source: Path | None = None
        self.ai_source_name = ""
        self.ai_text = ""
        self.ai_model = ""
        self.mobile_capture: dict[str, dict] = {}
        if "ai_auto_clear" not in self.cfg:
            self.cfg["ai_auto_clear"] = True
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
                for key in ("printer", "scanner_id", "dpi", "color_mode", "identity_layout", "ai_auto_clear"):
                    if key in updates:
                        self.cfg[key] = updates[key]
                self.cfg["dpi"] = max(75, min(600, int(self.cfg.get("dpi") or 300)))
                self.cfg["color_mode"] = "gray" if self.cfg.get("color_mode") == "gray" else "color"
                self.cfg["identity_layout"] = "vertical" if self.cfg.get("identity_layout") == "vertical" else "side_by_side"
                self.cfg["ai_auto_clear"] = bool(self.cfg.get("ai_auto_clear", True))
                self.cfg = save_config(self.cfg)
            return dict(self.cfg)

    def scan(self, side: str, data: dict) -> dict:
        side = str(side or "").lower()
        if side not in {"front", "back", "normal", "photo", "ai"}:
            raise ValueError("Geçersiz tarama türü.")
        scanner_id = str(data.get("scanner_id") or self.cfg.get("scanner_id") or "").strip()
        if not scanner_id:
            raise ValueError("Önce Windows listesinden tarayıcı seç.")
        dpi = max(75, min(600, int(data.get("dpi") or self.cfg.get("dpi") or 300)))
        # Kimlikte küçük yazıların okunabilir kalması için kullanıcı arayüzünde
        # daha düşük DPI seçilse bile tarama 600 DPI alınır.
        if side in {"front", "back"}:
            dpi = 600
        elif side == "ai":
            dpi = max(300, dpi)
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
            elif side == "ai":
                if self.ai_source and self.ai_source.exists() and self.ai_source != png:
                    self.ai_source.unlink(missing_ok=True)
                self.ai_source = png
                self.ai_source_name = "Tarayıcıdan alınan belge"
                self.ai_text = ""
                self.ai_model = ""
                self.status = "AI için belge tarandı — Metne Çevir hazır."
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

    def share_document(self, mode: str, data: dict) -> dict:
        kind = str(data.get("kind") or "pdf").lower()
        if kind not in {"pdf", "jpg"}:
            raise ValueError("WhatsApp paylaşımı için PDF veya JPG seç.")
        if mode not in {"identity", "normal", "photos"}:
            raise ValueError("Geçersiz paylaşım modu.")
        layout = str(data.get("layout") or self.cfg.get("identity_layout") or "side_by_side")
        with self.lock:
            preview, pdf = self._render(mode, layout)
            job = self._ensure_job()
            share_dir = job / "whatsapp_share"
            share_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            if kind == "pdf":
                target = share_dir / f"KafePin_WhatsApp_{stamp}.pdf"
                shutil.copy2(pdf, target)
                page_count = 1 if mode in {"identity", "photos"} else max(1, len(self.normal_pages))
            else:
                target = share_dir / f"KafePin_WhatsApp_{stamp}.jpg"
                from PIL import Image
                with Image.open(preview) as image:
                    image.convert("RGB").save(target, "JPEG", quality=95)
                page_count = 1
            self.status = "WhatsApp için dosya hazır. Dosya seçili klasör açıldı."
        try:
            subprocess.Popen(["explorer.exe", f"/select,{target}"], creationflags=_hidden_flags())
        except Exception:
            pass
        return {**self.state(), "shared": str(target), "page_count": page_count, "kind": kind}

    def clear(self) -> dict:
        with self.lock:
            path = self.job_dir
            self.job_dir = None
            self.identity = {}
            self.normal_pages = []
            self.photo_pages = []
            self.preview = None
            self.pdf = None
            self.ai_source = None
            self.ai_source_name = ""
            self.ai_text = ""
            self.ai_model = ""
            self.status = "Geçici taramalar ve AI işlem verisi silindi."
        if path:
            shutil.rmtree(path, ignore_errors=True)
        return self.state()

    def _normalize_ai_image(self, source, source_name: str) -> dict:
        from PIL import Image, ImageOps
        with self.lock:
            job = self._ensure_job()
            target = job / f"ai_source_{uuid.uuid4().hex[:10]}.png"
        with Image.open(source) as image:
            ImageOps.exif_transpose(image).convert("RGB").save(target, "PNG", optimize=True)
        with self.lock:
            if self.ai_source and self.ai_source.exists() and self.ai_source != target:
                self.ai_source.unlink(missing_ok=True)
            self.ai_source = target
            self.ai_source_name = str(source_name or "Görsel")[:160]
            self.ai_text = ""
            self.ai_model = ""
            self.status = "AI görseli hazır — Metne Çevir seçilebilir."
        return self.ai_state()

    def ai_upload(self, upload) -> dict:
        if not upload or not upload.filename:
            raise ValueError("Önce bir fotoğraf seç.")
        suffix = Path(upload.filename).suffix.lower()
        if suffix not in AI_IMAGE_EXTENSIONS:
            raise ValueError("AI için JPG, PNG, BMP, TIFF veya WEBP görsel seç.")
        try:
            return self._normalize_ai_image(upload.stream, upload.filename)
        except Exception as exc:
            raise ValueError(f"Görsel açılamadı: {exc}") from exc

    def ai_from_downloads(self, name: str) -> dict:
        base = Path(str(name or "")).name
        if not base or base != str(name or ""):
            raise ValueError("Geçersiz dosya adı.")
        source = _downloads_dir() / base
        if not source.exists() or not source.is_file() or source.suffix.lower() not in AI_IMAGE_EXTENSIONS:
            raise ValueError("Görsel İndirilenler klasöründe bulunamadı.")
        return self._normalize_ai_image(source, source.name)

    def _prune_mobile_capture(self) -> None:
        now = time.time()
        for token in list(self.mobile_capture):
            row = self.mobile_capture.get(token) or {}
            if float(row.get("expires", 0)) < now - 30:
                self.mobile_capture.pop(token, None)

    def mobile_capture_start(self) -> dict:
        with self.lock:
            self._prune_mobile_capture()
            token = secrets.token_urlsafe(24)
            expires = time.time() + 300
            host = _lan_ipv4()
            url = f"http://{host}:{PORT}/mobile/{token}"
            self.mobile_capture[token] = {"expires": expires, "uploaded": False, "used": False, "url": url}
            self.status = "Telefon fotoğrafı bekleniyor — QR kodu aynı ağdaki telefondan okut."
            return {
                "ok": True,
                "token": token,
                "url": url,
                "qr_url": f"/api/ai/mobile-capture/qr?token={token}",
                "expires_in": 300,
            }

    def mobile_capture_row(self, token: str) -> dict:
        key = str(token or "")
        with self.lock:
            self._prune_mobile_capture()
            row = self.mobile_capture.get(key)
            if not row or float(row.get("expires", 0)) < time.time():
                raise ValueError("QR bağlantısının süresi doldu. Yeni QR oluştur.")
            return row

    def mobile_capture_status(self, token: str) -> dict:
        row = self.mobile_capture_row(token)
        with self.lock:
            return {
                "ok": True,
                "uploaded": bool(row.get("uploaded")),
                "source_ready": bool(self.ai_source and self.ai_source.exists()),
                "expires_in": max(0, int(float(row.get("expires", 0)) - time.time())),
            }

    def mobile_capture_qr(self, token: str) -> bytes:
        row = self.mobile_capture_row(token)
        image = qrcode.make(str(row.get("url") or ""))
        out = io.BytesIO()
        image.save(out, format="PNG")
        return out.getvalue()

    def mobile_capture_upload(self, token: str, upload) -> dict:
        row = self.mobile_capture_row(token)
        if bool(row.get("used")):
            raise ValueError("Bu QR bağlantısı daha önce kullanıldı. Yeni QR oluştur.")
        result = self.ai_upload(upload)
        with self.lock:
            row["uploaded"] = True
            row["used"] = True
            row["uploaded_at"] = time.time()
            self.status = "Telefon fotoğrafı alındı — şimdi Metne Çevir seçilebilir."
        return result

    def ai_extract(self) -> dict:
        with self.lock:
            source = self.ai_source
        if not source or not source.exists():
            raise ValueError("Önce Fotoğraf Seç / Çek, Tarayıcıdan Al veya WhatsApp görselini seç.")
        with self.lock:
            self.status = "AI görseli okuyor…"
        text, model = _openai_image_to_text(source)
        with self.lock:
            self.ai_text = text
            self.ai_model = model
            self.status = "AI metni hazır — Word'e aktarmadan önce kontrol et ve düzelt."
        return self.ai_state()

    def ai_set_text(self, text: str) -> dict:
        value = str(text or "").replace("\x00", "").strip()
        if not value:
            raise ValueError("Metin boş olamaz.")
        if len(value) > 100000:
            raise ValueError("Metin çok uzun.")
        with self.lock:
            self.ai_text = value
            self.status = "AI metnindeki düzeltmeler kaydedildi."
        return self.ai_state()

    def ai_state(self) -> dict:
        with self.lock:
            uncertain = len(re.findall(r"\[\[[^\]]+\]\]", self.ai_text or ""))
            return {
                "ok": True,
                "source_ready": bool(self.ai_source and self.ai_source.exists()),
                "source_name": self.ai_source_name,
                "text": self.ai_text,
                "uncertain_count": uncertain,
                "model": self.ai_model,
                "auto_clear": bool(self.cfg.get("ai_auto_clear", True)),
                "api_key_ready": self.ai_key_ready(),
            }

    @staticmethod
    def ai_key_ready() -> bool:
        try:
            _openai_api_key()
            return True
        except Exception:
            return False

    def ai_clear(self) -> dict:
        with self.lock:
            source = self.ai_source
            self.ai_source = None
            self.ai_source_name = ""
            self.ai_text = ""
            self.ai_model = ""
            self.status = "AI görseli ve çıkarılan metin temizlendi."
        if source:
            source.unlink(missing_ok=True)
        return self.ai_state()

    def _ai_text_or_raise(self, text: str | None = None) -> str:
        value = str(text if text is not None else self.ai_text).replace("\x00", "").strip()
        if not value:
            raise ValueError("Önce görseli metne çevir ve metni kontrol et.")
        return value

    def ai_export_word(self, data: dict) -> dict:
        text = self._ai_text_or_raise(data.get("text"))
        name = _safe_stem(data.get("name") or "KafePin_AI_Belge")
        target = _word_export(text, name, pdf=False, open_word=True)
        with self.lock:
            self.ai_text = text
            self.status = f"Word açıldı — {target.name}. Yazdırırsan Belge Hazırlama + çıktı birlikte ücretlendirilir."
            auto_clear = bool(data.get("auto_clear", self.cfg.get("ai_auto_clear", True)))
        result = {"ok": True, "saved": str(target), "name": target.name, "auto_cleared": False}
        if auto_clear:
            self.ai_clear()
            result["auto_cleared"] = True
        return result

    def ai_export_pdf(self, data: dict) -> dict:
        text = self._ai_text_or_raise(data.get("text"))
        name = _safe_stem(data.get("name") or "KafePin_AI_Belge")
        target = _word_export(text, name, pdf=True, open_word=False)
        with self.lock:
            self.ai_text = text
            self.status = f"PDF hazır — {target.name}."
            auto_clear = bool(data.get("auto_clear", self.cfg.get("ai_auto_clear", True)))
        result = {"ok": True, "saved": str(target), "name": target.name, "auto_cleared": False}
        if auto_clear:
            self.ai_clear()
            result["auto_cleared"] = True
        return result

    def ai_whatsapp(self, data: dict) -> dict:
        text = self._ai_text_or_raise(data.get("text"))
        _copy_text_to_clipboard(text)
        with self.lock:
            self.ai_text = text
            self.status = "Metin panoya kopyalandı — WhatsApp Web sekmesinde yapıştırabilirsin."
            auto_clear = bool(data.get("auto_clear", self.cfg.get("ai_auto_clear", True)))
        result = {"ok": True, "clipboard": True, "auto_cleared": False}
        if auto_clear:
            self.ai_clear()
            result["auto_cleared"] = True
        return result

    def open_word_blank(self) -> dict:
        # WINWORD.EXE her kurulumda PATH içinde olmayabilir. Word COM kaydı Office tarafından
        # sistem geneline yapılır ve Word kuruluysa en güvenilir açılış yoludur.
        script = r"""
$ErrorActionPreference='Stop'
$word=New-Object -ComObject Word.Application
$word.Visible=$true
[void]$word.Documents.Add()
$word.Activate()
"""
        try:
            _run_inline_powershell(script, timeout=30)
        except Exception as exc:
            raise RuntimeError(f"Microsoft Word açılamadı. Word kurulumunu/Office COM kaydını kontrol et: {exc}") from exc
        with self.lock:
            self.status = "Microsoft Word açıldı."
        return {"ok": True, "method": "office-com"}

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
            return {"ok": True, "version": APP_VERSION, "status": self.status, "config": dict(self.cfg), "identity": {key: True for key in self.identity}, "normal_page_count": len(self.normal_pages), "photo_count": len(self.photo_pages), "convert_files": self.convert_files, "has_preview": bool(self.preview and self.preview.exists()), "ai_source_ready": bool(self.ai_source and self.ai_source.exists()), "ai_text_ready": bool(self.ai_text)}


core = PrintCore()
app = Flask(__name__, static_folder=None)


@app.before_request
def lan_isolation():
    # Servis 0.0.0.0 üzerinde dinler, fakat LAN'dan yalnız tek kullanımlık /mobile/<token> sayfası erişilebilir.
    # Tüm KafePin/Yazıcı PRO API'leri yalnız bu bilgisayarın loopback arayüzünden kullanılabilir.
    if _remote_is_loopback():
        return None
    if request.path.startswith("/mobile/"):
        return None
    return jsonify({"ok": False, "error": "Bu uç nokta yalnız ana makineden kullanılabilir."}), 403


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


@app.route("/revenue/<path:subpath>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def revenue_proxy(subpath: str):
    target = "http://127.0.0.1:17893/" + str(subpath or "").lstrip("/")
    if request.query_string:
        target += "?" + request.query_string.decode("latin-1")
    body = request.get_data() if request.method not in ("GET", "HEAD") else None
    headers = {"Accept": "application/json"}
    if request.content_type:
        headers["Content-Type"] = request.content_type
    req = urllib.request.Request(target, data=body, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            return Response(data, status=resp.status, content_type=resp.headers.get("Content-Type") or "application/json")
    except urllib.error.HTTPError as exc:
        return Response(exc.read(), status=exc.code, content_type=exc.headers.get("Content-Type") or "application/json")
    except Exception as exc:
        return jsonify({"ok": False, "error": "Yazıcı gelir servisi hazır değil.", "detail": str(exc)}), 503


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


@app.post("/api/document/share")
def share_document():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.share_document(str(data.get("mode") or ""), data))
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


@app.post("/api/ai/mobile-capture/start")
def ai_mobile_start():
    try:
        return jsonify(core.mobile_capture_start())
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/ai/mobile-capture/status")
def ai_mobile_status():
    try:
        return jsonify(core.mobile_capture_status(str(request.args.get("token") or "")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.get("/api/ai/mobile-capture/qr")
def ai_mobile_qr():
    try:
        raw = core.mobile_capture_qr(str(request.args.get("token") or ""))
        return Response(raw, mimetype="image/png", headers={"Cache-Control": "no-store"})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.route("/mobile/<token>", methods=["GET", "POST"])
def mobile_capture(token: str):
    try:
        if request.method == "POST":
            core.mobile_capture_upload(token, request.files.get("image"))
            return """<!doctype html><html lang='tr'><meta name='viewport' content='width=device-width,initial-scale=1'><body style='font-family:system-ui;background:#0f1720;color:#fff;padding:24px'><h2>✅ Fotoğraf gönderildi</h2><p>Telefonu kapatabilirsin. Görsel Yazıcı PRO ekranına geldi.</p></body></html>"""
        row = core.mobile_capture_row(token)
        return """<!doctype html><html lang='tr'><meta name='viewport' content='width=device-width,initial-scale=1'><body style='font-family:system-ui;background:#0f1720;color:#fff;padding:24px'><h2>📸 KafePin Yazıcı PRO</h2><p>Fotoğrafı şimdi çek veya galeriden seç. Dosya yalnız aynı ağdaki ana makineye gönderilir.</p><form method='post' enctype='multipart/form-data'><input name='image' type='file' accept='image/*' capture='environment' required style='display:block;margin:18px 0;font-size:18px'><button type='submit' style='font-size:18px;padding:14px 20px'>FOTOĞRAFI GÖNDER</button></form><p style='opacity:.7'>Bağlantı kısa süreli ve tek kullanımlıktır.</p></body></html>"""
    except Exception as exc:
        return f"<!doctype html><html lang='tr'><meta name='viewport' content='width=device-width,initial-scale=1'><body style='font-family:system-ui;background:#2a1116;color:#fff;padding:24px'><h2>Bağlantı kullanılamıyor</h2><p>{str(exc)}</p></body></html>", 400


@app.get("/api/ai/state")
def ai_state():
    return jsonify(core.ai_state())


@app.get("/api/ai/downloads")
def ai_downloads():
    return jsonify({"ok": True, "folder": str(_downloads_dir()), "files": _recent_download_images()})


@app.get("/api/ai/source")
def ai_source():
    if not core.ai_source or not core.ai_source.exists():
        return jsonify({"ok": False, "error": "AI görseli seçilmedi."}), 404
    return send_file(core.ai_source, mimetype="image/png", max_age=0)


@app.post("/api/ai/upload")
def ai_upload():
    try:
        return jsonify(core.ai_upload(request.files.get("image")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/from-downloads")
def ai_from_downloads():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.ai_from_downloads(str(data.get("name") or "")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/extract")
def ai_extract():
    try:
        return jsonify(core.ai_extract())
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/text")
def ai_text():
    try:
        data = request.get_json(silent=True) or {}
        return jsonify(core.ai_set_text(str(data.get("text") or "")))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/word")
def ai_word():
    try:
        return jsonify(core.ai_export_word(request.get_json(silent=True) or {}))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/pdf")
def ai_pdf():
    try:
        return jsonify(core.ai_export_pdf(request.get_json(silent=True) or {}))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/whatsapp")
def ai_whatsapp():
    try:
        return jsonify(core.ai_whatsapp(request.get_json(silent=True) or {}))
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/ai/clear")
def ai_clear():
    return jsonify(core.ai_clear())


@app.post("/api/ai/open-word")
def ai_open_word():
    try:
        return jsonify(core.open_word_blank())
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post("/api/documents/open-folder")
def open_folder():
    return jsonify(core.open_folder())


if __name__ == "__main__":
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
