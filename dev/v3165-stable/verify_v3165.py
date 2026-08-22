from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
PACKAGE = ROOT / "KafePin-Pro-Update-v3.1.65.zip"
LATEST = ROOT / "latest.json"
OVERLAYS = ROOT / "dev" / "v3164-final" / "payload" / "component-overlays"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    latest = json.loads(LATEST.read_text(encoding="utf-8-sig"))
    if latest.get("version") != "3.1.65" or latest.get("channel") != "stable" or not latest.get("cumulative"):
        raise SystemExit("latest.json v3.1.65 KÜMÜLATİF STABLE değil")
    if latest.get("sha256") != sha256(PACKAGE):
        raise SystemExit("latest.json SHA uyuşmuyor")
    with zipfile.ZipFile(BASE) as base, zipfile.ZipFile(PACKAGE) as package:
        if package.testzip():
            raise SystemExit("v3.1.65 ZIP CRC hatası")
        current = {item.filename: package.read(item) for item in package.infolist() if not item.is_dir()}
        protected = ("server.js", "services/spinService.js", "utils/fee.js", "public/monitor.html", "public/admin.html", "public/kafepin-pro-yonetim.html")
        for name in protected:
            if current[name] != base.read(name):
                raise SystemExit("Korunan çekirdek değişti: " + name)
        manager = current["KafePin_Manager_Ensure.ps1"].decode("utf-8-sig")
        updater = current["KafePin_Pro_Component_Update.ps1"].decode("utf-8-sig")
        if "KafePin_Pro_Component_Update.ps1" not in manager or "Sync-SelectedComponent" not in updater:
            raise SystemExit("Seçili PRO bileşen eşitleme kilidi eksik")
        server = current["server.js"].decode("utf-8-sig")
        if "OPEN_READONLY" not in server or re.search(r"ecm[^\n]{0,180}\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b", server, re.I):
            raise SystemExit("EveryCafe read-only regresyonu")
        info = json.loads(current["update.json"].decode("utf-8-sig"))
        if info.get("version") != "3.1.65" or "Winamp" not in info.get("notes", ""):
            raise SystemExit("Paket metadata/regresyon notu hatalı")
        for component in ("mp3-bot-pro", "yazici-pro", "teknik-servis-pro"):
            nested = zipfile.ZipFile(io.BytesIO(current[f"pro-components/{component}.zip"]))
            if nested.testzip():
                raise SystemExit(component + " CRC hatası")
            overlay = OVERLAYS / component
            for file in overlay.rglob("*"):
                if file.is_file() and "__pycache__" not in file.parts:
                    rel = file.relative_to(overlay).as_posix()
                    if nested.read(rel) != file.read_bytes():
                        raise SystemExit(f"PRO overlay eşleşmiyor: {component}/{rel}")
        mp3 = zipfile.ZipFile(io.BytesIO(current["pro-components/mp3-bot-pro.zip"]))
        app = mp3.read("web/app.js").decode("utf-8-sig")
        for marker in ("v2.34.32 PRATİK GEZGİN", "mp3ScrollTop", "isActiveTrack", "contextmenu", "searchKey"):
            if marker not in app:
                raise SystemExit("MP3 kilit marker eksik: " + marker)
    print("V3165_STABLE_VERIFY_OK", sha256(PACKAGE), "OPEN_READONLY")


if __name__ == "__main__":
    main()
