from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPDATE_BASE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
NEW_CAFE_BASE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.62.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.62.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.62.zip"
REPORT = ROOT / "RELEASE_NOTES-v3.1.62.md"
FIXED_DT = (2026, 8, 22, 17, 0, 0)
VERSION = "3.1.62"
DESKTOP_VERSION = "1.1.8"
DESKTOP_SOURCE = "desktop-app/KafePinProDesktop.cs"

# Everything from the canonical v3.1.60 FINAL pair stays byte-identical except:
# - Manager: remove the obsolete v3.1.57 Yazici payload fatal blocker and force
#   one desktop rebuild so the restored action reaches machines already on 3.1.61.
# - Desktop source: restore the user's missing live action, without touching the
#   web dashboard/card files.
# - Version metadata.
ALLOWED_CHANGED_FILES = {
    "KafePin_Manager_Ensure.ps1",
    DESKTOP_SOURCE,
    "update.json",
    "kafepin-pro-version.json",
}

NOTES = (
    "v3.1.62 STABLE kümülatif onarım: kilitli v3.1.60 FINAL UPDATE + YENİ KAFE paket çifti "
    "kaynak alınır. v3.1.60'taki web kartları, Yönetim/Admin/Monitör/EveryCafe ekranları, finans, "
    "spin, session, Telegram ve 20:00 işletme günü dosyaları değiştirilmez. Yalnız eski v3.1.57 "
    "Yazıcı payload zorunluluğunun Server Manager hazırlığını durdurması kaldırılır ve sahadaki "
    "v3.1.60 kullanımında bulunan 'PRO Servisleri Yenile' eylemi masaüstü Yenile menüsüne geri "
    "getirilir. Çalışan PRO servisler kapatılmaz; yalnız sağlık kontrolü başarısız olan servis mevcut "
    "güvenli başlatıcısıyla ayağa kaldırılır. Client runtime dosyaları v3.1.60 FINAL YENİ KAFE "
    "paketinden byte-for-byte alınır."
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def file_sha_map(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): sha256(p)
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


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


def marker_paths(root: Path, marker: str) -> list[str]:
    needles = [marker.encode("utf-8"), marker.encode("utf-16le"), marker.encode("utf-16be")]
    found: list[str] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            data = p.read_bytes()
        except Exception:
            continue
        if any(n in data for n in needles):
            found.append(p.relative_to(root).as_posix())
            continue
        if p.suffix.lower() in {".cs", ".html", ".js", ".ps1", ".cmd", ".txt", ".json", ".css"}:
            try:
                text = data.decode("utf-8-sig", errors="ignore")
            except Exception:
                continue
            if marker.casefold() in text.casefold():
                found.append(p.relative_to(root).as_posix())
    return found


def build_v3160_canonical(update_root: Path, new_cafe_root: Path, canonical: Path) -> list[str]:
    shutil.copytree(update_root, canonical)
    overlaid: list[str] = []
    # The NEW-CAFE package was finalized from the live install. For paths that
    # exist in both packages, keep that final live copy as authority.
    for dst in sorted(p for p in canonical.rglob("*") if p.is_file()):
        rel = dst.relative_to(canonical)
        src = new_cafe_root / rel
        if src.is_file():
            dst.write_bytes(src.read_bytes())
            overlaid.append(rel.as_posix())
    return overlaid


def validate_v3160_base(canonical: Path) -> dict[str, list[str]]:
    # These three menu integrations are actually present in the locked package.
    # PRO Servisleri Yenile was a live v3.1.60 action but is NOT in the locked
    # GitHub ZIP; CI proved that in multiple package variants. We restore it as
    # the only UI delta below.
    required = ["MP3 Bot PRO", "Yazıcı PRO", "Teknik Servis PRO"]
    locations: dict[str, list[str]] = {}
    missing: list[str] = []
    for marker in required:
        paths = marker_paths(canonical, marker)
        if not paths:
            missing.append(marker)
        else:
            locations[marker] = paths
    if missing:
        raise SystemExit("v3.1.60 FINAL base marker missing: " + ", ".join(missing))

    server = canonical / "server.js"
    if not server.is_file():
        raise SystemExit("server.js missing from v3.1.60 FINAL canonical set")
    server_text = server.read_text(encoding="utf-8-sig", errors="ignore")
    if "available: compareProVersions(remote.version, current) > 0" not in server_text:
        raise SystemExit("v3.1.60 safe update equality guard missing")
    return locations


def patch_desktop(path: Path) -> None:
    src = path.read_text(encoding="utf-8-sig")
    if "PRO Servisleri Yenile" in src:
        # If a future source already contains it, fail rather than duplicate behavior.
        raise SystemExit("desktop source unexpectedly already contains PRO Servisleri Yenile")

    # Keep the one-row top navigation geometry unchanged. The existing 70px
    # Yenile button becomes a dropdown entry point, so no card/topbar positions
    # are shifted. Ekrani Yenile remains available as the first item.
    start = src.find("            refreshButton.Click += async delegate")
    end_marker = "\n\n            topBar.Controls.Add(managementButton);"
    end = src.find(end_marker, start)
    if start < 0 or end < 0:
        raise SystemExit("desktop refresh click block marker missing")

    refresh_block = r'''            ContextMenuStrip refreshMenu = new ContextMenuStrip();
            ToolStripMenuItem screenRefreshItem = new ToolStripMenuItem("Ekranı Yenile");
            ToolStripMenuItem proServicesRefreshItem = new ToolStripMenuItem("PRO Servisleri Yenile");
            screenRefreshItem.Click += async delegate
            {
                try
                {
                    if (mp3ViewActive && mp3Browser.CoreWebView2 != null)
                    {
                        await mp3Browser.CoreWebView2.ExecuteScriptAsync(
                            "window.kafePinPrepareReload ? window.kafePinPrepareReload() : false;"
                        );
                        mp3Browser.CoreWebView2.Reload();
                        return;
                    }
                    if (whatsAppViewActive && whatsAppBrowser.CoreWebView2 != null)
                    {
                        whatsAppBrowser.CoreWebView2.Reload();
                        return;
                    }
                    if (printerViewActive && printerBrowser.CoreWebView2 != null)
                    {
                        printerBrowser.CoreWebView2.Reload();
                        return;
                    }
                    if (serviceViewActive && serviceBrowser.CoreWebView2 != null)
                    {
                        serviceBrowser.CoreWebView2.Reload();
                        return;
                    }
                    NavigateLocal(targetUrl);
                }
                catch { }
            };
            proServicesRefreshItem.Click += ProServicesRefreshMenuItem_Click;
            refreshMenu.Items.Add(screenRefreshItem);
            refreshMenu.Items.Add(proServicesRefreshItem);
            refreshButton.Text = "Yenile ▾";
            refreshButton.Click += delegate
            {
                refreshMenu.Show(refreshButton, new Point(0, refreshButton.Height));
            };'''
    src = src[:start] + refresh_block + src[end:]

    method_marker = "        private async Task<bool> EnsurePrinterRuntimeAsync()"
    if method_marker not in src:
        raise SystemExit("desktop PRO refresh method insertion marker missing")

    handler = r'''        private async void ProServicesRefreshMenuItem_Click(object sender, EventArgs e)
        {
            try
            {
                KickServerManager();
                await Task.Delay(500);
                string report = string.Empty;

                if (!await IsMp3BotReadyOnceAsync())
                {
                    string launcher = Path.Combine(Mp3BotRoot, "START_WEB.ps1");
                    if (File.Exists(launcher))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "powershell.exe";
                        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcher + "\"";
                        psi.WorkingDirectory = Mp3BotRoot;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        report += await WaitForMp3BotAsync(30) ? "MP3 Bot PRO: hazır\n" : "MP3 Bot PRO: başlatılamadı\n";
                    }
                    else report += "MP3 Bot PRO: kurulu değil\n";
                }
                else report += "MP3 Bot PRO: hazır\n";

                if (!await IsPrinterProReadyOnceAsync())
                {
                    string serviceHost = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                    string starter = Path.Combine(PrinterProRoot, "START_YAZICI_PRO.cmd");
                    if (File.Exists(serviceHost))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "powershell.exe";
                        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + serviceHost + "\" -InstallRoot \"" + PrinterProRoot + "\"";
                        psi.WorkingDirectory = PrinterProRoot;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                    }
                    else if (File.Exists(starter))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "cmd.exe";
                        psi.Arguments = "/c \"\"" + starter + "\" --service-only\"";
                        psi.WorkingDirectory = PrinterProRoot;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                    }
                    report += await WaitForPrinterProAsync(45) ? "Yazıcı PRO: hazır\n" : "Yazıcı PRO: başlatılamadı / kurulu değil\n";
                }
                else report += "Yazıcı PRO: hazır\n";

                if (!await IsServiceProReadyAsync())
                {
                    string service = Path.Combine(ServiceProRoot, "web_service.py");
                    if (File.Exists(service))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
                        psi.WorkingDirectory = ServiceProRoot;
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        for (int i = 0; i < 40 && !await IsServiceProReadyAsync(); i++)
                            await Task.Delay(500);
                        report += await IsServiceProReadyAsync() ? "Teknik Servis PRO: hazır\n" : "Teknik Servis PRO: başlatılamadı\n";
                    }
                    else report += "Teknik Servis PRO: kurulu değil\n";
                }
                else report += "Teknik Servis PRO: hazır\n";

                MessageBox.Show(report.TrimEnd(), "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("PRO servisleri yenilenemedi:\n" + ex.Message, "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

'''
    src = src.replace(method_marker, handler + method_marker, 1)

    required_after = [
        "PRO Servisleri Yenile",
        "ProServicesRefreshMenuItem_Click",
        "Ekranı Yenile",
        "WaitForMp3BotAsync(30)",
        "WaitForPrinterProAsync(45)",
    ]
    missing = [m for m in required_after if m not in src]
    if missing:
        raise SystemExit("desktop restore marker missing after patch: " + ", ".join(missing))
    path.write_text(src, encoding="utf-8-sig")


def patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # v3.1.57 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi."
    end_marker = "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }"
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start < 0 or end < 0 or end <= start:
        raise SystemExit("legacy Manager Yazici block markers not found in v3.1.60 FINAL canonical Manager")

    replacement = f'''  # v3.1.62: v3.1.60 FINAL web/kart yapisi aynen korunur.\n  # Eski v3.1.57 Yazici payload'i Server Manager icin zorunlu degildir.\n  # Desktop v{DESKTOP_VERSION} yalniz eksik PRO Servisleri Yenile eylemini geri getirir.\n  Log 'v3.1.62: legacy Yazici payload blokaji kaldirildi; v3.1.60 FINAL cekirdegi korunuyor.'\n  $desktopSetup = Join-Path $InstallRoot 'KafePin_Desktop_App_Setup.ps1'\n  if (-not (Test-Path -LiteralPath $desktopSetup -PathType Leaf)) {{ throw 'KafePin_Desktop_App_Setup.ps1 bulunamadi.' }}\n  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desktopSetup -InstallRoot $InstallRoot -AppVersion '{DESKTOP_VERSION}'\n  if ($LASTEXITCODE -ne 0) {{ throw ('KafePin ana masaustu uygulamasi guncellenemedi. Cikis=' + $LASTEXITCODE) }}\n  Log 'KafePin ana masaustu uygulamasi v{DESKTOP_VERSION} hazir.'\n'''
    text = text[:start] + replacement + text[end:]

    if "v3.1.57 Yazici payload klasoru bulunamadi" in text:
        raise SystemExit("legacy fatal Yazici payload check survived")
    if f"-AppVersion '{DESKTOP_VERSION}'" not in text:
        raise SystemExit("desktop force-rebuild version marker missing")
    path.write_text(text, encoding="utf-8-sig")


def write_metadata(work: Path) -> None:
    meta = {
        "version": VERSION,
        "channel": "candidate",
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "previousStable": "3.1.61",
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "v3160FinalPairPreserved": True,
        "desktopVersion": DESKTOP_VERSION,
        "publishedAt": "2026-08-22T17:00:00+03:00",
        "notes": NOTES,
    }
    meta["files"] = sorted(p.relative_to(work).as_posix() for p in work.rglob("*") if p.is_file())
    data = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    for name in ("update.json", "kafepin-pro-version.json"):
        (work / name).write_text(data, encoding="utf-8")


def verify_only_allowed_changes(before: dict[str, str], after: dict[str, str]) -> None:
    before_files = set(before)
    after_files = set(after)
    if before_files != after_files:
        added = sorted(after_files - before_files)
        removed = sorted(before_files - after_files)
        raise SystemExit(f"v3.1.60 canonical file set changed; added={added}, removed={removed}")
    changed = {name for name in before_files if before[name] != after[name]}
    unexpected = sorted(changed - ALLOWED_CHANGED_FILES)
    required_changed = sorted(ALLOWED_CHANGED_FILES - changed)
    if unexpected:
        raise SystemExit("unexpected v3.1.60 FINAL file changes: " + ", ".join(unexpected))
    if required_changed:
        raise SystemExit("expected patched files did not change: " + ", ".join(required_changed))


def build_client_from_v3160() -> list[str]:
    if not NEW_CAFE_BASE.exists():
        raise SystemExit("v3.1.60 FINAL new-cafe base package missing")
    runtime_ext = (".exe", ".ps1", ".cmd", ".bat", ".json", ".dll", ".config")
    selected: list[str] = []
    with zipfile.ZipFile(NEW_CAFE_BASE, "r") as src:
        for name in src.namelist():
            low = name.lower()
            if low.endswith("/"):
                continue
            if ("client" in low and low.endswith(runtime_ext)) or ("masa" in low and low.endswith(runtime_ext)):
                selected.append(name)
        selected = sorted(set(selected))
        if not selected:
            raise SystemExit("no client runtime artifacts found in v3.1.60 FINAL new-cafe package")
        if CLIENT_OUT.exists():
            CLIENT_OUT.unlink()
        with zipfile.ZipFile(CLIENT_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for name in selected:
                data = src.read(name)
                zi = zipfile.ZipInfo(name, FIXED_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                out.writestr(zi, data)
            readme = (
                "KafePin Client v3.1.62\r\n"
                "======================\r\n"
                "Runtime dosyalari kilitli v3.1.60 FINAL YENI KAFE paketinden byte-for-byte alinmistir.\r\n"
                "Client ping/cark/EveryCafe/session davranisi degistirilmemistir.\r\n"
                "Yeni kafede once v3.1.60 FINAL kurulur; sunucu sonra en guncel kumulatif STABLE surume yukselir.\r\n"
            ).encode("utf-8-sig")
            zi = zipfile.ZipInfo("CLIENT-OKU-BENI.txt", FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, readme)
    with zipfile.ZipFile(NEW_CAFE_BASE, "r") as src, zipfile.ZipFile(CLIENT_OUT, "r") as out:
        for name in selected:
            if hashlib.sha256(src.read(name)).digest() != hashlib.sha256(out.read(name)).digest():
                raise SystemExit("client runtime changed from v3.1.60 FINAL: " + name)
    return selected


def build() -> None:
    for required in (UPDATE_BASE, NEW_CAFE_BASE):
        if not required.exists():
            raise SystemExit("missing locked v3.1.60 FINAL package: " + required.name)

    with tempfile.TemporaryDirectory(prefix="kp3162-v3160-final-") as td:
        tmp = Path(td)
        update_root = tmp / "update-base"
        new_cafe_root = tmp / "new-cafe-base"
        canonical = tmp / "canonical"
        update_root.mkdir()
        new_cafe_root.mkdir()
        with zipfile.ZipFile(UPDATE_BASE, "r") as z:
            z.extractall(update_root)
        with zipfile.ZipFile(NEW_CAFE_BASE, "r") as z:
            z.extractall(new_cafe_root)

        overlaid = build_v3160_canonical(update_root, new_cafe_root, canonical)
        required = [
            canonical / "KafePin_Manager_Ensure.ps1",
            canonical / "KafePin_Desktop_App_Setup.ps1",
            canonical / "server.js",
            canonical / DESKTOP_SOURCE,
        ]
        for p in required:
            if not p.is_file():
                raise SystemExit("required v3.1.60 FINAL file missing: " + str(p.relative_to(canonical)))

        base_locations = validate_v3160_base(canonical)
        before = file_sha_map(canonical)
        patch_desktop(canonical / DESKTOP_SOURCE)
        patch_manager(canonical / "KafePin_Manager_Ensure.ps1")
        write_metadata(canonical)
        after = file_sha_map(canonical)
        verify_only_allowed_changes(before, after)

        if not marker_paths(canonical, "PRO Servisleri Yenile"):
            raise SystemExit("restored PRO Servisleri Yenile marker missing")
        for marker in ("MP3 Bot PRO", "Yazıcı PRO", "Teknik Servis PRO"):
            if not marker_paths(canonical, marker):
                raise SystemExit("existing v3.1.60 PRO menu disappeared: " + marker)
        pack_tree(canonical, OUT)

    digest = sha256(OUT)
    SHA_FILE.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    client_files = build_client_from_v3160()
    client_digest = sha256(CLIENT_OUT)

    REPORT.write_text(
        "# KafePin Pro v3.1.62 — v3.1.60 FINAL Koruma + PRO Yenile\n\n"
        "- Kaynak `release/v3.1.60-stable` dalındaki kilitli v3.1.60 FINAL paket çiftidir.\n"
        "- Web kartları ve tüm çekirdek runtime dosyaları canonical v3.1.60 ile byte-for-byte korunur.\n"
        "- GitHub'daki kilitli ZIP'lerde bulunmayan fakat sahadaki v3.1.60 kullanımında bulunan `PRO Servisleri Yenile` eylemi masaüstündeki mevcut `Yenile` düğmesinin menüsüne geri eklenir; topbar/kart yerleşimi kaydırılmaz.\n"
        "- `Ekranı Yenile` aynı menüde korunur.\n"
        "- PRO yenile yalnız düşmüş MP3 Bot PRO / Yazıcı PRO / Teknik Servis PRO hizmetini başlatır; çalışan hizmeti zorla kapatmaz.\n"
        "- Eski `v3.1.57 Yazici payload` fatal blokajı kaldırılır.\n"
        f"- Desktop sürümü: **{DESKTOP_VERSION}** (3.1.61 üstüne zorunlu tek yeniden derleme).\n"
        "- Client runtime dosyaları v3.1.60 FINAL YENİ KAFE paketinden byte-for-byte alınır.\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n"
        f"- Client runtime dosya sayısı: **{len(client_files)}**\n",
        encoding="utf-8",
    )
    print("V3162_V3160_FINAL_OK", digest, OUT.stat().st_size, "CLIENT", client_digest, len(client_files))
    print("V3160_OVERLAY_COUNT", len(overlaid))
    for marker, paths in sorted(base_locations.items()):
        print("BASE_MARKER", marker, "=>", ";".join(paths))
    print("RESTORED_MARKER PRO Servisleri Yenile =>", ";".join(marker_paths(canonical, "PRO Servisleri Yenile")) if 'canonical' in locals() else DESKTOP_SOURCE)


if __name__ == "__main__":
    build()
