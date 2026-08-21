from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ZIP = ROOT / "KafePin-Pro-Update-v3.1.53.zip"
SHA = ROOT / "KafePin-Pro-Update-v3.1.53.sha256.txt"
LATEST = ROOT / "latest.json"
REPORT = ROOT / "V3.1.53-CANDIDATE-TEST-REPORT.md"


def h(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rw(path: Path, fn, bom: bool = False) -> None:
    text = path.read_text(encoding="utf-8-sig")
    path.write_text(fn(text), encoding="utf-8-sig" if bom else "utf-8")


def patch_payload(root: Path) -> None:
    payload = root / "v3153-yazici-payload"

    # Backend: old service must not survive the update. Word must use Office COM, not PATH lookup.
    p = payload / "web_service.py"
    s = p.read_text(encoding="utf-8-sig")
    s = s.replace('APP_VERSION = "3.1.53-candidate1"', 'APP_VERSION = "3.1.53-candidate3"')
    s = s.replace('["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]',
                  '["powershell.exe", "-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]')
    old = '''    def open_word_blank(self) -> dict:\n        try:\n            subprocess.Popen(["powershell.exe", "-NoProfile", "-Command", "Start-Process winword.exe"], creationflags=_hidden_flags())\n        except Exception as exc:\n            raise RuntimeError(f"Microsoft Word açılamadı: {exc}") from exc\n        with self.lock:\n            self.status = "Microsoft Word açılıyor."\n        return {"ok": True}\n'''
    new = '''    def open_word_blank(self) -> dict:\n        # WINWORD.EXE her kurulumda PATH içinde olmayabilir. Office COM kaydı daha güvenilirdir.\n        script = r"""\n$ErrorActionPreference='Stop'\n$word=New-Object -ComObject Word.Application\n$word.Visible=$true\n[void]$word.Documents.Add()\n$word.Activate()\n"""\n        try:\n            _run_inline_powershell(script, timeout=30)\n        except Exception as exc:\n            raise RuntimeError(f"Microsoft Word açılamadı. Word kurulumunu/Office COM kaydını kontrol et: {exc}") from exc\n        with self.lock:\n            self.status = "Microsoft Word açıldı."\n        return {"ok": True, "method": "office-com"}\n'''
    if old not in s:
        raise RuntimeError("candidate1 Word block not found")
    p.write_text(s.replace(old, new), encoding="utf-8")

    # Launcher: use STA, verify candidate3 backend, and install Evergreen Runtime only at app launch.
    p = payload / "KafePin_YaziciPRO_WebView2.ps1"
    s = p.read_text(encoding="utf-8-sig")
    s = s.replace("3153candidate1", "3153candidate3")
    s = s.replace("$ErrorActionPreference = 'Stop'", "$ErrorActionPreference = 'Stop'\n[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12")
    s = s.replace("$NugetUrl = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/' + $SdkVersion",
                  "$NugetUrl = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/' + $SdkVersion\n$RuntimeBootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'")
    marker = "  for ($i=0; $i -lt 25; $i++) {"
    runtime = '''  # SDK DLL'leri tek başına yeterli değildir; Evergreen Runtime da gerekir.\n  try {\n    $runtimeVersion = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()\n    Log ('WebView2 Runtime: ' + $runtimeVersion)\n  } catch {\n    Log 'WebView2 Runtime bulunamadi; Microsoft Evergreen Bootstrapper kuruluyor.'\n    $bootstrapper = Join-Path $env:TEMP 'MicrosoftEdgeWebView2Setup.exe'\n    Invoke-WebRequest -UseBasicParsing -Uri $RuntimeBootstrapperUrl -OutFile $bootstrapper -TimeoutSec 120\n    $proc = Start-Process -FilePath $bootstrapper -ArgumentList @('/silent','/install') -Wait -PassThru\n    Remove-Item -LiteralPath $bootstrapper -Force -ErrorAction SilentlyContinue\n    Start-Sleep -Seconds 2\n    $runtimeVersion = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()\n    Log ('WebView2 Runtime kuruldu: ' + $runtimeVersion + ' exit=' + [string]$proc.ExitCode)\n  }\n\n'''
    if marker not in s:
        raise RuntimeError("WebView2 health marker not found")
    s = s.replace(marker, runtime + marker, 1)
    s = s.replace("if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { break }",
                  "if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300 -and $r.Content -match '3.1.53-candidate3') { break }")
    s = s.replace("$form.Text = 'KafePin Yazıcı PRO 3.1.53'", "$form.Text = 'KafePin Yazıcı PRO 3.1.53 • WhatsApp Web'")
    p.write_text(s, encoding="utf-8-sig")

    # Canonical launcher restarts only Yazici PRO runtimes and verifies candidate3 before opening UI.
    start_cmd = r'''@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%~dp0"
set "LOGDIR=%ProgramData%\KafePinPro\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul
set "NODE="
if exist "%ROOT%node-path.txt" set /p NODE=<"%ROOT%node-path.txt"
if not defined NODE if exist "C:\KafePin\node\node.exe" set "NODE=C:\KafePin\node\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%ROOT%.venv\Scripts\python.exe" (
  echo Yazici PRO Python ortami bulunamadi: %ROOT%.venv\Scripts\python.exe
  pause
  exit /b 21
)

rem Eski Yazici PRO runtime kalmasin; baska KafePin Python servislerine dokunma.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $self=$PID; Get-CimInstance Win32_Process | ? { $c=[string]$_.CommandLine; $n=[string]$_.Name; ([int]$_.ProcessId -ne [int]$self) -and $c -and ((($n -ieq 'python.exe' -or $n -ieq 'pythonw.exe') -and $c.IndexOf('web_service.py',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.IndexOf('KafePinYaziciPRO',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'node.exe') -and $c.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'powershell.exe' -or $n -ieq 'pwsh.exe') -and $c.IndexOf('KafePin_YaziciPRO_WebView2.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0)) } | %% { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }" >nul 2>nul
timeout /t 1 /nobreak >nul

if defined NODE if exist "%NODE%" start "KafePin Yazici Gelir" /min "%NODE%" "%ROOT%KafePin_YaziciGelir_Service.js"
del /q "%LOGDIR%\v3153-webservice.out.log" "%LOGDIR%\v3153-webservice.err.log" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%ROOT%.venv\Scripts\python.exe' -ArgumentList @('%ROOT%web_service.py') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\v3153-webservice.out.log' -RedirectStandardError '%LOGDIR%\v3153-webservice.err.log'" >nul 2>nul

set "READY="
for /L %%I in (1,1,20) do (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try{$j=Invoke-RestMethod 'http://127.0.0.1:17891/api/health' -TimeoutSec 1;if($j.ok -and $j.version -eq '3.1.53-candidate3'){exit 0}}catch{};exit 1" >nul 2>nul
  if not errorlevel 1 (
    set "READY=1"
    goto :WEBREADY
  )
  timeout /t 1 /nobreak >nul
)
:WEBREADY
if not defined READY (
  echo Yazici PRO 3.1.53 servisi baslamadi.
  echo Hata kaydi: %LOGDIR%\v3153-webservice.err.log
  if exist "%LOGDIR%\v3153-webservice.err.log" start "" notepad.exe "%LOGDIR%\v3153-webservice.err.log"
  pause
  exit /b 22
)

if exist "%ROOT%KafePin_YaziciPRO_WebView2.ps1" (
  start "KafePin Yazici PRO" powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%ROOT%KafePin_YaziciPRO_WebView2.ps1" -LocalUrl "http://127.0.0.1:17891/?v=3153candidate3"
) else (
  start "" "http://127.0.0.1:17891/?v=3153candidate3"
)
exit /b 0
'''
    (payload / "START_YAZICI_PRO.cmd").write_text(start_cmd, encoding="utf-8")

    # Version marker.
    vp = payload / "yazici-pro-version.json"
    v = json.loads(vp.read_text(encoding="utf-8-sig"))
    v["version"] = "3.1.53"
    v["build"] = "candidate3"
    v["fixes"] = ["runtime-restart-healthcheck", "desktop-shortcut-launcher", "word-office-com", "webview2-runtime-bootstrapper", "updater-timeout-safe"]
    vp.write_text(json.dumps(v, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Update metadata.
    up = root / "update.json"
    u = json.loads(up.read_text(encoding="utf-8-sig"))
    u["notes"] = ("v3.1.53 ADAY / candidate3 — v3.1.49 STABLE tabanlı KÜMÜLATİF güncelleme. "
                  "spawnSync powershell.exe ETIMEDOUT düzeltildi: Server Manager ön-kontrolünde Yazıcı PRO servis restartı, health beklemesi veya WebView2 indirmesi yapılmaz. "
                  "Yazıcı PRO runtime ilk açılışta candidate3 health ile doğrulanır. WORD AÇ Office COM ile çalışır. WhatsApp Web WebView2 sekmesidir. "
                  "AI metne çevirme otomatik satış oluşturmaz; satış yalnız açık onayla KafePin Doğrudan Satış'a gider. EveryCafe salt-okunur kalır. STABLE v3.1.49 olarak kalır.")
    up.write_text(json.dumps(u, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Manager: install files quickly; never wait for Yazici runtime inside the 35-second Server Manager pre-check.
    mgr = root / "KafePin_Manager_Ensure.ps1"
    s = mgr.read_text(encoding="utf-8-sig")
    begin = s.index("  # v3.1.53 CANDIDATE1")
    end = s.index("  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf))", begin)
    files = [
        ("index.html", r"web\index.html"), ("v3153-ai.js", r"web\v3153-ai.js"), ("web_service.py", "web_service.py"),
        ("KafePin_YaziciGelir_Service.js", "KafePin_YaziciGelir_Service.js"), ("START_YAZICI_PRO.cmd", "START_YAZICI_PRO.cmd"),
        ("KafePin_YaziciPRO_WebView2.ps1", "KafePin_YaziciPRO_WebView2.ps1"), ("KafePin_AI_Ayarla.ps1", "KafePin_AI_Ayarla.ps1"),
        ("KafePin_AI_Ayarla.cmd", "KafePin_AI_Ayarla.cmd"), ("yazici-pro-version.json", "yazici-pro-version.json")]
    pairs = ",\n".join(f"    [pscustomobject]@{{ Src='{src}'; Dst='{dst}'; Sha='{h(payload/src)}' }}" for src, dst in files)
    block = r'''  # v3.1.53 CANDIDATE3 - hizli ve guvenli Yazici PRO uygulamasi.
  # Server Manager on-kontrolu 35 sn timeout ile calisir; burada runtime beklenmez.
  $YaziciPayload = Join-Path $InstallRoot 'v3153-yazici-payload'
  $YaziciRoot = Join-Path $InstallRoot 'KafePinYaziciPRO'
  $YaziciWeb = Join-Path $YaziciRoot 'web'
  $YaziciLog = Join-Path $LogDir 'v3153-yazici-apply.log'
  function YaziciLog([string]$Text) { try { Add-Content -LiteralPath $YaziciLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [v3.1.53-candidate3] ' + $Text) -Encoding UTF8 } catch {} }
  function YaziciFileSha([string]$P) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $P).Hash.ToLowerInvariant() }
  if (-not (Test-Path -LiteralPath $YaziciPayload -PathType Container)) { throw 'v3.1.53 Yazici payload klasoru bulunamadi.' }
  if (-not (Test-Path -LiteralPath $YaziciRoot -PathType Container)) { throw ('Yazici PRO kurulum klasoru bulunamadi: ' + $YaziciRoot) }
  New-Item -ItemType Directory -Force -Path $YaziciWeb | Out-Null
  $pairs = @(
__PAIRS__
  )
  foreach ($pair in $pairs) {
    $src = Join-Path $YaziciPayload ([string]$pair.Src); $dst = Join-Path $YaziciRoot ([string]$pair.Dst)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw ('Yazici payload dosyasi eksik: ' + [string]$pair.Src) }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    if ((YaziciFileSha $dst) -ne [string]$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }
  }
  $indexRaw = Get-Content -LiteralPath (Join-Path $YaziciWeb 'index.html') -Raw -Encoding UTF8
  foreach ($marker in @('v3153Verified','FOTOKOP','WHATSAPP WEB','BELGE / DİLEKÇE & AI','FOTOĞRAFTAN WORD','confirm3153Delete','KAFEP')) { if ($indexRaw.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw ('Yazici PRO marker yok: ' + $marker) } }
  Set-Content -LiteralPath (Join-Path $YaziciRoot 'node-path.txt') -Value $node -Encoding ASCII
  try { & wevtutil.exe sl 'Microsoft-Windows-PrintService/Operational' /e:true 2>$null | Out-Null } catch {}
  $startCmd = Join-Path $YaziciRoot 'START_YAZICI_PRO.cmd'
  try {
    $shell = New-Object -ComObject WScript.Shell; $desktopDirs = @([Environment]::GetFolderPath('Desktop')); if ($env:PUBLIC) { $desktopDirs += (Join-Path $env:PUBLIC 'Desktop') }
    foreach ($desk in ($desktopDirs | Select-Object -Unique)) { if (-not $desk) { continue }; New-Item -ItemType Directory -Force -Path $desk | Out-Null; $lnk=Join-Path $desk 'KafePin Yazıcı PRO.lnk'; $sc=$shell.CreateShortcut($lnk); $sc.TargetPath=$startCmd; $sc.WorkingDirectory=$YaziciRoot; $sc.Description='KafePin Yazıcı PRO 3.1.53'; $sc.Save() }
  } catch { YaziciLog ('Kisayol uyarisi: ' + $_.Exception.Message) }
  [ordered]@{ version='3.1.53'; build='candidate3'; appliedAt=(Get-Date).ToString('o'); yaziciRoot=$YaziciRoot; runtimeActivation='on-first-launch'; updaterWait='none' } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $SystemRoot 'v3153-yazici-applied.json') -Encoding UTF8
'''.replace("__PAIRS__", pairs)
    mgr.write_text(s[:begin] + block + s[end:], encoding="utf-8-sig")


def rebuild(root: Path) -> str:
    update = json.loads((root / "update.json").read_text(encoding="utf-8-sig"))
    files = update["files"]
    tmp = ZIP.with_suffix(".candidate3.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            zf.write(root / rel, rel)
    with zipfile.ZipFile(tmp) as zf:
        assert zf.testzip() is None
        assert zf.namelist() == files
    tmp.replace(ZIP)
    digest = h(ZIP)
    SHA.write_text(f"{digest}  {ZIP.name}\n", encoding="ascii")
    latest = json.loads(LATEST.read_text(encoding="utf-8-sig"))
    latest.update({"version":"3.1.53","channel":"candidate","stableVersion":"3.1.49","baseVersion":"3.1.49","cumulative":True,
                   "notes":update["notes"],"downloadUrl":"https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.53.zip","sha256":digest})
    LATEST.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    REPORT.write_text(REPORT.read_text(encoding="utf-8-sig") + "\n\n## candidate3 timeout düzeltmesi\n\n- `spawnSync powershell.exe ETIMEDOUT` sebebi giderildi.\n- Yazıcı runtime/WebView2 beklemeleri `KafePin_Manager_Ensure.ps1` içinden çıkarıldı.\n- Runtime yalnız ilk Yazıcı PRO açılışında candidate3 health ile doğrulanır.\n- STABLE sürüm v3.1.49 olarak kalır.\n", encoding="utf-8")
    return digest


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="kp3153c3-") as td:
        root = Path(td)
        with zipfile.ZipFile(ZIP) as zf:
            zf.extractall(root)
        patch_payload(root)
        mgr = (root / "KafePin_Manager_Ensure.ps1").read_text(encoding="utf-8-sig")
        assert "Wait-YaziciWeb" not in mgr and "Wait-YaziciRevenue" not in mgr and "Stop-YaziciRuntime" not in mgr
        assert "updaterWait='none'" in mgr
        web = (root / "v3153-yazici-payload/web_service.py").read_text(encoding="utf-8-sig")
        assert 'APP_VERSION = "3.1.53-candidate3"' in web and "Word.Application" in web
        start = (root / "v3153-yazici-payload/START_YAZICI_PRO.cmd").read_text(encoding="utf-8-sig")
        assert "3.1.53-candidate3" in start and "-STA" in start
        launcher = (root / "v3153-yazici-payload/KafePin_YaziciPRO_WebView2.ps1").read_text(encoding="utf-8-sig")
        assert "web.whatsapp.com" in launcher and "RuntimeBootstrapperUrl" in launcher
        print("CANDIDATE3_PATCH_OK", rebuild(root))


if __name__ == "__main__":
    main()
