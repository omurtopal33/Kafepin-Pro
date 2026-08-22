from __future__ import annotations

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
NEW_CAFE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.61.zip"
OUT_SHA = ROOT / "KafePin-Pro-Update-v3.1.61.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.61.zip"
REPORT = ROOT / "RELEASE_NOTES-v3.1.61.md"
FIXED_DT = (2026, 8, 22, 14, 0, 0)
VERSION = "3.1.61"
DESKTOP_VERSION = "1.1.7"
NOTES = (
    "v3.1.61 kümülatif onarım: v3.1.60 FINAL tabanında eski v3.1.57 Yazıcı payload bağımlılığı "
    "Server Manager hazırlığını artık bloke etmez; KafePin Pro masaüstü uygulaması yeniden derlenir ve "
    "MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO menüleri doğrulanır. Güncelleme sürüm karşılaştırması "
    "korunur; sistem latest.json ile aynı sürümdeyse güncelleme var göstermez. Çekirdek finans, spin, "
    "EveryCafe read-only ve 20:00 işletme günü davranışları değiştirilmez."
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def pack_tree(root: Path, out: Path) -> None:
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(x for x in root.rglob("*") if x.is_file()):
            rel = p.relative_to(root).as_posix()
            zi = zipfile.ZipInfo(rel, FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, p.read_bytes())


def patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # v3.1.57 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi."
    end_marker = "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }"
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start < 0 or end < 0 or end <= start:
        raise SystemExit("Manager legacy Yazici block markers not found")
    replacement = f'''  # v3.1.61: Eski v3.1.57 Yazici payload artik Manager icin zorunlu degildir.\n  # Yazici PRO yeni kafe kurulumunda kendi bagimsiz bilesen kurucusu/servisiyle yonetilir.\n  # Bu nedenle eski payload yoksa Server Manager ve KafePin Desktop kurulumu devam eder.\n  Log 'v3.1.61: legacy Yazici payload adimi atlandi; bagimsiz PRO servisleri korunuyor.'\n  $desktopSetup = Join-Path $InstallRoot 'KafePin_Desktop_App_Setup.ps1'\n  if (-not (Test-Path -LiteralPath $desktopSetup -PathType Leaf)) {{ throw 'KafePin_Desktop_App_Setup.ps1 bulunamadi.' }}\n  Log 'KafePin ana masaustu uygulamasi v{DESKTOP_VERSION} kuruluyor.'\n  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desktopSetup -InstallRoot $InstallRoot -AppVersion '{DESKTOP_VERSION}'\n  if ($LASTEXITCODE -ne 0) {{ throw ('KafePin ana masaustu uygulamasi guncellenemedi. Cikis=' + $LASTEXITCODE) }}\n  Log 'KafePin ana masaustu uygulamasi v{DESKTOP_VERSION} hazir.'\n'''
    text = text[:start] + replacement + text[end:]
    if "v3.1.57 Yazici payload klasoru bulunamadi" in text:
        raise SystemExit("legacy payload fatal error survived")
    if f"-AppVersion '{DESKTOP_VERSION}'" not in text:
        raise SystemExit("desktop repair invocation missing")
    path.write_text(text, encoding="utf-8-sig")


def patch_desktop_setup(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    import re
    new_text, count = re.subn(r'\[string\]\$AppVersion\s*=\s*"[^"]+"', f'[string]$AppVersion = "{DESKTOP_VERSION}"', text, count=1)
    if count != 1:
        raise SystemExit("desktop setup AppVersion declaration not found")
    path.write_text(new_text, encoding="utf-8-sig")


def validate_desktop_source(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    required = [
        'MakeNavButton("🎵 MP3 Bot PRO"',
        'MakeNavButton("🖨️ Yazıcı PRO"',
        'MakeNavButton("🛠 Teknik Servis PRO"',
        'mp3BotButton.Click += Mp3BotButton_Click',
        'printerProButton.Click += PrinterProButton_Click',
        'serviceProButton.Click += ServiceProButton_Click',
    ]
    missing = [m for m in required if m not in text]
    if missing:
        raise SystemExit("desktop PRO menu markers missing: " + ", ".join(missing))


def write_metadata(work: Path) -> None:
    meta = {
        "version": VERSION,
        "channel": "candidate",
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "publishedAt": "2026-08-22T14:00:00+03:00",
        "notes": NOTES,
    }
    files = sorted(p.relative_to(work).as_posix() for p in work.rglob("*") if p.is_file())
    meta["files"] = files
    data = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    for name in ("update.json", "kafepin-pro-version.json"):
        (work / name).write_text(data, encoding="utf-8")


def build_client_package() -> list[str]:
    if not NEW_CAFE.exists():
        raise SystemExit("v3.1.60 new cafe base package missing")
    with zipfile.ZipFile(NEW_CAFE, "r") as src:
        names = src.namelist()
        selected = []
        for name in names:
            low = name.lower()
            if low.endswith("/"):
                continue
            if "client" in low or "masa" in low and low.endswith((".exe", ".ps1", ".cmd", ".bat", ".json")):
                selected.append(name)
        if not selected:
            raise SystemExit("no client artifacts found in v3.1.60 new-cafe package")
        if CLIENT_OUT.exists():
            CLIENT_OUT.unlink()
        with zipfile.ZipFile(CLIENT_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for name in sorted(set(selected)):
                zi = zipfile.ZipInfo(name, FIXED_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                out.writestr(zi, src.read(name))
            readme = (
                "KafePin Client v3.1.61\r\n"
                "======================\r\n"
                "Kaynak: kilitli v3.1.60 FINAL yeni-kafe paketi.\r\n"
                "Client davranisi degistirilmedi; ping/cark/EveryCafe secimine gore mevcut onayli akis korunur.\r\n"
                "Bu paket client ile ilgili kurulum/runtime dosyalarini tek ZIP'te toplar.\r\n"
            ).encode("utf-8-sig")
            zi = zipfile.ZipInfo("CLIENT-OKU-BENI.txt", FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, readme)
    return sorted(set(selected))


def build() -> None:
    if not BASE.exists():
        raise SystemExit("v3.1.60 update base package missing")
    with tempfile.TemporaryDirectory(prefix="kp3161-") as td:
        work = Path(td) / "work"
        work.mkdir()
        with zipfile.ZipFile(BASE, "r") as z:
            z.extractall(work)
        mgr = work / "KafePin_Manager_Ensure.ps1"
        setup = work / "KafePin_Desktop_App_Setup.ps1"
        desktop = work / "desktop-app" / "KafePinProDesktop.cs"
        for p in (mgr, setup, desktop, work / "server.js"):
            if not p.is_file():
                raise SystemExit("required package file missing: " + str(p.relative_to(work)))
        patch_manager(mgr)
        patch_desktop_setup(setup)
        validate_desktop_source(desktop)
        server = (work / "server.js").read_text(encoding="utf-8-sig")
        if "available: compareProVersions(remote.version, current) > 0" not in server:
            raise SystemExit("safe update version comparison marker missing")
        write_metadata(work)
        pack_tree(work, OUT)

    digest = sha256(OUT)
    OUT_SHA.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    client_files = build_client_package()
    client_digest = sha256(CLIENT_OUT)
    REPORT.write_text(
        "# KafePin Pro v3.1.61 — Kümülatif Onarım\n\n"
        "- Taban: **v3.1.60 FINAL / STABLE**.\n"
        "- Eski `v3.1.57 Yazici payload klasoru bulunamadi` hatası Manager hazırlığını artık durdurmaz.\n"
        f"- KafePin Pro Desktop **v{DESKTOP_VERSION}** olarak yeniden kurulur/derlenir.\n"
        "- MP3 Bot PRO, Yazıcı PRO ve Teknik Servis PRO menü markerları paket buildinde zorunlu doğrulanır.\n"
        "- `latest.json` ile aynı sürümde `available=false` üreten semantik sürüm karşılaştırması korunur.\n"
        "- Finans, spin, EveryCafe read-only, session ve 20:00 işletme günü çekirdeğine dokunulmaz.\n"
        "- Client paketi v3.1.60 FINAL yeni-kafe paketindeki client dosyalarından yeniden oluşturulur; davranış değiştirilmez.\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n"
        f"- Client dosya sayısı: **{len(client_files)}**\n",
        encoding="utf-8",
    )
    print("V3161_BUILD_OK", digest, OUT.stat().st_size, "CLIENT", client_digest, len(client_files))


if __name__ == "__main__":
    build()
