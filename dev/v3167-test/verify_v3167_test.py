from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.66.zip"
PACKAGE = ROOT / "KafePin-Pro-Update-v3.1.68-TEST.zip"
TEST_LATEST = ROOT / "latest-test.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    latest = json.loads(TEST_LATEST.read_text(encoding="utf-8-sig"))
    if latest.get("version") != "3.1.68" or latest.get("channel") != "test" or latest.get("sha256") != sha256(PACKAGE):
        raise SystemExit("TEST metadata uyuşmuyor")
    with zipfile.ZipFile(BASE) as base, zipfile.ZipFile(PACKAGE) as package:
        if package.testzip():
            raise SystemExit("TEST ZIP CRC hatası")
        current = {item.filename: package.read(item) for item in package.infolist() if not item.is_dir()}
        # Yönetim Merkezi, yalnız bağımsız PRO bileşen yönetimi için değişebilir.
        # Finans/çark/EveryCafe çekirdeği taban paketten byte-for-byte korunur.
        for name in ("services/spinService.js", "utils/fee.js", "public/monitor.html", "public/admin.html"):
            if current[name] != base.read(name):
                raise SystemExit("Korunan çekirdek değişti: " + name)
        manager = current.get("KafePin_Pro_Component_Manager.ps1", b"").decode("utf-8-sig")
        server = current["server.js"].decode("utf-8-sig")
        panel = current["public/kafepin-pro-yonetim.html"].decode("utf-8-sig")
        for marker in ("KAFEPIN_PRO_COMPONENT_MANAGER", "/admin/pro/components", "OPEN_READONLY"):
            if marker not in server:
                raise SystemExit("Sunucu PRO yönetim / EveryCafe güvenlik marker eksik: " + marker)
        for marker in ("launchKafePinDesktopWindows", "completeUpdateAndReopenDesktopIfNeeded"):
            if marker not in server:
                raise SystemExit("Güncelleme sonrası masaüstü açılış marker eksik: " + marker)
        desktop_action = current.get("KafePin_Desktop_Action.ps1", b"").decode("utf-8-sig")
        if "launch-kafepin" not in desktop_action:
            raise SystemExit("İnteraktif masaüstü başlatma action marker eksik")
        for marker in ("Move-Item", "_kaldirilanlar", "client-yonetim-pro' -and -not $info.everyCafePresent"):
            if marker not in manager:
                raise SystemExit("PRO bileşen yöneticisi güvenlik marker eksik: " + marker)
        for marker in ("PRO Bileşen Yönetimi", "proComponentsBtn", "geri alınabilir"):
            if marker not in panel:
                raise SystemExit("Yönetim Merkezi PRO kartı marker eksik: " + marker)
        app = zipfile.ZipFile(io.BytesIO(current["pro-components/mp3-bot-pro.zip"])).read("web/app.js").decode("utf-8-sig")
        for marker in ("winampSearchRequest", "Yalnız seçili klasörde", "usbBrowserRequest", "rawRenderBrowser"):
            if marker not in app:
                raise SystemExit("MP3 TEST marker eksik: " + marker)
    print("V3167_TEST_VERIFY_OK", sha256(PACKAGE))


if __name__ == "__main__":
    main()
