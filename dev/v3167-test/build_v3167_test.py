from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = ROOT / "KafePin-Pro-Update-v3.1.66.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.68-TEST.zip"
SHA_OUT = ROOT / "KafePin-Pro-Update-v3.1.68-TEST.sha256.txt"
TEST_LATEST = ROOT / "latest-test.json"
OVERLAY = ROOT / "dev" / "v3164-final" / "payload" / "component-overlays" / "mp3-bot-pro"
WORK = HERE / ".build-work"
LIVE_ROOT = Path(r"C:\KafePin")
VERSION = "3.1.68"
FIXED_DT = (2026, 8, 23, 12, 0, 0)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def zip_tree(root: Path, output: Path) -> None:
    output.unlink(missing_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.relative_to(root).as_posix().lower()):
            info = zipfile.ZipInfo(file.relative_to(root).as_posix(), FIXED_DT)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file.read_bytes())


def metadata(files: list[str], base_sha: str) -> dict[str, object]:
    return {
        "version": VERSION,
        "channel": "test",
        "finalStable": False,
        "stableBase": "3.1.66",
        "baseVersion": "3.1.66",
        "cumulative": True,
        "sourceVersion": "3.1.66",
        "sourceSha256": base_sha,
        "publishedAt": "2026-08-23T12:00:00+03:00",
        "notes": "v3.1.68 TEST: v3.1.67 MP3/Winamp arşiv indeksi, USB arşiv eşitleme ve güvenli PRO bileşen yönetimine ek olarak, ZIP güncellemesinden sonra sunucu sağlığı doğrulanınca KafePin masaüstü uygulamasının gerçek kullanıcı oturumunda otomatik yeniden açılması test edilir. STABLE kanalına dokunulmadı.",
        "files": files,
    }


def main() -> None:
    if not BASE.is_file() or not OVERLAY.is_dir():
        raise FileNotFoundError("v3.1.66 tabanı veya MP3 overlay bulunamadı")
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    try:
        stage = WORK / "update"
        with zipfile.ZipFile(BASE) as source:
            source.extractall(stage)
        # v3.1.67 TEST: Yönetim Merkezi sadece bağımsız PRO bileşenlerini
        # güvenli ekleme/onarım/kaldırma için genişletilir.
        for relative in ("server.js", "public/kafepin-pro-yonetim.html", "KafePin_Pro_Component_Manager.ps1", "KafePin_Desktop_Action.ps1"):
            source = LIVE_ROOT / relative
            if not source.is_file():
                raise FileNotFoundError(f"Canlı yönetim dosyası bulunamadı: {source}")
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        component = stage / "pro-components" / "mp3-bot-pro.zip"
        unpacked = WORK / "mp3-bot-pro"
        with zipfile.ZipFile(component) as source:
            source.extractall(unpacked)
        for source in OVERLAY.rglob("*"):
            if source.is_file() and "__pycache__" not in source.parts:
                target = unpacked / source.relative_to(OVERLAY)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        zip_tree(unpacked, component)
        files = sorted(item.relative_to(stage).as_posix() for item in stage.rglob("*") if item.is_file() and item.name not in {"update.json", "kafepin-pro-version.json"})
        raw = json.dumps(metadata(files, sha256(BASE)), ensure_ascii=False, indent=2) + "\n"
        for name in ("update.json", "kafepin-pro-version.json"):
            (stage / name).write_text(raw, encoding="utf-8")
        zip_tree(stage, OUT)
    finally:
        shutil.rmtree(WORK, ignore_errors=True)
    digest = sha256(OUT)
    SHA_OUT.write_text(f"{digest}  {OUT.name}\n", encoding="ascii")
    info = metadata([], sha256(BASE))
    info.update({
        "available": True,
        "downloadUrl": "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/test/v3.1.67-mp3-search/KafePin-Pro-Update-v3.1.68-TEST.zip",
        "sha256": digest,
    })
    TEST_LATEST.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"V3168_TEST_BUILD_OK {digest} {OUT.stat().st_size}")


if __name__ == "__main__":
    main()
