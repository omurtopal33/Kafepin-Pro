from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.66.zip"
SHA_OUT = ROOT / "KafePin-Pro-Update-v3.1.66.sha256.txt"
LATEST = ROOT / "latest.json"
NOTES = ROOT / "RELEASE_NOTES-v3.1.66.md"
OVERLAYS = ROOT / "dev" / "v3164-final" / "payload" / "component-overlays"
COMPONENT_UPDATER = HERE / "KafePin_Pro_Component_Update.ps1"
WORK = HERE / ".build-work"
VERSION = "3.1.66"
FIXED_DT = (2026, 8, 22, 18, 0, 0)


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


def overlay_component(stage: Path, component: str) -> None:
    archive = stage / "pro-components" / f"{component}.zip"
    overlay = OVERLAYS / component
    if not archive.is_file() or not overlay.is_dir():
        raise RuntimeError(f"PRO bileşeni eksik: {component}")
    unpacked = WORK / component
    unpacked.mkdir(parents=True)
    with zipfile.ZipFile(archive) as source:
        source.extractall(unpacked)
    for source in overlay.rglob("*"):
        if source.is_file() and "__pycache__" not in source.parts:
            target = unpacked / source.relative_to(overlay)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    zip_tree(unpacked, archive)


def metadata(files: list[str], base_sha: str) -> dict[str, object]:
    return {
        "version": VERSION,
        "channel": "stable",
        "finalStable": True,
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "futureUpdateBase": "3.1.64",
        "cumulative": True,
        "sourceVersion": "3.1.64",
        "sourceSha256": base_sha,
        "publishedAt": "2026-08-22T18:00:00+03:00",
        "notes": "v3.1.66 KÜMÜLATİF STABLE: mevcut EveryCafe kullanan kafelerde kurulu varsayılan kaynak otomatik korunur; EveryCafe ve Client Yönetim PRO menüleri eksik yerel seçim kaydı yüzünden gizlenmez. Yeni kafe kurulumunda seçimli yapı aynen korunur; seçilmeyen EveryCafe/Client görünmez. MP3/Winamp ve USB aktarım geliştirmeleri v3.1.65 ile birlikte korunur. EveryCafe DB yalnız okunur; çekirdek, finans, spin/session, Telegram ve 20:00 gün sonu değiştirilmedi.",
        "files": files,
    }


def main() -> None:
    if not BASE.is_file():
        raise FileNotFoundError(BASE)
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    try:
        stage = WORK / "update"
        with zipfile.ZipFile(BASE) as source:
            source.extractall(stage)
        base_sha = sha256(BASE)
        for component in ("mp3-bot-pro", "yazici-pro", "teknik-servis-pro"):
            overlay_component(stage, component)
        shutil.copy2(ROOT / "dev" / "v3164-final" / "payload" / "desktop-app" / "KafePinProDesktop.cs", stage / "desktop-app" / "KafePinProDesktop.cs")
        shutil.copy2(COMPONENT_UPDATER, stage / "KafePin_Pro_Component_Update.ps1")
        manager = stage / "KafePin_Manager_Ensure.ps1"
        manager_text = manager.read_text(encoding="utf-8-sig")
        manager_text += (
            "\n# v3.1.66: yalnız önceden seçilmiş bağımsız PRO program dosyalarını eşitle.\n"
            "$proUpdater = Join-Path $InstallRoot 'KafePin_Pro_Component_Update.ps1'\n"
            "if (Test-Path -LiteralPath $proUpdater) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $proUpdater -InstallRoot $InstallRoot -ProRoot 'C:\\KafePinPro' }\n"
        )
        manager.write_text(manager_text, encoding="utf-8-sig", newline="\r\n")

        files = sorted(
            item.relative_to(stage).as_posix()
            for item in stage.rglob("*")
            if item.is_file() and item.name not in {"update.json", "kafepin-pro-version.json"}
        )
        raw = json.dumps(metadata(files, base_sha), ensure_ascii=False, indent=2) + "\n"
        for name in ("update.json", "kafepin-pro-version.json"):
            (stage / name).write_text(raw, encoding="utf-8")
        zip_tree(stage, OUT)
    finally:
        shutil.rmtree(WORK, ignore_errors=True)

    digest = sha256(OUT)
    SHA_OUT.write_text(f"{digest}  {OUT.name}\n", encoding="ascii")
    latest = metadata([], base_sha)
    latest.update({
        "downloadUrl": "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.66.zip",
        "sha256": digest,
    })
    LATEST.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    NOTES.write_text(
        "# KafePin Pro v3.1.66 — KÜMÜLATİF STABLE\n\n"
        "## Kilitlenen çalışma\n\n"
        "- MP3 Bot PRO: Winamp kalıcı klasör gezgini, klavye kontrolü, seçili/çalan parça vurgusu, FLAC/WMA görünümü ve Türkçe hızlı arama.\n"
        "- Favori Listem: gerçek dosya kopyası ile yıldız ekle/çıkar davranışı korunur.\n"
        "- USB MP3 / Film / Oyun: kalıcı arşiv kısayolları, güvenli sağ tıkla kısayol kaldırma, medya başlık eşleştirmesi ve aktarım hazırlığı korunur.\n"
        "- Yazıcı PRO ve Teknik Servis PRO: v3.1.64'te çalışan paketleriyle tekrar paketlenmiştir.\n\n"
        "## Korunan çekirdek\n\n"
        "- server.js, finans, spin/session, EveryCafe erişimi, Telegram ve 20:00 gün sonu v3.1.64 ile byte-for-byte korunur.\n"
        "- EveryCafe erişimi salt-okunur kalır.\n\n"
        f"Paket SHA-256: `{digest}`\n",
        encoding="utf-8",
    )
    print(f"V3165_STABLE_BUILD_OK {digest} {OUT.stat().st_size}")


if __name__ == "__main__":
    main()
