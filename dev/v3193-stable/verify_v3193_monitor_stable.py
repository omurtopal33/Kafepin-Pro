from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path


ROOT = Path(r"C:\KafePin")
BASE = ROOT / ".publish-v3191" / "KafePin-Pro-Update-v3.1.92.zip"
PACKAGE = ROOT / "KafePin-Pro-Update-v3.1.93.zip"
LATEST = ROOT / "latest-v3.1.93.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require(text: str, marker: str, area: str) -> None:
    if marker not in text:
        raise SystemExit(f"{area} marker missing: {marker}")


def main() -> None:
    if not BASE.is_file() or not PACKAGE.is_file() or not LATEST.is_file():
        raise SystemExit("v3.1.93 verification inputs are missing")
    latest = json.loads(LATEST.read_text(encoding="utf-8-sig"))
    digest = sha256(PACKAGE)
    if latest.get("version") != "3.1.93" or latest.get("channel") != "stable" or latest.get("finalStable") is not True:
        raise SystemExit("latest candidate is not v3.1.93 STABLE")
    if latest.get("sha256") != digest:
        raise SystemExit("latest candidate SHA mismatch")

    with zipfile.ZipFile(PACKAGE) as archive:
        if archive.testzip():
            raise SystemExit("v3.1.93 ZIP CRC failure")
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}

    required = {
        "server.js", "public/monitor.html", "public/admin.html", "update.json",
        "kafepin-pro-version.json", "desktop-app/KafePinProDesktop.cs",
        "desktop-app/desktop-app-version.json", "desktop-app/KafePin.ico",
    }
    missing = required - files.keys()
    if missing:
        raise SystemExit("Required package files missing: " + ", ".join(sorted(missing)))

    update = json.loads(files["update.json"].decode("utf-8-sig"))
    if update.get("version") != "3.1.93" or update.get("cumulative") is not True:
        raise SystemExit("v3.1.93 package metadata mismatch")

    # All untouched critical payloads remain byte-for-byte the v3.1.92 STABLE ones.
    with zipfile.ZipFile(BASE) as base:
        for name in (
            "services/spinService.js", "utils/fee.js", "public/kafepin-pro-yonetim.html",
            "public/everycafe-reconcile.html", "pro-components/mp3-bot-pro.zip",
            "pro-components/yazici-pro.zip", "pro-components/teknik-servis-pro.zip",
            "pro-components/client-yonetim-pro.zip",
        ):
            if files.get(name) != base.read(name):
                raise SystemExit("Protected v3.1.92 payload changed: " + name)

    for name in ("mp3-bot-pro.zip", "yazici-pro.zip", "teknik-servis-pro.zip", "client-yonetim-pro.zip"):
        nested = zipfile.ZipFile(io.BytesIO(files["pro-components/" + name]))
        if nested.testzip():
            raise SystemExit("Nested component CRC failure: " + name)

    server = files["server.js"].decode("utf-8-sig")
    monitor = files["public/monitor.html"].decode("utf-8-sig")
    admin = files["public/admin.html"].decode("utf-8-sig")
    desktop = files["desktop-app/KafePinProDesktop.cs"].decode("utf-8-sig")

    # EveryCafe stays strictly read-only; the only server change is a local monitor
    # display marker after the existing immediate close/finalize flow.
    if len(re.findall(r"new sqlite3\.Database\(EVERYCAFE_DB_PATH,\s*sqlite3\.OPEN_READONLY", server)) < 1:
        raise SystemExit("EveryCafe OPEN_READONLY contract missing")
    forbidden = re.findall(r"ecm[^\n]{0,180}\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b", server, flags=re.I)
    if forbidden:
        raise SystemExit("Potential EveryCafe write marker found")
    for marker in ("EVERYCAFE_UNTIMED_MONITOR_HOLD_MS", "EVERYCAFE_TIMED_MONITOR_HOLD_MS", "everyCafeRecentlyClosedMasalar"):
        require(server, marker, "SERVER")

    for marker in (
        "EVERYCAFE_UNTIMED_CLOSE_HOLD_MS", "EVERYCAFE_TIMED_CLOSE_HOLD_MS",
        "actualContentHeight", "heldCard.live", "m.freeClosed",
    ):
        require(monitor, marker, "MONITOR")
    if "HESAP KAPANDI" in monitor or "KAPANIŞ DOĞRULANIYOR" in monitor:
        raise SystemExit("Monitor must retain the last real card, not add a closure card")

    for marker in ("adminPanelStorageKey", "adminPanelScrollStorageKey", "adminPanelScrollSaveTimer", "visibilitychange"):
        require(admin, marker, "ADMIN")
    require(desktop, "StopProComponentProcessesAsync()", "DESKTOP")
    require(desktop, "C:\\KafePinPro\\", "DESKTOP")
    print("V3193_STABLE_VERIFY_OK", digest, "OPEN_READONLY")


if __name__ == "__main__":
    main()
