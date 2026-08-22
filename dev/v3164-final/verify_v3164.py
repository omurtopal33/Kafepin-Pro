from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
SOURCE = ROOT / "KafePin-Pro-Update-v3.1.63.zip"
LATEST = ROOT / "latest.json"
PAYLOAD = Path(__file__).resolve().parent / "payload"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(text: str, marker: str, area: str) -> None:
    if marker not in text:
        raise SystemExit(f"{area} lock marker missing: {marker}")


def main() -> None:
    latest = json.loads(LATEST.read_text(encoding="utf-8-sig"))
    digest = sha256(PACKAGE)
    if latest.get("version") != "3.1.64" or latest.get("channel") != "stable" or latest.get("finalStable") is not True:
        raise SystemExit("latest.json is not v3.1.64 FINAL/STABLE")
    if latest.get("sha256") != digest:
        raise SystemExit("latest.json SHA mismatch")

    with zipfile.ZipFile(PACKAGE) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit("ZIP CRC failure: " + bad)
        names = set(z.namelist())
        for name in ("server.js", "public/admin.html", "desktop-app/KafePinProDesktop.cs", "update.json", "kafepin-pro-version.json"):
            if name not in names:
                raise SystemExit("ZIP required file missing: " + name)
        admin = z.read("public/admin.html").decode("utf-8-sig")
        desktop = z.read("desktop-app/KafePinProDesktop.cs").decode("utf-8-sig")
        server = z.read("server.js").decode("utf-8-sig")
        update = json.loads(z.read("update.json").decode("utf-8-sig"))
        package_bytes = {name: z.read(name) for name in z.namelist() if not name.endswith("/")}

    with zipfile.ZipFile(SOURCE) as source_zip:
        for protected in ("server.js", "services/spinService.js", "utils/fee.js", "public/monitor.html", "public/kafepin-pro-yonetim.html"):
            if package_bytes[protected] != source_zip.read(protected):
                raise SystemExit("Protected v3.1.63 runtime changed: " + protected)
    if package_bytes["public/admin.html"] != (PAYLOAD / "public/admin.html").read_bytes():
        raise SystemExit("Packaged Admin differs from locked payload")
    if package_bytes["desktop-app/KafePinProDesktop.cs"] != (PAYLOAD / "desktop-app/KafePinProDesktop.cs").read_bytes():
        raise SystemExit("Packaged Desktop differs from locked payload")
    for component in ("mp3-bot-pro.zip", "yazici-pro.zip", "teknik-servis-pro.zip", "client-yonetim-pro.zip"):
        nested = zipfile.ZipFile(io.BytesIO(package_bytes["pro-components/" + component]))
        bad_nested = nested.testzip()
        if bad_nested:
            raise SystemExit(component + " CRC failure: " + bad_nested)

    for marker in (
        ".dashboard-cards[hidden],.product-dashboard-cards[hidden],.payment-dashboard-cards[hidden]{display:none!important}",
        "function rebalanceMetricGrids()",
        "['liveFinanceTotalAssets','liveFinanceCash','liveFinanceMainBank','liveFinancePosBank','liveFinanceUnsettledCard','liveFinancePersonalCardDebt','accountingNetCapital']",
        "['payTodayCash','payTodayCard','payTodayPending','payTodayTotal','payTodayCommission','payTodayNetCollected']",
    ):
        require(admin, marker, "ADMIN")
    live = admin[admin.index("function organizeLiveFinanceCards()"):admin.index("function rebalanceMetricGrids()")]
    if "BUGÜN: KAFE GÜNÜ" in live:
        raise SystemExit("Anlık Finans contains duplicated Kafe Günü block")
    if admin.count("['accountingTodayExpense','accountingTodayCommission','accountingTodayNet','accountingTodayRevenue']") != 1:
        raise SystemExit("Kafe Günü accounting group is missing or duplicated")

    for marker in (
        "StopProComponentProcessesAsync()",
        '"MP3 Bot PRO: yeniden başlatıldı\\n"',
        '"Yazıcı PRO: yeniden başlatıldı\\n"',
        '"Teknik Servis PRO: yeniden başlatıldı\\n"',
        '"Client Yönetim PRO: yeniden başlatıldı\\n"',
        "clientProButton.Visible = everyCafeEnabled && IsClientProEnabledForThisCafe();",
        "private bool IsClientProEnabledForThisCafe()",
        "private bool IsEveryCafeEnabledForThisCafe()",
        "ApplyEveryCafeAdminVisibilityAsync()",
        "if (topBar.ClientSize.Width < 700) return;",
        "private void SelectCafeBrandLogo(object sender, EventArgs e)",
    ):
        require(desktop, marker, "DESKTOP")
    if "C:\\KafePinPro\\" not in desktop:
        raise SystemExit("Desktop PRO component root lock missing")
    if update.get("version") != "3.1.64" or update.get("finalStable") is not True:
        raise SystemExit("Package metadata is not v3.1.64 FINAL")
    if "kart" not in str(update.get("notes", "")).lower() or "yeniden başlat" not in str(update.get("notes", "")).lower():
        raise SystemExit("Detailed release-note markers missing from package metadata")

    readonly_count = len(re.findall(r"OPEN_READONLY", server))
    if readonly_count < 1:
        raise SystemExit("EveryCafe OPEN_READONLY marker missing")
    forbidden = re.findall(r"ecm[^\n]{0,180}\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b", server, flags=re.I)
    if forbidden:
        raise SystemExit("Potential EveryCafe write marker found")
    print("V3164_FINAL_VERIFY_OK", digest, "OPEN_READONLY", readonly_count)


if __name__ == "__main__":
    main()
