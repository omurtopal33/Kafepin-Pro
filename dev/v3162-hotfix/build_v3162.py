from __future__ import annotations

import hashlib
import json
import re
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.61.zip"
CLIENT_BASE = ROOT / "KafePin-Client-v3.1.61.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.62.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.62.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.62.zip"
REPORT = ROOT / "RELEASE_NOTES-v3.1.62.md"
FIXED_DT = (2026, 8, 22, 15, 0, 0)
VERSION = "3.1.62"
DESKTOP_VERSION = "1.1.8"

NOTES = (
    "v3.1.62 kümülatif hotfix: KafePin Pro masaüstüne PRO Servisleri Yenile düğmesi geri getirildi. "
    "Düğme çalışan servisleri zorla öldürmez; Server Manager'ı tetikler, MP3 Bot PRO, Yazıcı PRO ve Teknik "
    "Servis PRO sağlık durumunu yeniden kontrol eder ve yalnız eksik/düşmüş servisi güvenli başlatıcısıyla "
    "ayağa kaldırır. v3.1.61 Manager/payload düzeltmeleri, güncelleme eşitlik koruması, finans, spin, session, "
    "EveryCafe read-only ve 20:00 işletme günü davranışları aynen korunur."
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def pack_tree(root: Path, out: Path) -> None:
    if out.exists(): out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(x for x in root.rglob("*") if x.is_file()):
            zi = zipfile.ZipInfo(p.relative_to(root).as_posix(), FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, p.read_bytes())


def patch_desktop(cs_path: Path) -> None:
    src = cs_path.read_text(encoding="utf-8-sig")
    if "PRO Servisleri Yenile" in src:
        raise SystemExit("refresh button already present")

    field_marker = "        private readonly Button serviceProButton;\n        private readonly Button refreshButton;"
    field_repl = "        private readonly Button serviceProButton;\n        private readonly Button proServicesRefreshButton;\n        private readonly Button refreshButton;"
    if field_marker not in src: raise SystemExit("desktop field marker missing")
    src = src.replace(field_marker, field_repl, 1)

    ctor_marker = '            serviceProButton = MakeNavButton("🛠 Teknik Servis PRO", 1110, 12, 150);\n            refreshButton = MakeNavButton("Yenile", 1268, 12, 70);'
    ctor_repl = '            serviceProButton = MakeNavButton("🛠 Teknik Servis PRO", 1110, 12, 150);\n            proServicesRefreshButton = MakeNavButton("PRO Servisleri Yenile", 1268, 12, 158);\n            refreshButton = MakeNavButton("Yenile", 1434, 12, 70);'
    if ctor_marker not in src: raise SystemExit("desktop constructor marker missing")
    src = src.replace(ctor_marker, ctor_repl, 1)

    click_marker = "            serviceProButton.Click += ServiceProButton_Click;\n            refreshButton.Click += async delegate"
    click_repl = "            serviceProButton.Click += ServiceProButton_Click;\n            proServicesRefreshButton.Click += ProServicesRefreshButton_Click;\n            refreshButton.Click += async delegate"
    if click_marker not in src: raise SystemExit("desktop click marker missing")
    src = src.replace(click_marker, click_repl, 1)

    add_marker = "            topBar.Controls.Add(serviceProButton);\n            topBar.Controls.Add(refreshButton);"
    add_repl = "            topBar.Controls.Add(serviceProButton);\n            topBar.Controls.Add(proServicesRefreshButton);\n            topBar.Controls.Add(refreshButton);"
    if add_marker not in src: raise SystemExit("desktop controls marker missing")
    src = src.replace(add_marker, add_repl, 1)

    method_marker = "        private async Task<bool> EnsurePrinterRuntimeAsync()"
    if method_marker not in src: raise SystemExit("desktop method insertion marker missing")
    handler = r'''        private async void ProServicesRefreshButton_Click(object sender, EventArgs e)
        {
            string oldText = proServicesRefreshButton.Text;
            proServicesRefreshButton.Enabled = false;
            proServicesRefreshButton.Text = "Servisler kontrol...";
            try
            {
                KickServerManager();
                await Task.Delay(400);
                string report = string.Empty;

                // MP3 Bot PRO: çalışan servisi bozma; yalnız sağlık kontrolü başarısızsa başlat.
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

                // Yazıcı PRO: v3.1.59+ servis hostu varsa onu kullan; eski kurulumda güvenli START fallback.
                if (!await IsPrinterProReadyOnceAsync())
                {
                    string host = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                    string starter = Path.Combine(PrinterProRoot, "START_YAZICI_PRO.cmd");
                    if (File.Exists(host))
                    {
                        ProcessStartInfo psi = new ProcessStartInfo();
                        psi.FileName = "powershell.exe";
                        psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + host + "\" -InstallRoot \"" + PrinterProRoot + "\"";
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

                // Teknik Servis PRO: yalnız kapalıysa mevcut bağımsız Python servisini aç.
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
                        for (int i = 0; i < 40 && !await IsServiceProReadyAsync(); i++) await Task.Delay(500);
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
            finally
            {
                proServicesRefreshButton.Text = oldText;
                proServicesRefreshButton.Enabled = true;
            }
        }

'''
    src = src.replace(method_marker, handler + method_marker, 1)
    cs_path.write_text(src, encoding="utf-8-sig")


def patch_versions(work: Path) -> None:
    setup = work / "KafePin_Desktop_App_Setup.ps1"
    text = setup.read_text(encoding="utf-8-sig")
    text, n = re.subn(r'\[string\]\$AppVersion\s*=\s*"[^"]+"', f'[string]$AppVersion = "{DESKTOP_VERSION}"', text, count=1)
    if n != 1: raise SystemExit("desktop setup version marker missing")
    setup.write_text(text, encoding="utf-8-sig")

    mgr = work / "KafePin_Manager_Ensure.ps1"
    text = mgr.read_text(encoding="utf-8-sig")
    text = re.sub(r"-AppVersion '[0-9.]+'", f"-AppVersion '{DESKTOP_VERSION}'", text)
    text = re.sub(r"masaustu uygulamasi v[0-9.]+", f"masaustu uygulamasi v{DESKTOP_VERSION}", text)
    if f"-AppVersion '{DESKTOP_VERSION}'" not in text: raise SystemExit("manager desktop version patch missing")
    if "v3.1.57 Yazici payload klasoru bulunamadi" in text: raise SystemExit("legacy fatal payload check returned")
    mgr.write_text(text, encoding="utf-8-sig")


def metadata(work: Path) -> None:
    meta = {
        "version": VERSION,
        "channel": "candidate",
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "previousStable": "3.1.61",
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "publishedAt": "2026-08-22T15:00:00+03:00",
        "notes": NOTES,
    }
    meta["files"] = sorted(p.relative_to(work).as_posix() for p in work.rglob("*") if p.is_file())
    data = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    for name in ("update.json", "kafepin-pro-version.json"):
        (work / name).write_text(data, encoding="utf-8")


def build_client() -> None:
    if not CLIENT_BASE.exists(): raise SystemExit("v3.1.61 client base missing")
    if CLIENT_OUT.exists(): CLIENT_OUT.unlink()
    with zipfile.ZipFile(CLIENT_BASE, "r") as src, zipfile.ZipFile(CLIENT_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for name in sorted(src.namelist()):
            if name.endswith("/"): continue
            data = src.read(name)
            if name.lower().endswith("client-oku-beni.txt"):
                data = (
                    "KafePin Client v3.1.62\r\n"
                    "======================\r\n"
                    "Kümülatif sunucu tabanı: v3.1.60 FINAL.\r\n"
                    "Sunucu v3.1.62 STABLE veya daha yeni kümülatif sürüme çıktığında bu client mevcut ping/çark/EveryCafe akışıyla uyumlu çalışır.\r\n"
                    "Client runtime davranışı v3.1.61'e göre değiştirilmemiştir; paket son saha testi için yeniden sürümlenmiştir.\r\n"
                ).encode("utf-8-sig")
            zi = zipfile.ZipInfo(name, FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, data)
        zi = zipfile.ZipInfo("CLIENT-VERSION.txt", FIXED_DT)
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        out.writestr(zi, b"KafePin Client v3.1.62 - cumulative server compatible\r\n")


def build() -> None:
    if not BASE.exists(): raise SystemExit("v3.1.61 update base missing")
    with tempfile.TemporaryDirectory(prefix="kp3162-") as td:
        work = Path(td) / "work"; work.mkdir()
        with zipfile.ZipFile(BASE, "r") as z: z.extractall(work)
        cs = work / "desktop-app" / "KafePinProDesktop.cs"
        for p in (cs, work / "KafePin_Desktop_App_Setup.ps1", work / "KafePin_Manager_Ensure.ps1", work / "server.js"):
            if not p.is_file(): raise SystemExit("required file missing: " + str(p.relative_to(work)))
        patch_desktop(cs)
        patch_versions(work)
        server = (work / "server.js").read_text(encoding="utf-8-sig")
        if "available: compareProVersions(remote.version, current) > 0" not in server:
            raise SystemExit("update equality guard missing")
        metadata(work)
        pack_tree(work, OUT)

    digest = sha256(OUT)
    SHA_FILE.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    build_client()
    client_digest = sha256(CLIENT_OUT)
    REPORT.write_text(
        "# KafePin Pro v3.1.62 — PRO Servisleri Yenile Hotfix\n\n"
        "- v3.1.60 FINAL temel kurulum değişmez.\n"
        "- v3.1.62, v3.1.60 üzerine tek adımda uygulanabilen kümülatif STABLE update'tir.\n"
        "- `PRO Servisleri Yenile` düğmesi KafePin Pro masaüstüne geri eklendi.\n"
        "- Çalışan PRO servisler öldürülmez; sağlık kontrolü geçmeyen servis güvenli başlatıcısıyla ayağa kaldırılır.\n"
        "- MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO ve Server Manager kontrol edilir.\n"
        "- Desktop v1.1.8.\n"
        "- Client v3.1.62 paketi v3.1.61 runtime davranışını korur; kümülatif sunucu sürümleriyle uyumludur.\n"
        "- Finans, spin, session, EveryCafe read-only ve 20:00 işletme günü çekirdeğine dokunulmaz.\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n",
        encoding="utf-8",
    )
    print("V3162_BUILD_OK", digest, OUT.stat().st_size, "CLIENT", client_digest, CLIENT_OUT.stat().st_size)


if __name__ == "__main__":
    build()
