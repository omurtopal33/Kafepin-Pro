from __future__ import annotations

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_UPDATE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
SOURCE_NEW_CAFE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.63.zip"
SHA_OUT = ROOT / "KafePin-Pro-Update-v3.1.63.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.63.zip"
NOTES_OUT = ROOT / "RELEASE_NOTES-v3.1.63.md"
EXPECTED_FIELD_FINAL_SHA = "1976d0377739f2c866c4faee1d11c9623c659c8ab743db3871fece1d81f2ba2b"
FIXED_DT = (2026, 8, 22, 18, 0, 0)
DESKTOP_VERSION = "1.1.9"
ALLOWED_CHANGED = {
    "KafePin_Manager_Ensure.ps1",
    "desktop-app/KafePinProDesktop.cs",
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
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(x for x in root.rglob("*") if x.is_file()):
            zi = zipfile.ZipInfo(p.relative_to(root).as_posix(), FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, p.read_bytes())


def patch_desktop(path: Path) -> None:
    src = path.read_text(encoding="utf-8-sig")
    if "PRO Servisleri Yenile" in src:
        raise SystemExit("FIELD FINAL desktop already contains PRO Servisleri Yenile; refusing duplicate patch")

    start = src.find("            refreshButton.Click += async delegate")
    end = src.find("\n\n            topBar.Controls.Add(managementButton);", start)
    if start < 0 or end < 0:
        raise SystemExit("FIELD FINAL desktop refresh block not found")

    refresh_block = r'''            ContextMenuStrip refreshMenu = new ContextMenuStrip();
            ToolStripMenuItem screenRefreshItem = new ToolStripMenuItem("Ekranı Yenile");
            ToolStripMenuItem proServicesRefreshItem = new ToolStripMenuItem("PRO Servisleri Yenile");
            screenRefreshItem.Click += async delegate
            {
                try
                {
                    if (whatsAppViewActive)
                    {
                        await ReloadActiveMessagingViewAsync();
                        return;
                    }
                    if (mp3ViewActive && mp3Browser.CoreWebView2 != null)
                    {
                        await mp3Browser.CoreWebView2.ExecuteScriptAsync(
                            "window.kafePinPrepareReload ? window.kafePinPrepareReload() : false;"
                        );
                        mp3Browser.CoreWebView2.Reload();
                        return;
                    }
                    if (printerViewActive && printerBrowser.CoreWebView2 != null) { printerBrowser.CoreWebView2.Reload(); return; }
                    if (serviceViewActive && serviceBrowser.CoreWebView2 != null) { serviceBrowser.CoreWebView2.Reload(); return; }
                    if (clientViewActive && clientBrowser.CoreWebView2 != null) { clientBrowser.CoreWebView2.Reload(); return; }
                    NavigateLocal(targetUrl);
                }
                catch { }
            };
            proServicesRefreshItem.Click += ProServicesRefreshMenuItem_Click;
            refreshMenu.Items.Add(screenRefreshItem);
            refreshMenu.Items.Add(proServicesRefreshItem);
            refreshButton.Text = "Yenile ▾";
            refreshButton.Click += delegate { refreshMenu.Show(refreshButton, new Point(0, refreshButton.Height)); };'''
    src = src[:start] + refresh_block + src[end:]

    marker = "        private async void Mp3BotButton_Click(object sender, EventArgs e)"
    if marker not in src:
        raise SystemExit("FIELD FINAL desktop handler insertion marker missing")

    handler = r'''        private async void ProServicesRefreshMenuItem_Click(object sender, EventArgs e)
        {
            try
            {
                string report = string.Empty;
                if (!await IsMp3BotReadyOnceAsync())
                {
                    string launcher = Path.Combine(Mp3BotRoot, "START_WEB.ps1");
                    if (File.Exists(launcher))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "powershell.exe";
                        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcher + "\"";
                        psi.WorkingDirectory = Mp3BotRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        report += await WaitForMp3BotAsync(30) ? "MP3 Bot PRO: hazır\n" : "MP3 Bot PRO: başlatılamadı\n";
                    }
                    else report += "MP3 Bot PRO: kurulu değil\n";
                }
                else report += "MP3 Bot PRO: hazır\n";

                if (!await IsPrinterProReadyOnceAsync())
                {
                    string host = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                    if (File.Exists(host))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "powershell.exe";
                        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + host + "\" -InstallRoot \"" + PrinterProRoot + "\"";
                        psi.WorkingDirectory = PrinterProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        report += await WaitForPrinterProAsync(150) ? "Yazıcı PRO: hazır\n" : "Yazıcı PRO: başlatılamadı\n";
                    }
                    else report += "Yazıcı PRO: kurulu değil\n";
                }
                else report += "Yazıcı PRO: hazır\n";

                if (!await IsServiceProReadyAsync())
                {
                    string service = Path.Combine(ServiceProRoot, "web_service.py");
                    if (File.Exists(service))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
                        psi.WorkingDirectory = ServiceProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        for (int i = 0; i < 40 && !await IsServiceProReadyAsync(); i++) await Task.Delay(500);
                        report += await IsServiceProReadyAsync() ? "Teknik Servis PRO: hazır\n" : "Teknik Servis PRO: başlatılamadı\n";
                    }
                    else report += "Teknik Servis PRO: kurulu değil\n";
                }
                else report += "Teknik Servis PRO: hazır\n";

                if (!await IsClientProReadyAsync())
                {
                    string service = Path.Combine(ClientProRoot, "web_service.py");
                    if (File.Exists(service))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("py.exe", "-3 -B \"" + service + "\"");
                        psi.WorkingDirectory = ClientProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                        Process.Start(psi);
                        for (int i = 0; i < 40 && !await IsClientProReadyAsync(); i++) await Task.Delay(500);
                        report += await IsClientProReadyAsync() ? "Client Yönetim PRO: hazır\n" : "Client Yönetim PRO: başlatılamadı\n";
                    }
                    else report += "Client Yönetim PRO: kurulu değil\n";
                }
                else report += "Client Yönetim PRO: hazır\n";

                MessageBox.Show(report.TrimEnd(), "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("PRO servisleri yenilenemedi:\n" + ex.Message, "KafePin PRO Servisleri", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

'''
    src = src.replace(marker, handler + marker, 1)
    for required in ("PRO Servisleri Yenile", "Ekranı Yenile", "Client Yönetim PRO", "WaitForPrinterProAsync(150)"):
        if required not in src:
            raise SystemExit("Desktop restore marker missing: " + required)
    path.write_text(src, encoding="utf-8-sig")


def patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # v3.1.57 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi."
    end_marker = "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }"
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        raise SystemExit("FIELD FINAL Manager legacy Yazici block markers missing")

    replacement = r'''  # v3.1.63: Eski v3.1.57 Yazici payload'i kumulatif update icin zorunlu degildir.
  # Verify-only cagrilari eksik legacy payload nedeniyle tum kurulumu calistirmaz.
  if ($VerifyYaziciPayloadOnly) {
    Write-Output 'KAFEPIN_YAZICI_RUNTIME_SHA_VERIFY_SKIPPED_LEGACY_PAYLOAD_NOT_REQUIRED'
    exit 0
  }
  $desktopSetup = Join-Path $InstallRoot 'KafePin_Desktop_App_Setup.ps1'
  if (-not (Test-Path -LiteralPath $desktopSetup -PathType Leaf)) { throw 'KafePin_Desktop_App_Setup.ps1 bulunamadi.' }
  Log 'KafePin ana masaustu uygulamasi v1.1.9 kuruluyor (v3.1.60 FIELD FINAL UI + PRO Servisleri Yenile).'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desktopSetup -InstallRoot $InstallRoot -AppVersion '1.1.9'
  if ($LASTEXITCODE -ne 0) { throw ('KafePin ana masaustu uygulamasi guncellenemedi. Cikis=' + $LASTEXITCODE) }
  Log 'KafePin ana masaustu uygulamasi v1.1.9 hazir.'
'''
    text = text[:start] + replacement + text[end:]
    if "v3.1.57 Yazici payload klasoru bulunamadi" in text:
        raise SystemExit("Legacy fatal Yazici payload blocker survived")
    if "KAFEPIN_YAZICI_RUNTIME_SHA_VERIFY_SKIPPED_LEGACY_PAYLOAD_NOT_REQUIRED" not in text:
        raise SystemExit("VerifyYaziciPayloadOnly safe exit marker missing")
    path.write_text(text, encoding="utf-8-sig")


def write_metadata(root: Path) -> None:
    meta = {
        "version": "3.1.63",
        "channel": "stable",
        "finalStable": False,
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "fieldFinalSourceSha256": EXPECTED_FIELD_FINAL_SHA,
        "desktopVersion": DESKTOP_VERSION,
        "publishedAt": "2026-08-22T18:00:00+03:00",
        "notes": "v3.1.63 STABLE: kullanicinin sahada dogrulanmis orijinal v3.1.60 FINAL update paketi birebir tabandir. KafePin Cark ve diger Admin/Monitor/Yonetim kartlari dahil tum UI/runtime dosyalari korunur; yalniz eski v3.1.57 Yazici payload blokaji kaldirilir, verify-only davranisi guvenli sekilde sonlanir ve PRO Servisleri Yenile geri eklenir.",
    }
    meta["files"] = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    raw = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    (root / "update.json").write_text(raw, encoding="utf-8")
    (root / "kafepin-pro-version.json").write_text(raw, encoding="utf-8")


def build_client() -> list[str]:
    if not SOURCE_NEW_CAFE.is_file():
        raise SystemExit("v3.1.60 NEW CAFE source missing")
    selected: list[str] = []
    with zipfile.ZipFile(SOURCE_NEW_CAFE) as src:
        all_names = [n for n in src.namelist() if not n.endswith("/")]
        print("NEW_CAFE_CLIENT_CANDIDATES_BEGIN")
        for name in all_names:
            low = name.lower()
            if "client" in low or "masa" in low:
                print(name)
        print("NEW_CAFE_CLIENT_CANDIDATES_END")

        runtime_ext = (".exe", ".ps1", ".cmd", ".bat", ".json", ".dll", ".config")
        for name in all_names:
            low = name.lower()
            if (("client" in low or "masa" in low) and low.endswith(runtime_ext)):
                selected.append(name)
        selected = sorted(set(selected))
        if not selected:
            raise SystemExit("No client runtime files found in original v3.1.60 NEW CAFE")
        if CLIENT_OUT.exists():
            CLIENT_OUT.unlink()
        with zipfile.ZipFile(CLIENT_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for name in selected:
                zi = zipfile.ZipInfo(name, FIXED_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                out.writestr(zi, src.read(name))
            readme = (
                "KafePin Client v3.1.63\r\n"
                "Runtime dosyalari orijinal v3.1.60 FINAL YENI KAFE paketinden byte-for-byte alinmistir.\r\n"
                "Ping/cark/EveryCafe/session davranisi degistirilmemistir.\r\n"
            ).encode("utf-8-sig")
            zi = zipfile.ZipInfo("CLIENT-OKU-BENI.txt", FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, readme)
    return selected


def build() -> None:
    if sha256(SOURCE_UPDATE) != EXPECTED_FIELD_FINAL_SHA:
        raise SystemExit("WRONG v3.1.60 SOURCE: expected FIELD FINAL SHA " + EXPECTED_FIELD_FINAL_SHA + " got " + sha256(SOURCE_UPDATE))

    with tempfile.TemporaryDirectory(prefix="kp3163-field-final-") as td:
        root = Path(td)
        with zipfile.ZipFile(SOURCE_UPDATE) as z:
            z.extractall(root)
        before = file_map(root)

        required = [
            root / "public/admin.html",
            root / "public/monitor.html",
            root / "public/kafepin-pro-yonetim.html",
            root / "server.js",
            root / "KafePin_Manager_Ensure.ps1",
            root / "desktop-app/KafePinProDesktop.cs",
        ]
        for p in required:
            if not p.is_file():
                raise SystemExit("FIELD FINAL required file missing: " + str(p.relative_to(root)))

        admin_sha = sha256(root / "public/admin.html")
        monitor_sha = sha256(root / "public/monitor.html")
        management_sha = sha256(root / "public/kafepin-pro-yonetim.html")

        patch_desktop(root / "desktop-app/KafePinProDesktop.cs")
        patch_manager(root / "KafePin_Manager_Ensure.ps1")
        write_metadata(root)
        after = file_map(root)

        if set(before) != set(after):
            raise SystemExit("FIELD FINAL file set changed")
        changed = sorted(name for name in before if before[name] != after[name])
        if set(changed) != ALLOWED_CHANGED:
            raise SystemExit("Unexpected changes from FIELD FINAL: " + ", ".join(changed))
        if sha256(root / "public/admin.html") != admin_sha:
            raise SystemExit("ADMIN CARDS CHANGED from FIELD FINAL")
        if sha256(root / "public/monitor.html") != monitor_sha:
            raise SystemExit("MONITOR UI CHANGED from FIELD FINAL")
        if sha256(root / "public/kafepin-pro-yonetim.html") != management_sha:
            raise SystemExit("MANAGEMENT CARDS CHANGED from FIELD FINAL")
        pack_tree(root, OUT)

    digest = sha256(OUT)
    SHA_OUT.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    client_files = build_client()
    client_digest = sha256(CLIENT_OUT)
    NOTES_OUT.write_text(
        "# KafePin Pro v3.1.63 — FIELD FINAL Restore\n\n"
        f"- Kaynak v3.1.60 SHA256: `{EXPECTED_FIELD_FINAL_SHA}`\n"
        "- Bu SHA kullanıcının çalışan/orijinal v3.1.60 FINAL update paketidir.\n"
        "- `public/admin.html`, `public/monitor.html`, `public/kafepin-pro-yonetim.html`, server/finans/spin/session dosyaları byte-for-byte korunur.\n"
        "- Yalnız Manager legacy Yazıcı payload blokajı ve Desktop PRO Servisleri Yenile geri yüklemesi değiştirilir.\n"
        f"- Desktop: {DESKTOP_VERSION}\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n"
        f"- Client runtime files: {len(client_files)}\n",
        encoding="utf-8",
    )
    print("V3163_FIELD_FINAL_OK", digest, OUT.stat().st_size)
    print("CLIENT_SHA", client_digest, "FILES", len(client_files))
    for name in client_files:
        print("CLIENT_FILE", name)


if __name__ == "__main__":
    build()
