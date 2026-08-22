from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "KafePin-Pro-Update-v3.1.63.zip"
PAYLOAD = Path(__file__).resolve().parent / "payload"
OUT = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
SHA_OUT = ROOT / "KafePin-Pro-Update-v3.1.64.sha256.txt"
NOTES_OUT = ROOT / "RELEASE_NOTES-v3.1.64.md"
EXPECTED_SOURCE_SHA = "e0b24eb364f9ed5a988e17681ec75b2269d469459bc2c8870b13637965e10427"
FIXED_DT = (2026, 8, 22, 12, 45, 0)
ALLOWED_CHANGED = {
    "KafePin_Manager_Ensure.ps1",
    "desktop-app/KafePinProDesktop.cs",
    "public/admin.html",
    "update.json",
    "kafepin-pro-version.json",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def file_map(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): sha256(p)
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def pack_tree(root: Path, out: Path) -> None:
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), FIXED_DT)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, path.read_bytes())


def assert_locked_ui(admin: str) -> None:
    required = (
        ".dashboard-cards[hidden],.product-dashboard-cards[hidden],.payment-dashboard-cards[hidden]{display:none!important}",
        "function organizeCafeCards()",
        "function organizeEveryCafeCards()",
        "function organizeFinanceCards()",
        "function organizeLiveFinanceCards()",
        "function rebalanceMetricGrids()",
        "['liveFinanceTotalAssets','liveFinanceCash','liveFinanceMainBank','liveFinancePosBank','liveFinanceUnsettledCard','liveFinancePersonalCardDebt','accountingNetCapital']",
        "['payTodayCash','payTodayCard','payTodayPending','payTodayTotal','payTodayCommission','payTodayNetCollected']",
        "['accountingTodayExpense','accountingTodayCommission','accountingTodayNet','accountingTodayRevenue']",
        "['accountingMonthExpense','accountingMonthRevenue','accountingMonthCommission','accountingMonthNet','accountingNetCapital']",
        "['accountingAllExpense','accountingAllCommission','accountingAllRevenue','accountingAllNet','accountingAllMargin']",
    )
    for marker in required:
        if marker not in admin:
            raise SystemExit("ADMIN FINAL LOCK marker missing: " + marker)
    live_start = admin.index("function organizeLiveFinanceCards()")
    live_end = admin.index("function rebalanceMetricGrids()", live_start)
    if "BUGÜN: KAFE GÜNÜ" in admin[live_start:live_end]:
        raise SystemExit("ADMIN FINAL LOCK: Kafe Günü duplicated in Anlık Finans")


def assert_locked_desktop(desktop: str) -> None:
    required = (
        'private const string Mp3BotRoot = @"C:\\KafePinPro\\MP3BotPRO";',
        'private const string PrinterProRoot = @"C:\\KafePinPro\\YaziciPRO";',
        'private const string ServiceProRoot = @"C:\\KafePinPro\\TeknikServisPRO";',
        'private const string ClientProRoot = @"C:\\KafePinPro\\ClientYonetimPRO";',
        "StopProComponentProcessesAsync()",
        'proServicesRefreshButton.Text = "↻ Başlatılıyor...";',
        '"MP3 Bot PRO: yeniden başlatıldı\\n"',
        '"Yazıcı PRO: yeniden başlatıldı\\n"',
        '"Teknik Servis PRO: yeniden başlatıldı\\n"',
        '"Client Yönetim PRO: yeniden başlatıldı\\n"',
    )
    for marker in required:
        if marker not in desktop:
            raise SystemExit("DESKTOP FINAL LOCK marker missing: " + marker)


def metadata_bytes(file_names: list[str]) -> bytes:
    notes = (
        "v3.1.64 FINAL / STABLE: onaylanan Admin kart mimarisi kilitlendi. Kafe & Çark, EveryCafe, "
        "Anlık Finans ve Kasa & Muhasebe kartları tekil alanlara ayrıldı; gizli eski kartların görünmesi ve "
        "boş satır bırakması engellendi. Toplam Varlık ve Bankaya Geçecek Kart yalnız Anlık Finans'ta; "
        "20:00–20:00 Kafe Günü kartları Kasa & Muhasebe'dedir. PRO Servisleri düğmesi MP3, Yazıcı, Teknik "
        "Servis ve Client Yönetim bağımsız servislerini gerçekten yeniden başlatır. KafePin çekirdeği, finans "
        "formülleri, spin/session, EveryCafe salt-okunur erişimi, Telegram ve 20:00 gün sonu değiştirilmedi."
    )
    meta = {
        "version": "3.1.64",
        "channel": "stable",
        "finalStable": True,
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "futureUpdateBase": "3.1.64",
        "cumulative": True,
        "sourceVersion": "3.1.63",
        "sourceSha256": EXPECTED_SOURCE_SHA,
        "desktopVersion": "1.1.10",
        "publishedAt": "2026-08-22T12:45:00+03:00",
        "notes": notes,
    }
    meta["files"] = sorted(file_names)
    return (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def build() -> None:
    if not SOURCE.is_file() or sha256(SOURCE) != EXPECTED_SOURCE_SHA:
        raise SystemExit("v3.1.63 canonical source missing or SHA mismatch")
    for rel in ("public/admin.html", "desktop-app/KafePinProDesktop.cs"):
        if not (PAYLOAD / rel).is_file():
            raise SystemExit("FINAL payload missing: " + rel)

    with zipfile.ZipFile(SOURCE) as z:
        entries = {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}
    before = {name: hashlib.sha256(data).hexdigest() for name, data in entries.items()}
    entries["public/admin.html"] = (PAYLOAD / "public/admin.html").read_bytes()
    entries["desktop-app/KafePinProDesktop.cs"] = (PAYLOAD / "desktop-app/KafePinProDesktop.cs").read_bytes()

    manager_text = entries["KafePin_Manager_Ensure.ps1"].decode("utf-8-sig")
    if "v1.1.9" not in manager_text or "-AppVersion '1.1.9'" not in manager_text:
        raise SystemExit("Manager desktop version markers missing")
    manager_text = manager_text.replace("v1.1.9", "v1.1.10").replace("-AppVersion '1.1.9'", "-AppVersion '1.1.10'")
    entries["KafePin_Manager_Ensure.ps1"] = ("\ufeff" + manager_text).encode("utf-8")

    assert_locked_ui(entries["public/admin.html"].decode("utf-8-sig"))
    assert_locked_desktop(entries["desktop-app/KafePinProDesktop.cs"].decode("utf-8-sig"))
    meta = metadata_bytes(list(entries))
    entries["update.json"] = meta
    entries["kafepin-pro-version.json"] = meta
    after = {name: hashlib.sha256(data).hexdigest() for name, data in entries.items()}
    if set(before) != set(after):
        raise SystemExit("FINAL package file set changed")
    changed = {name for name in before if before[name] != after[name]}
    if changed != ALLOWED_CHANGED:
        raise SystemExit("Unexpected changed files: " + ", ".join(sorted(changed)))
    for protected in ("server.js", "services/spinService.js", "utils/fee.js", "public/monitor.html", "public/kafepin-pro-yonetim.html"):
        if before[protected] != after[protected]:
            raise SystemExit("Protected runtime changed: " + protected)

    OUT.unlink(missing_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, FIXED_DT)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, entries[name])

    digest = sha256(OUT)
    SHA_OUT.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    NOTES_OUT.write_text(
        "# KafePin Pro v3.1.64 — FINAL / STABLE\n\n"
        "## Kilitlenen yapı\n\n"
        "- Admin kart bilgi mimarisi dört ayrı panelde kilitlendi.\n"
        "- Toplam Varlık ve Bankaya Geçecek Kart yalnız Anlık Finans'tadır.\n"
        "- 20:00–20:00 Kafe Günü kartları yalnız Kasa & Muhasebe'dedir.\n"
        "- Eski kaynak kart grupları `[hidden]` iken CSS tarafından yeniden gösterilemez.\n"
        "- Kart satırları `rebalanceMetricGrids` ile boşluk bırakmadan otomatik dolar.\n"
        "- PRO Servisleri düğmesi dört bağımsız PRO servisini gerçekten yeniden başlatır.\n\n"
        "## Korunan çekirdek\n\n"
        "- `server.js`, finans formülleri, spin/session, EveryCafe, Telegram ve 20:00 gün sonu değiştirilmedi.\n"
        "- EveryCafe erişimi salt-okunur kalır.\n"
        "- Monitor ve Yönetim arayüzleri v3.1.63 ile byte-for-byte aynıdır.\n\n"
        "## Yayın\n\n"
        "- Kümülatif taban: v3.1.60 FINAL.\n"
        "- Önceki kaynak: v3.1.63 STABLE.\n"
        f"- Paket SHA-256: `{digest}`\n",
        encoding="utf-8",
    )
    print("V3164_FINAL_BUILD_OK", digest, OUT.stat().st_size)


if __name__ == "__main__":
    build()
