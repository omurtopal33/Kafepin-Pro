from __future__ import annotations

import subprocess
from pathlib import Path

from PIL import Image, ImageOps
from pypdf import PdfReader, PdfWriter


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}
WORD_EXTENSIONS = {".doc", ".docx"}
SUPPORTED_EXTENSIONS = {".pdf", *IMAGE_EXTENSIONS, *WORD_EXTENSIONS}


def _hidden_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def image_to_pdf(source: Path, target: Path) -> Path:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        image.save(target, "PDF", resolution=300.0)
    return target


def docx_to_pdf(source: Path, target: Path, script: Path) -> Path:
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-InputPath", str(source), "-OutputPath", str(target)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        creationflags=_hidden_flags(),
    )
    if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
        detail = (result.stderr or result.stdout or "Microsoft Word PDF dönüşümü yapamadı.").strip()[-700:]
        raise RuntimeError("DOCX dönüşümü için bu bilgisayarda Microsoft Word kurulu ve kullanılabilir olmalı. " + detail)
    return target


def source_as_pdf(source: Path, work_dir: Path, word_script: Path) -> Path:
    suffix = source.suffix.lower()
    if suffix == ".pdf":
        return source
    output = work_dir / f"converted_{source.stem}_{source.stat().st_mtime_ns}.pdf"
    if suffix in IMAGE_EXTENSIONS:
        return image_to_pdf(source, output)
    if suffix in WORD_EXTENSIONS:
        return docx_to_pdf(source, output, word_script)
    raise ValueError(f"Desteklenmeyen dosya türü: {source.suffix}")


def merge_to_pdf(sources: list[Path], output: Path, work_dir: Path, word_script: Path) -> int:
    if not sources:
        raise ValueError("Önce en az bir PDF, resim veya DOCX dosyası ekle.")
    writer = PdfWriter()
    page_count = 0
    for source in sources:
        converted = source_as_pdf(source, work_dir, word_script)
        reader = PdfReader(str(converted), strict=False)
        if reader.is_encrypted:
            raise ValueError(f"Parolalı PDF eklenemez: {source.name}")
        for page in reader.pages:
            writer.add_page(page)
            page_count += 1
    if not page_count:
        raise ValueError("Eklenen dosyalarda dönüştürülebilir sayfa bulunamadı.")
    with output.open("wb") as stream:
        writer.write(stream)
    return page_count
