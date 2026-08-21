from __future__ import annotations
import hashlib, json, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'KafePin-Pro-Update-v3.1.58.zip'
OUT = ROOT / 'KafePin-Pro-Update-v3.1.59.zip'
SHA_FILE = ROOT / 'KafePin-Pro-Update-v3.1.59.sha256.txt'
LATEST = ROOT / 'latest.json'
REPORT = ROOT / 'V3.1.59-CANDIDATE-TEST-REPORT.md'
FIXED_DT = (2026, 8, 21, 12, 45, 0)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def replace_method(src: str, signature: str, replacement: str) -> str:
    i = src.find(signature)
    if i < 0: raise SystemExit('method missing: ' + signature)
    b = src.find('{', i)
    if b < 0: raise SystemExit('method brace missing: ' + signature)
    depth = 0; in_str = False; verbatim = False; esc = False; j = b
    while j < len(src):
        ch = src[j]
        if in_str:
            if verbatim:
                if ch == '"':
                    if j + 1 < len(src) and src[j+1] == '"': j += 1
                    else: in_str = False; verbatim = False
            else:
                if esc: esc = False
                elif ch == '\\': esc = True
                elif ch == '"': in_str = False
        else:
            if ch == '"': in_str = True; verbatim = j > 0 and src[j-1] == '@'
            elif ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0: return src[:i] + replacement.rstrip() + src[j+1:]
        j += 1
    raise SystemExit('method end missing: ' + signature)


PRINTER_CLICK = r'''        private async void PrinterProButton_Click(object sender, EventArgs e)
        {
            try
            {
                printerProButton.Enabled = false;
                printerProButton.Text = "🖨️ Yazıcı Açılıyor...";
                if (!await IsPrinterProReadyOnceAsync())
                {
                    string host = Path.Combine(PrinterProRoot, "KafePin_YaziciPRO_ServiceHost.ps1");
                    if (!File.Exists(host)) throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı bulunamadı: " + host);
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "powershell.exe";
                    psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + host + "\" -InstallRoot \"" + PrinterProRoot + "\"";
                    psi.WorkingDirectory = PrinterProRoot;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process hostProcess = Process.Start(psi);
                    if (hostProcess == null) throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı çalıştırılamadı.");

                    // v3.1.59: Servis host process'inin kapanmasını bekleme. İlk kurulumda
                    // Python onarımı 50 saniyeyi aşabilir. Eski kod 50. saniyede host'u
                    // öldürüp sahada yanlış timeout veriyordu. Gerçek kriter 17891+17893.
                    bool ready = await WaitForPrinterProAsync(150);
                    if (!ready)
                    {
                        string detail = string.Empty;
                        try
                        {
                            string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KafePinPro", "logs");
                            foreach (string name in new string[] { "v3156-yazici-startup.log", "v3156-webservice.err.log", "v3156-revenue.err.log" })
                            {
                                string log = Path.Combine(logDir, name);
                                if (!File.Exists(log)) continue;
                                string[] lines = File.ReadAllLines(log);
                                int take = Math.Min(5, lines.Length);
                                string tail = take > 0 ? string.Join(" | ", lines, lines.Length - take, take) : string.Empty;
                                if (!string.IsNullOrWhiteSpace(tail)) detail += (detail.Length > 0 ? "\n" : "") + name + ": " + tail;
                            }
                            if (hostProcess.HasExited) detail += (detail.Length > 0 ? "\n" : "") + "Başlatıcı çıkış kodu: " + hostProcess.ExitCode.ToString();
                        }
                        catch { }
                        throw new InvalidOperationException("Yazıcı PRO servisleri 150 saniye içinde hazır olmadı." + (string.IsNullOrWhiteSpace(detail) ? "" : "\n" + detail));
                    }
                    try { hostProcess.Dispose(); } catch { }
                }
                await EnsurePrinterBrowserAsync();
                ShowPrinterView();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Yazıcı PRO açılamadı:\n" + ex.Message, "KafePin Yazıcı PRO", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                printerProButton.Text = "🖨️ Yazıcı PRO";
                printerProButton.Enabled = true;
            }
        }
'''

WAIT_METHOD = r'''        private async Task<bool> WaitForPrinterProAsync(int maxSeconds)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, maxSeconds));
            while (DateTime.UtcNow < deadline)
            {
                if (await IsPrinterProReadyOnceAsync()) return true;
                int remainingMs = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                if (remainingMs <= 0) break;
                await Task.Delay(Math.Min(500, remainingMs));
            }
            return await IsPrinterProReadyOnceAsync();
        }
'''


def build():
    if not BASE.exists(): raise SystemExit('v3.1.58 base package missing')
    with tempfile.TemporaryDirectory(prefix='kp3159-') as td:
        work = Path(td) / 'work'; work.mkdir()
        with zipfile.ZipFile(BASE, 'r') as z: z.extractall(work)

        cs_path = work / 'desktop-app' / 'KafePinProDesktop.cs'
        if not cs_path.exists(): raise SystemExit('desktop source missing')
        cs = cs_path.read_text(encoding='utf-8-sig')
        cs = replace_method(cs, '        private async void PrinterProButton_Click(object sender, EventArgs e)', PRINTER_CLICK)
        cs = replace_method(cs, '        private async Task<bool> WaitForPrinterProAsync(int maxSeconds)', WAIT_METHOD)
        if 'WaitForExit(50000)' in cs or 'servis başlatıcısı zaman aşımına uğradı' in cs:
            raise SystemExit('legacy 50-second launcher timeout survived')
        if 'WaitForPrinterProAsync(150)' not in cs or 'DateTime.UtcNow.AddSeconds' not in cs:
            raise SystemExit('health/deadline startup logic missing')
        cs_path.write_text(cs, encoding='utf-8-sig')

        setup_path = work / 'KafePin_Desktop_App_Setup.ps1'
        setup = setup_path.read_text(encoding='utf-8-sig')
        setup = setup.replace('[string]$AppVersion = "1.1.5",', '[string]$AppVersion = "1.1.6",')
        if '[string]$AppVersion = "1.1.6",' not in setup: raise SystemExit('desktop setup version patch failed')
        setup_path.write_text(setup, encoding='utf-8-sig')

        mgr_path = work / 'KafePin_Manager_Ensure.ps1'
        mgr = mgr_path.read_text(encoding='utf-8-sig')
        mgr = mgr.replace("v1.1.5 kuruluyor.", "v1.1.6 kuruluyor.")
        mgr = mgr.replace("-AppVersion '1.1.5'", "-AppVersion '1.1.6'")
        mgr = mgr.replace("v1.1.5 hazir.", "v1.1.6 hazir.")
        if "-AppVersion '1.1.6'" not in mgr: raise SystemExit('manager desktop version patch failed')
        mgr_path.write_text(mgr, encoding='utf-8-sig')

        meta_path = work / 'update.json'
        meta = json.loads(meta_path.read_text(encoding='utf-8-sig'))
        meta.update({
            'version':'3.1.59','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
            'notes':'v3.1.59 Yazıcı PRO saha başlangıç düzeltmesi: masaüstü artık servis host processinin 50 saniyede kapanmasını bekleyip öldürmez; 17891+17893 gerçek sağlık durumunu duvar saatiyle bekler. Desktop v1.1.6.'
        })
        files = sorted(str(p.relative_to(work)).replace('\\','/') for p in work.rglob('*') if p.is_file())
        meta['files'] = files
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        files = sorted(str(p.relative_to(work)).replace('\\','/') for p in work.rglob('*') if p.is_file())

        if OUT.exists(): OUT.unlink()
        with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for rel in files:
                p=work/rel; zi=zipfile.ZipInfo(rel,FIXED_DT); zi.compress_type=zipfile.ZIP_DEFLATED; zi.external_attr=0o644<<16; z.writestr(zi,p.read_bytes())

    digest = sha256_file(OUT)
    SHA_FILE.write_text(f'{digest}  {OUT.name}\n', encoding='utf-8')
    LATEST.write_text(json.dumps({
        'version':'3.1.59','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
        'publishedAt':'2026-08-21T12:45:00+03:00',
        'notes':'v3.1.59 ADAY — Yazıcı PRO 50 sn servis başlatıcısı timeout kaldırıldı; desktop artık 17891+17893 sağlık durumunu bekler.',
        'downloadUrl':'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.59.zip','sha256':digest
    }, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    REPORT.write_text(
        '# KafePin Pro v3.1.59 ADAY — Yazıcı PRO Başlangıç Düzeltmesi\n\n'
        '- STABLE: **3.1.49**\n- Aday: **3.1.59**\n'
        '- Saha hatası: `Yazıcı PRO servis başlatıcısı zaman aşımına uğradı.`\n'
        '- Kök neden: Desktop v1.1.5 servis host processini 50 saniye içinde kapanmaya zorluyor ve kapanmazsa öldürüyordu; Python ilk onarımı 50 saniyeyi aşabiliyor.\n'
        '- v3.1.59: process exit beklenmez; 17891+17893 sağlık kontrolü 150 sn duvar-saati deadline ile beklenir.\n'
        '- Desktop: **v1.1.6**\n'
        '- Windows CI sonuçları başarılı build sonrası güncellenecek.\n'
        f'- Paket SHA256: `{digest}`\n', encoding='utf-8')
    print('V3159_BUILD_OK', digest, OUT.stat().st_size)

if __name__ == '__main__': build()
