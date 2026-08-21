from __future__ import annotations
import hashlib, json, re, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.55.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.56.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.56.sha256.txt"
LATEST = ROOT / "latest.json"
REPORT = ROOT / "V3.1.56-CANDIDATE-TEST-REPORT.md"
FIXED_DT = (2026, 8, 21, 11, 45, 0)

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def replace_once(s: str, old: str, new: str, label: str) -> str:
    if old not in s:
        raise SystemExit("patch marker missing: " + label)
    return s.replace(old, new, 1)

def replace_method(src: str, signature: str, replacement: str) -> str:
    i = src.find(signature)
    if i < 0:
        raise SystemExit("method missing: " + signature)
    b = src.find("{", i)
    if b < 0:
        raise SystemExit("method brace missing: " + signature)
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
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0: return src[:i] + replacement.rstrip() + src[j+1:]
        j += 1
    raise SystemExit("method end missing: " + signature)

SERVICE_HOST = r'''param(
  [string]$InstallRoot = 'C:\KafePin\KafePinYaziciPRO',
  [string]$NodePath = '',
  [string]$PythonPath = '',
  [switch]$SkipRepair
)
$ErrorActionPreference='Stop'
$Expected='3.1.56-candidate1'
$LogDir=Join-Path $env:ProgramData 'KafePinPro\logs'
$LogFile=Join-Path $LogDir 'v3156-yazici-startup.log'
$StatusFile=Join-Path $LogDir 'v3156-yazici-startup.json'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log([string]$m){ try{ Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')+' [v3156] '+$m) -Encoding UTF8 }catch{} }
function Health([string]$u){ try{ return Invoke-RestMethod -UseBasicParsing -Uri $u -TimeoutSec 2 }catch{ return $null } }
function Ready {
  $w=Health 'http://127.0.0.1:17891/api/health'
  $r=Health 'http://127.0.0.1:17893/health'
  return ($null -ne $w -and $null -ne $r -and [bool]$w.ok -and [bool]$r.ok -and [string]$w.version -eq $Expected -and [string]$r.version -eq $Expected)
}
function Stop-Old {
  try{
    $self=$PID
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $c=[string]$_.CommandLine; $n=[string]$_.Name
      ([int]$_.ProcessId -ne [int]$self) -and $c -and (
        (($n -ieq 'node.exe') -and $c.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or
        (($n -ieq 'python.exe' -or $n -ieq 'pythonw.exe') -and $c.IndexOf('web_service.py',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.IndexOf('KafePinYaziciPRO',[StringComparison]::OrdinalIgnoreCase) -ge 0)
      )
    } | ForEach-Object { try{ Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }catch{} }
  }catch{}
  Start-Sleep -Milliseconds 700
}
function Find-Node {
  if($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)){ return $NodePath }
  $np=Join-Path $InstallRoot 'node-path.txt'
  if(Test-Path -LiteralPath $np){ try{ $v=(Get-Content -LiteralPath $np -Raw).Trim(); if($v -and (Test-Path -LiteralPath $v -PathType Leaf)){return $v} }catch{} }
  foreach($p in @('C:\KafePin\node\node.exe','C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')){ if(Test-Path -LiteralPath $p -PathType Leaf){ return $p } }
  try{ $c=Get-Command node.exe -ErrorAction Stop; if($c.Source){return [string]$c.Source} }catch{}
  throw 'node.exe bulunamadı.'
}
function Find-Python {
  if($PythonPath -and (Test-Path -LiteralPath $PythonPath -PathType Leaf)){ return $PythonPath }
  foreach($n in @('pythonw.exe','python.exe')){
    $p=Join-Path $InstallRoot ('.venv\Scripts\'+$n)
    if(Test-Path -LiteralPath $p -PathType Leaf){ return $p }
  }
  return ''
}
function Repair-Python {
  if($SkipRepair){ return $false }
  $setup=Join-Path $InstallRoot 'KURULUM.cmd'
  if(-not (Test-Path -LiteralPath $setup -PathType Leaf)){ Log 'KURULUM.cmd yok; onarım yapılamadı.'; return $false }
  Log 'Python ortamı onarılıyor.'
  $p=Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',('""'+$setup+'" /silent"')) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -Wait
  Log ('KURULUM çıkış='+$p.ExitCode)
  return ($p.ExitCode -eq 0)
}
function Start-Both {
  $node=Find-Node; $py=Find-Python
  if(-not $py){ if(-not (Repair-Python)){ throw 'Yazıcı PRO Python ortamı bulunamadı.' }; $py=Find-Python }
  if(-not $py){ throw 'Yazıcı PRO Python çalıştırıcısı bulunamadı.' }
  $js=Join-Path $InstallRoot 'KafePin_YaziciGelir_Service.js'; $web=Join-Path $InstallRoot 'web_service.py'
  if(-not (Test-Path -LiteralPath $js)){ throw 'Gelir servisi dosyası bulunamadı.' }
  if(-not (Test-Path -LiteralPath $web)){ throw 'Web servisi dosyası bulunamadı.' }
  $nodeOut=Join-Path $LogDir 'v3156-revenue.out.log'; $nodeErr=Join-Path $LogDir 'v3156-revenue.err.log'
  $pyOut=Join-Path $LogDir 'v3156-webservice.out.log'; $pyErr=Join-Path $LogDir 'v3156-webservice.err.log'
  foreach($f in @($nodeOut,$nodeErr,$pyOut,$pyErr)){ Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  $nproc=Start-Process -FilePath $node -ArgumentList @($js) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  $pproc=Start-Process -FilePath $py -ArgumentList @($web) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $pyOut -RedirectStandardError $pyErr
  [ordered]@{version=$Expected;startedAt=(Get-Date).ToString('o');nodePid=$nproc.Id;pythonPid=$pproc.Id;node=$node;python=$py} | ConvertTo-Json | Set-Content -LiteralPath $StatusFile -Encoding UTF8
  Log ('Süreçler başlatıldı nodePid='+$nproc.Id+' pythonPid='+$pproc.Id)
}
function Wait-Ready([int]$Seconds){ for($i=0;$i -lt ($Seconds*2);$i++){ if(Ready){return $true}; Start-Sleep -Milliseconds 500 }; return $false }
try{
  Log ('Başlangıç root='+$InstallRoot)
  if(Ready){ Log 'Servisler zaten 3.1.56 hazır.'; exit 0 }
  Stop-Old; Start-Both
  if(Wait-Ready 15){ Log 'BASARILI: 17891+17893 hazır.'; exit 0 }
  Log 'İlk başlatma başarısız; tek sefer Python onarımı deneniyor.'
  Stop-Old
  if(Repair-Python){ Start-Both; if(Wait-Ready 25){ Log 'BASARILI: onarım sonrası 17891+17893 hazır.'; exit 0 } }
  $tail=''
  foreach($f in @('v3156-webservice.err.log','v3156-revenue.err.log')){ $p=Join-Path $LogDir $f; if(Test-Path $p){ try{ $x=(Get-Content $p -Tail 8 -ErrorAction SilentlyContinue) -join ' | '; if($x){$tail += $f+': '+$x+' '} }catch{} } }
  throw ('17891 ve 17893 hazır olmadı. '+$tail)
}catch{ Log ('HATA: '+$_.Exception.Message); Write-Error $_.Exception.Message; exit 22 }
'''

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
                    psi.WorkingDirectory = PrinterProRoot; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.WindowStyle = ProcessWindowStyle.Hidden;
                    int exitCode = -1;
                    using (Process p = Process.Start(psi))
                    {
                        if (p == null) throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı çalıştırılamadı.");
                        bool finished = await Task.Run(delegate { try { return p.WaitForExit(50000); } catch { return false; } });
                        if (!finished) { try { p.Kill(); } catch { } throw new InvalidOperationException("Yazıcı PRO servis başlatıcısı zaman aşımına uğradı."); }
                        exitCode = p.ExitCode;
                    }
                    if (exitCode != 0 || !await WaitForPrinterProAsync(8))
                    {
                        string detail = string.Empty;
                        try
                        {
                            string log = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KafePinPro", "logs", "v3156-yazici-startup.log");
                            if (File.Exists(log)) { string[] lines = File.ReadAllLines(log); int take = Math.Min(6, lines.Length); detail = string.Join(" | ", lines, lines.Length - take, take); }
                        }
                        catch { }
                        throw new InvalidOperationException("Yazıcı PRO servisleri başlatılamadı." + (string.IsNullOrWhiteSpace(detail) ? "" : "\n" + detail));
                    }
                }
                await EnsurePrinterBrowserAsync(); ShowPrinterView();
            }
            catch (Exception ex) { MessageBox.Show("Yazıcı PRO açılamadı:\n" + ex.Message, "KafePin Yazıcı PRO", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { printerProButton.Text = "🖨️ Yazıcı PRO"; printerProButton.Enabled = true; }
        }
'''

READY_METHOD = r'''        private async Task<bool> IsPrinterProReadyOnceAsync()
        {
            return await Task.Run(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PrinterProUrl + "api/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    req.Method = "GET"; req.Timeout = 1500; req.ReadWriteTimeout = 1500;
                    req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    {
                        if ((int)resp.StatusCode < 200 || (int)resp.StatusCode >= 300) return false;
                        string isolation = resp.Headers["X-KafePin-Yazici-Isolation"] ?? string.Empty;
                        if (!string.Equals(isolation, "separate-loopback-service", StringComparison.OrdinalIgnoreCase)) return false;
                        if (rd.ReadToEnd().IndexOf("3.1.56-candidate1", StringComparison.OrdinalIgnoreCase) < 0) return false;
                    }
                    HttpWebRequest rev = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:17893/health?_desktop=" + DateTime.UtcNow.Ticks.ToString());
                    rev.Method = "GET"; rev.Timeout = 1500; rev.ReadWriteTimeout = 1500;
                    using (HttpWebResponse resp = (HttpWebResponse)rev.GetResponse())
                    using (StreamReader rd = new StreamReader(resp.GetResponseStream()))
                    { return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 300 && rd.ReadToEnd().IndexOf("3.1.56-candidate1", StringComparison.OrdinalIgnoreCase) >= 0; }
                }
                catch { return false; }
            });
        }
'''

SHORTCUT_FUNCTION = r'''
function Remove-LegacyYaziciProShortcuts {
  $names = @('KafePin Yazıcı PRO.lnk','KafePin Yazici PRO.lnk')
  $roots = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),$(if($env:PUBLIC){Join-Path $env:PUBLIC 'Desktop'}else{$null}))) { if ($candidate -and -not $roots.Contains($candidate)) { [void]$roots.Add($candidate) } }
  $usersRoot = Join-Path $env:SystemDrive 'Users'
  if (Test-Path -LiteralPath $usersRoot) {
    Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      foreach ($candidate in @((Join-Path $_.FullName 'Desktop'),(Join-Path $_.FullName 'OneDrive\Desktop'))) { if ($candidate -and -not $roots.Contains($candidate)) { [void]$roots.Add($candidate) } }
      Get-ChildItem -LiteralPath $_.FullName -Directory -Filter 'OneDrive*' -ErrorAction SilentlyContinue | ForEach-Object { $candidate = Join-Path $_.FullName 'Desktop'; if (-not $roots.Contains($candidate)) { [void]$roots.Add($candidate) } }
    }
  }
  foreach ($root in $roots) { foreach ($name in $names) { $p = Join-Path $root $name; if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop; Write-KafePinLog ('Eski Yazıcı PRO kısayolu kaldırıldı: ' + $p) } catch { Write-KafePinLog ('Yazıcı PRO kısayolu kaldırılamadı: ' + $p + ' :: ' + $_.Exception.Message) } } } }
}
'''

def build():
    if not BASE.exists(): raise SystemExit("base package missing")
    with tempfile.TemporaryDirectory(prefix="kp3156-") as td:
        work = Path(td) / "work"; work.mkdir()
        with zipfile.ZipFile(BASE, "r") as z: z.extractall(work)
        old_payload = work / "v3155-yazici-payload"; payload = work / "v3156-yazici-payload"
        if not old_payload.exists(): raise SystemExit("v3155 payload missing")
        old_payload.rename(payload)

        ws_path = payload / "web_service.py"; ws = ws_path.read_text(encoding="utf-8-sig")
        ws = replace_once(ws, 'APP_VERSION = "3.1.55-candidate1"', 'APP_VERSION = "3.1.56-candidate1"', "web version"); ws_path.write_text(ws, encoding="utf-8")
        js_path = payload / "KafePin_YaziciGelir_Service.js"; js = js_path.read_text(encoding="utf-8-sig")
        js = replace_once(js, 'const VERSION = "3.1.55-candidate1";', 'const VERSION = "3.1.56-candidate1";', "revenue version").replace('v3153-yazici-node.log', 'v3156-yazici-node.log'); js_path.write_text(js, encoding="utf-8")
        (payload / "KafePin_YaziciPRO_ServiceHost.ps1").write_text(SERVICE_HOST, encoding="utf-8-sig")
        (payload / "START_YAZICI_PRO.cmd").write_text('@echo off\nsetlocal\nset "HOSTPS=%~dp0KafePin_YaziciPRO_ServiceHost.ps1"\nif not exist "%HOSTPS%" exit /b 24\npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HOSTPS%" -InstallRoot "%~dp0"\nexit /b %errorlevel%\n', encoding="utf-8")
        ver_path = payload / "yazici-pro-version.json"; v = json.loads(ver_path.read_text(encoding="utf-8-sig")); v.update({"version":"3.1.56","build":"candidate1","desktopShortcut":False,"launch":"main-kafepin-hidden-dual-service-host"})
        fixes=list(v.get("fixes") or [])
        for item in ["field-startup-17891-17893","remove-all-legacy-yazici-shortcuts","hidden-node-python-service-host","version-aware-service-restart"]:
            if item not in fixes: fixes.append(item)
        v["fixes"]=fixes; ver_path.write_text(json.dumps(v,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

        cs_path=work/"desktop-app"/"KafePinProDesktop.cs"; cs=cs_path.read_text(encoding="utf-8-sig")
        cs=replace_method(cs,"        private async void PrinterProButton_Click(object sender, EventArgs e)",PRINTER_CLICK)
        cs=replace_method(cs,"        private async Task<bool> IsPrinterProReadyOnceAsync()",READY_METHOD); cs_path.write_text(cs,encoding="utf-8-sig")

        setup_path=work/"KafePin_Desktop_App_Setup.ps1"; setup=setup_path.read_text(encoding="utf-8-sig")
        setup=setup.replace('[string]$AppVersion = "1.1.4",','[string]$AppVersion = "1.1.5",')
        setup=replace_once(setup,'[switch]$Launch','[switch]$Launch,\n  [switch]$CleanupLegacyYaziciOnly','setup param')
        marker="\ntry {\n  Write-KafePinLog ('KafePin desktop setup basladi. app=' + $AppVersion)"
        if marker not in setup: raise SystemExit("desktop setup try marker missing")
        setup=setup.replace(marker,"\n"+SHORTCUT_FUNCTION+"\nif ($CleanupLegacyYaziciOnly) { Remove-LegacyYaziciProShortcuts; Write-Output 'KAFEPIN_YAZICI_SHORTCUT_CLEANUP_OK'; exit 0 }\n"+marker,1)
        setup=replace_once(setup,"  Remove-OldKafePinBrowserShortcuts\n","  Remove-OldKafePinBrowserShortcuts\n  Remove-LegacyYaziciProShortcuts\n","cleanup call"); setup_path.write_text(setup,encoding="utf-8-sig")

        server_path=work/"server.js"; server=server_path.read_text(encoding="utf-8-sig")
        server=replace_once(server,'KAFEPIN_DESKTOP_APP_VERSION = "1.1.4"','KAFEPIN_DESKTOP_APP_VERSION = "1.1.5"','desktop target'); server_path.write_text(server,encoding="utf-8")

        mgr_path=work/"KafePin_Manager_Ensure.ps1"; mgr=mgr_path.read_text(encoding="utf-8-sig")
        for a,b in [("v3155-yazici-payload","v3156-yazici-payload"),("v3155-yazici-apply.log","v3156-yazici-apply.log"),("v3155-yazici-applied.json","v3156-yazici-applied.json"),("v3.1.55 CANDIDATE1","v3.1.56 CANDIDATE1"),("v3.1.55-candidate1","v3.1.56-candidate1"),("v3.1.55 Yazici payload","v3.1.56 Yazici payload"),("v1.1.4 kuruluyor","v1.1.5 kuruluyor"),("-AppVersion '1.1.4'","-AppVersion '1.1.5'"),("v1.1.4 hazir","v1.1.5 hazir"),("version='3.1.54'; build='candidate1'","version='3.1.56'; build='candidate1'"),("[v3.1.55-candidate1]","[v3.1.56-candidate1]")]: mgr=mgr.replace(a,b)
        if "KafePin_YaziciPRO_ServiceHost.ps1" not in mgr:
            needle="    [pscustomobject]@{ Src='START_YAZICI_PRO.cmd'; Dst='START_YAZICI_PRO.cmd'; Sha='"; idx=mgr.find(needle)
            if idx<0: raise SystemExit("START pair missing")
            line_end=mgr.find("\n",idx); insert="    [pscustomobject]@{ Src='KafePin_YaziciPRO_ServiceHost.ps1'; Dst='KafePin_YaziciPRO_ServiceHost.ps1'; Sha='"+("0"*64)+"' },\n"; mgr=mgr[:line_end+1]+insert+mgr[line_end+1:]
        pair_re=re.compile(r"(\[pscustomobject\]@\{\s*Src='([^']+)';\s*Dst='([^']+)';\s*Sha=')[0-9a-fA-F]{64}(' \},)")
        def repl(m):
            p=payload/m.group(2).replace("\\","/")
            if not p.exists(): raise SystemExit("manager pair source missing: "+m.group(2))
            return m.group(1)+sha256_file(p)+m.group(4)
        mgr,n=pair_re.subn(repl,mgr)
        if n<5: raise SystemExit("too few manager pairs refreshed")
        if "CreateShortcut(" in mgr: raise SystemExit("legacy Yazici shortcut creation returned")
        if any(x in mgr for x in ("Wait-YaziciWeb","Wait-YaziciRevenue","Stop-YaziciRuntime")): raise SystemExit("updater wait regression")
        mgr_path.write_text(mgr,encoding="utf-8-sig")

        meta_path=work/"update.json"; meta=json.loads(meta_path.read_text(encoding="utf-8-sig")); meta.update({"version":"3.1.56","channel":"candidate","stableVersion":"3.1.49","baseVersion":"3.1.49","cumulative":True,"notes":"v3.1.56 saha düzeltmesi: Yazıcı PRO 17891+17893 gizli servis hostu, tüm eski Yazıcı PRO masaüstü kısayollarının silinmesi ve ana KafePin içinden sürüm-doğrulamalı başlatma."})
        meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); files=sorted(str(p.relative_to(work)).replace("\\","/") for p in work.rglob("*") if p.is_file()); meta["files"]=files; meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); files=sorted(str(p.relative_to(work)).replace("\\","/") for p in work.rglob("*") if p.is_file())
        if OUT.exists(): OUT.unlink()
        with zipfile.ZipFile(OUT,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
            for rel in files:
                p=work/rel; zi=zipfile.ZipInfo(rel,FIXED_DT); zi.compress_type=zipfile.ZIP_DEFLATED; zi.external_attr=0o644<<16; z.writestr(zi,p.read_bytes())

    digest=sha256_file(OUT); SHA_FILE.write_text(f"{digest}  {OUT.name}\n",encoding="utf-8")
    LATEST.write_text(json.dumps({"version":"3.1.56","channel":"candidate","stableVersion":"3.1.49","baseVersion":"3.1.49","cumulative":True,"publishedAt":"2026-08-21T11:45:00+03:00","notes":"v3.1.56 ADAY — gerçek saha hatası düzeltmesi. Eski Yazıcı PRO masaüstü kısayolları tüm kullanıcı profillerinden kaldırılır; 17891+17893 görünmez süreçlerle ve sürüm doğrulamasıyla başlatılır; ana KafePin içinden açılır.","downloadUrl":"https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.56.zip","sha256":digest},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    REPORT.write_text("# KafePin Pro v3.1.56 ADAY — Saha Düzeltme Test Raporu\n\n- STABLE: **3.1.49**\n- Aday: **3.1.56**\n- Hedef: gerçek PC'de görülen 17891/17893 başlatma hatası, görünür gelir konsolu ve kalmış Yazıcı PRO masaüstü kısayolları.\n- Windows saha-reprodüksiyon test sonuçları CI tamamlandığında güncellenecektir.\n- Paket SHA256: `"+digest+"`\n",encoding="utf-8")
    print("V3156_BUILD_OK",digest,OUT.stat().st_size)

if __name__ == "__main__": build()
