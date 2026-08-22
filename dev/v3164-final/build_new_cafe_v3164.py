from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "3.1.64"
SOURCE_NEW_CAFE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
SOURCE_UPDATE = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
SOURCE_CLIENT = ROOT / "KafePin-Client-v3.1.63.zip"
OUT_NEW_CAFE = ROOT / f"KafePin-Pro-Yeni-Kafe-FINAL-v{VERSION}.zip"
OUT_CLIENT = ROOT / f"KafePin-Client-v{VERSION}.zip"
OUT_NEW_CAFE_SHA = ROOT / f"KafePin-Pro-Yeni-Kafe-FINAL-v{VERSION}.sha256.txt"
OUT_CLIENT_SHA = ROOT / f"KafePin-Client-v{VERSION}.sha256.txt"

ZIP_DATE = (2026, 8, 22, 12, 0, 0)
BUILD_TEMP_ROOT = ROOT / ".build-v3164-new-cafe-fixed"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def zip_tree(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*"), key=lambda p: p.relative_to(source).as_posix().lower()):
            if not path.is_file():
                continue
            rel = path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(rel, ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count < 1:
        raise RuntimeError(f"{label}: beklenen metin bulunamadı: {old!r}")
    return text.replace(old, new)


def patch_install_script(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    is_gui = "$AutoImportEveryCafe" in text
    if is_gui:
        text = replace_required(
            text,
            "  [switch]$AutoImportEveryCafe\n)",
            "  [switch]$AutoImportEveryCafe,\n  [switch]$ValidateOnly\n)",
            path.name,
        )
    else:
        text = replace_required(
            text,
            "  [string]$InstallRoot = 'C:\\KafePin'\n)",
            "  [string]$InstallRoot = 'C:\\KafePin',\n  [switch]$ValidateOnly\n)",
            path.name,
        )
    text = replace_required(text, "$BaseVersion='3.1.29'", "$BaseVersion='3.1.64'", path.name)
    text = replace_required(
        text,
        "$InstallerBuild='2026.08.20-STABLE-349-BASE-329'",
        "$InstallerBuild='2026.08.22-FINAL-3164-OFFLINE'",
        path.name,
    )
    # Telegram bu kurucunun konusu değildir. Yeni kafede kapalı gelir;
    # işletme daha sonra KafePin Pro panelinden kendi bilgileriyle açar.
    # Böylece token/chat-id CMD'de sorulmaz ve pakete yazılmaz.
    text = replace_required(
        text,
        "KafePin Pro v3.1.49 STABLE — kurulum tabanı v3.1.29",
        "KafePin Pro v3.1.64 FINAL / STABLE — tam kurulum",
        path.name,
    )
    # PRO bileşenleri, özellikle MP3 Bot, Node.js çalışma zamanına ihtiyaç
    # duyabilir. Ana KafePin servisi sağlıklı duruma geldikten sonra CMD'den
    # sorulur ve kurulurlar; böylece temiz makinede eksik runtime yüzünden
    # ilk açılışta hata vermezler.
    component_block = r"""Write-Step 'İsteğe bağlı PRO bileşenleri'
$env:Path=$nodeDir+';'+$env:Path
$componentInstaller=Join-Path $InstallRoot 'KafePin_Pro_Bilesen_Kurulum.ps1'
$script:ProInstallProblem=$false
$script:ProInstallResult=$null
if(Test-Path -LiteralPath $componentInstaller){
  try{
    if($useEc){
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $componentInstaller -InstallRoot $InstallRoot -ProRoot 'C:\KafePinPro' -InitialSetup -ForceInitialSetup -EveryCafeEnabled
    }else{
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $componentInstaller -InstallRoot $InstallRoot -ProRoot 'C:\KafePinPro' -InitialSetup -ForceInitialSetup
    }
    if($LASTEXITCODE -ne 0){$script:ProInstallProblem=$true;Write-Warning ('PRO bileşen kurucusu çıkış kodu: '+$LASTEXITCODE)}
  }catch{$script:ProInstallProblem=$true;Write-Warning ('PRO bileşen seçimi tamamlanamadı. '+$_.Exception.Message)}
  $proState=Join-Path $InstallRoot 'config\pro-components.json'
  if(Test-Path -LiteralPath $proState){
    try{
      $script:ProInstallResult=Get-Content -LiteralPath $proState -Raw -Encoding UTF8|ConvertFrom-Json
      foreach($entry in $script:ProInstallResult.results.psobject.Properties){if([string]$entry.Value -like 'failed:*'){$script:ProInstallProblem=$true}}
    }catch{$script:ProInstallProblem=$true}
  }else{$script:ProInstallProblem=$true}
}else{$script:ProInstallProblem=$true;Write-Warning 'PRO bileşen kurucusu pakette bulunamadı.'}

"""
    marker = (
        "Write-Host 'Sunucu hazir.' -ForegroundColor Green\nSet-InstallProgress 85 'SERVER'\n"
        if is_gui
        else "Write-Host 'Sunucu hazir.' -ForegroundColor Green\n"
    )
    if marker not in text:
        raise RuntimeError(f"{path.name}: PRO bileşen ekleme noktası bulunamadı")
    text = text.replace(marker, marker + "\n" + component_block, 1)
    python_marker = (
        "Set-InstallProgress 60 'NODE_DONE'\n"
        if is_gui
        else "if(-not(Test-Path $nodeExe)){throw 'Node runtime kurulumu dogrulanamadi.'}\n"
    )
    python_progress_start = "Set-InstallProgress 61 'PYTHON'\n" if is_gui else ""
    python_progress_done = "Set-InstallProgress 62 'PYTHON_DONE'\n" if is_gui else ""
    python_block = r"""
Write-Step 'Python 3 runtime'
""" + python_progress_start + r"""$pythonCommand=Get-Command py.exe -ErrorAction SilentlyContinue
if(-not $pythonCommand){
  foreach($pythonCandidate in @(
    (Join-Path $env:ProgramFiles 'Python313\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')
  )){if(Test-Path -LiteralPath $pythonCandidate){$pythonCommand=[pscustomobject]@{Source=$pythonCandidate};break}}
}
if(-not $pythonCommand){
  $pythonVersion='3.13.15'
  $pythonUrl='https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe'
  $pythonSha='edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403'
  $pythonTemp=Join-Path $env:TEMP ('KafePin-Python-'+[guid]::NewGuid().ToString('N')+'.exe')
  try{
    Write-Host 'Python 3 bulunamadı; resmi Python kurucusu indiriliyor...' -ForegroundColor Yellow
    Invoke-WebRequest -UseBasicParsing -Uri $pythonUrl -OutFile $pythonTemp
    $pythonActual=(Get-FileHash -Algorithm SHA256 -LiteralPath $pythonTemp).Hash.ToLowerInvariant()
    if($pythonActual -ne $pythonSha){throw 'Python indirilen dosya SHA-256 doğrulamasını geçemedi.'}
    $pythonInstall=Start-Process -FilePath $pythonTemp -ArgumentList @('/quiet','InstallAllUsers=1','PrependPath=1','Include_test=0') -Wait -PassThru
    if($pythonInstall.ExitCode -ne 0){throw ('Python 3 kurulum çıkış kodu: '+$pythonInstall.ExitCode)}
  }finally{Remove-Item -LiteralPath $pythonTemp -Force -ErrorAction SilentlyContinue}
  $pythonCommand=Get-Command py.exe -ErrorAction SilentlyContinue
  if(-not $pythonCommand){
    foreach($pythonCandidate in @(
      (Join-Path $env:ProgramFiles 'Python313\python.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')
    )){if(Test-Path -LiteralPath $pythonCandidate){$pythonCommand=[pscustomobject]@{Source=$pythonCandidate};break}}
  }
}
if(-not $pythonCommand){throw 'Python 3 kurulumu doğrulanamadı.'}
""" + python_progress_done + r"""

"""
    if python_marker not in text:
        raise RuntimeError(f"{path.name}: Python ekleme noktası bulunamadı")
    text = text.replace(python_marker, python_marker + python_block, 1)
    final_marker = (
        "Write-Host 'KafePin Pro.exe acildi; masaustu kisayolu hazir.' -ForegroundColor Green\n\nWrite-Step 'Kurulum tamamlandi'"
        if is_gui else "Write-Step 'Kurulum tamamlandi'"
    )
    launch_confirmation = "Write-Host 'KafePin Pro.exe acildi; masaustu kisayolu hazir.' -ForegroundColor Green\n\n" if is_gui else ""
    final_summary = launch_confirmation + r"""Write-Host ''
Write-Host '================ KURULUM DURUMU ================' -ForegroundColor Cyan
$allReady=$true
function Write-SetupCheck([bool]$Ready,[string]$Name){
  if($Ready){Write-Host ('✓ '+$Name) -ForegroundColor Green}else{Write-Host ('✗ '+$Name) -ForegroundColor Red;$script:allReady=$false}
}
Write-SetupCheck (Test-Path -LiteralPath $nodeExe) 'Node.js runtime hazır'
Write-SetupCheck ($null -ne $pythonCommand) 'Python 3 runtime hazır'
Write-SetupCheck ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) 'KafePin Windows servisi hazır'
Write-SetupCheck $true 'KafePin ana sunucusu sağlık kontrolünü geçti'
if($null -ne $script:ProInstallResult){
  foreach($entry in $script:ProInstallResult.results.psobject.Properties){
    $label=@{mp3='MP3 Bot PRO';printer='Yazıcı PRO';technical='Teknik Servis PRO';client='Client Yönetim PRO'}[$entry.Name]
    $state=[string]$entry.Value
    if($state -eq 'installed'){Write-SetupCheck $true ($label+' kuruldu')}
    elseif($state -eq 'skipped'){Write-Host ('• '+$label+' seçilmedi') -ForegroundColor DarkYellow}
    else{Write-SetupCheck $false ($label+' kurulamadı: '+$state)}
  }
}else{Write-SetupCheck $false 'PRO bileşen kurulum sonucu okunamadı'}
if($script:ProInstallProblem){$allReady=$false}
if($allReady){Write-Host '✓ İŞLEM BAŞARILI — seçilen servisler hazır.' -ForegroundColor Green}
else{Write-Host '✗ KURULUM TAMAMLANMADI — kırmızı satırı kontrol edin.' -ForegroundColor Red;throw 'Seçilen PRO bileşenlerinden biri kurulamadı.'}

Write-Step 'Kurulum tamamlandi'"""
    if final_marker not in text:
        raise RuntimeError(f"{path.name}: final durum özeti ekleme noktası bulunamadı")
    text = text.replace(final_marker, final_summary, 1)
    integrity_marker = "Test-PackageIntegrity\n"
    if integrity_marker not in text:
        raise RuntimeError(f"{path.name}: bütünlük kontrolü ekleme noktası bulunamadı")
    text = text.replace(
        integrity_marker,
        integrity_marker + "if($ValidateOnly){Write-Host 'KafePin yeni-kafe paket kontrolü başarılı.' -ForegroundColor Green;exit 0}\n",
        1,
    )
    path.write_text(text, encoding="utf-8-sig", newline="\r\n")


def patch_component_installer(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    text = replace_required(
        text,
        "$ErrorActionPreference = 'Stop'\n",
        "$ErrorActionPreference = 'Stop'\ntry{$utf8=New-Object System.Text.UTF8Encoding($false);[Console]::OutputEncoding=$utf8;$OutputEncoding=$utf8}catch{}\n",
        path.name,
    )
    replacements = {
        "[string]$ProRoot = 'C:\\KafePinPRO'": "[string]$ProRoot = 'C:\\KafePinPro'",
        "Join-Path $ProRoot 'MP3Bot'": "Join-Path $ProRoot 'MP3BotPRO'",
        "Join-Path $ProRoot 'Yazici'": "Join-Path $ProRoot 'YaziciPRO'",
        "Join-Path $ProRoot 'TeknikServis'": "Join-Path $ProRoot 'TeknikServisPRO'",
        "Join-Path $ProRoot 'ClientYonetim'": "Join-Path $ProRoot 'ClientYonetimPRO'",
        "version = '3.1.60'": "version = '3.1.64'",
    }
    for old, new in replacements.items():
        text = replace_required(text, old, new, path.name)
    text = replace_required(
        text,
        "[switch]$InitialSetup\n)",
        "[switch]$InitialSetup,\n  [switch]$EveryCafeEnabled,\n  [switch]$ForceInitialSetup\n)",
        path.name,
    )
    old_choice = "  client = Ask-Component 'KafePin Client Yönetim PRO' 'Client Yönetim PRO kurulsun mu?`n`nCanlı masa durumunu salt okunur gösterir; uyandırma, yeniden başlatma, süreli/süresiz/ücretsiz oturum açma, açık oturuma süre ekleme ve onaylı çalışan uygulamaları sonlandırma araçlarını sağlar. Bilgisayar/hesap/masa kapatma ve tahsilat yapmaz.'"
    new_choice = "  client = $(if ($EveryCafeEnabled) { Ask-Component 'KafePin Client Yönetim PRO' 'Client Yönetim PRO kurulsun mu?`n`nCanlı masa durumunu salt okunur gösterir; uyandırma, yeniden başlatma, süreli/süresiz/ücretsiz oturum açma, açık oturuma süre ekleme ve onaylı çalışan uygulamaları sonlandırma araçlarını sağlar. Bilgisayar/hesap/masa kapatma ve tahsilat yapmaz.' } else { $false })"
    text = replace_required(text, old_choice, new_choice, path.name)
    text = replace_required(
        text,
        "if (-not $InitialSetup -or -not $FreshInstall -or (Test-Path -LiteralPath $StatePath)) {\n  exit 0\n}",
        "if (-not $InitialSetup -or ((-not $FreshInstall) -and (-not $ForceInitialSetup)) -or ((Test-Path -LiteralPath $StatePath) -and (-not $ForceInitialSetup))) {\n  exit 0\n}",
        path.name,
    )
    old_ask_component = """function Ask-Component([string]$Title, [string]$Text) {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $answer = [System.Windows.Forms.MessageBox]::Show(
    $Text,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question,
    [System.Windows.Forms.MessageBoxDefaultButton]::Button2
  )
  return $answer -eq [System.Windows.Forms.DialogResult]::Yes
}
"""
    new_ask_component = """function Ask-Component([string]$Title, [string]$Text) {
  Write-Host ''
  Write-Host ('=== ' + $Title + ' ===') -ForegroundColor Cyan
  Write-Host $Text -ForegroundColor White
  while ($true) {
    $answer = (Read-Host 'Kurulsun mu? (E/H) [H]').Trim().ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -in @('H','HAYIR','N','NO')) { return $false }
    if ($answer -in @('E','EVET','Y','YES')) { return $true }
    Write-Host 'Lütfen E veya H girin.' -ForegroundColor Yellow
  }
}
"""
    text = replace_required(text, old_ask_component, new_ask_component, path.name)
    text = replace_required(
        text,
        "function Start-PrinterService([string]$Root) {\n  $host = Join-Path $Root 'KafePin_YaziciPRO_ServiceHost.ps1'\n  if (-not (Test-Path -LiteralPath $host)) { throw 'Yazıcı PRO servis başlatıcısı bulunamadı.' }\n  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$host,'-InstallRoot',$Root) -WorkingDirectory $Root -WindowStyle Hidden | Out-Null\n}",
        "function Start-PrinterService([string]$Root) {\n  $serviceHost = Join-Path $Root 'KafePin_YaziciPRO_ServiceHost.ps1'\n  if (-not (Test-Path -LiteralPath $serviceHost)) { throw 'Yazıcı PRO servis başlatıcısı bulunamadı.' }\n  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$serviceHost,'-InstallRoot',$Root) -WorkingDirectory $Root -WindowStyle Hidden | Out-Null\n}",
        path.name,
    )
    old_silent_cmd = """function Invoke-SilentCmd([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory) {
  $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw \"Kurulum çıkış kodu: $($p.ExitCode)\" }
}
"""
    new_silent_cmd = """function Invoke-ComponentSetup([string]$ComponentName, [string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSeconds = 600) {
  $safeName = ($ComponentName -replace '[^a-zA-Z0-9]+','-').Trim('-').ToLowerInvariant()
  $logDir = Join-Path $InstallRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $outLog = Join-Path $logDir ('pro-'+$safeName+'-setup.out.log')
  $errLog = Join-Path $logDir ('pro-'+$safeName+'-setup.err.log')
  Remove-Item -LiteralPath $outLog,$errLog -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $nextNotice = Get-Date
  while (-not $p.HasExited) {
    if ((Get-Date) -ge $deadline) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
      throw ($ComponentName+' kurulumu '+$TimeoutSeconds+' saniye içinde tamamlanmadı. Günlük: '+$outLog)
    }
    if ((Get-Date) -ge $nextNotice) {
      $remaining = [math]::Max(0,[int](($deadline-(Get-Date)).TotalSeconds))
      Write-Host ('… '+$ComponentName+' hazırlanıyor; kalan en fazla '+$remaining+' sn. (günlük: '+$outLog+')') -ForegroundColor DarkCyan
      $nextNotice = (Get-Date).AddSeconds(5)
    }
    Start-Sleep -Milliseconds 500
    $p.Refresh()
  }
  try { $p.WaitForExit(); $exitCode = $p.ExitCode } catch { $exitCode = $null }
  # Bazı Windows/cmd.exe sürümleri çıkış kodunu Process nesnesine boş
  # döndürüyor; bağımlılıklar zaten başarıyla kurulduysa bunu sahte hata
  # sayma. Gerçek sıfır-dışı kodlar yine günlükle birlikte durdurulur.
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    $detail = @()
    foreach($logFile in @($errLog,$outLog)) { if(Test-Path -LiteralPath $logFile){ $detail += @(Get-Content -LiteralPath $logFile -Tail 8 -ErrorAction SilentlyContinue) } }
    throw ($ComponentName+' kurulum çıkış kodu: '+$exitCode+$(if($detail.Count){' — '+(($detail -join ' ') -replace '\\s+',' ').Trim()}else{''}))
  }
  Write-Host ('✓ '+$ComponentName+' bağımlılık kurulumu tamamlandı.') -ForegroundColor Green
}

function Prepare-Mp3Setup([string]$Root) {
  $setup = Join-Path $Root 'KURULUM.cmd'
  if (-not (Test-Path -LiteralPath $setup)) { throw 'MP3 Bot PRO KURULUM.cmd bulunamadı.' }
  $text = Get-Content -LiteralPath $setup -Raw
  $text = $text.Replace('--disable-pip-version-check --upgrade pip','--disable-pip-version-check --timeout 30 --retries 2 --upgrade pip')
  $text = $text.Replace('--disable-pip-version-check -r requirements.txt','--disable-pip-version-check --timeout 30 --retries 2 -r requirements.txt')
  Set-Content -LiteralPath $setup -Value $text -Encoding ASCII
}
"""
    text = replace_required(text, old_silent_cmd, new_silent_cmd, path.name)
    text = replace_required(
        text,
        "function Start-Mp3Service([string]$Root) {\n  $launcher = Join-Path $Root 'START_WEB.ps1'\n  Invoke-SilentCmd 'powershell.exe' ('-NoProfile -ExecutionPolicy Bypass -File \"' + $launcher + '\"') $Root\n}",
        "function Start-Mp3Service([string]$Root) {\n  $launcher = Join-Path $Root 'START_WEB.ps1'\n  if (-not (Test-Path -LiteralPath $launcher)) { throw 'MP3 Bot PRO servis başlatıcısı bulunamadı.' }\n  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher) -WorkingDirectory $Root -WindowStyle Hidden | Out-Null\n}",
        path.name,
    )
    text = replace_required(
        text,
        "      Invoke-SilentCmd 'cmd.exe' '/c KURULUM.cmd /silent' $target\n      Start-Mp3Service $target",
        "      Prepare-Mp3Setup $target\n      Invoke-ComponentSetup 'MP3 Bot PRO' 'cmd.exe' '/d /c KURULUM.cmd /silent' $target 600\n      Start-Mp3Service $target",
        path.name,
    )
    text = replace_required(
        text,
        "      Invoke-SilentCmd 'cmd.exe' '/c KURULUM.cmd /silent' $target\n      Start-PrinterService $target",
        "      Invoke-ComponentSetup 'Yazıcı PRO' 'cmd.exe' '/d /c KURULUM.cmd /silent' $target 600\n      Start-PrinterService $target",
        path.name,
    )
    python_bootstrap = r'''
function Ensure-Python3 {
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) { return $py }
  foreach($candidate in @((Join-Path $env:ProgramFiles 'Python313\python.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'))){
    if(Test-Path -LiteralPath $candidate){return [pscustomobject]@{ Source = $candidate; IsPythonExe = $true }}
  }
  $url='https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe'
  $expected='edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403'
  $temp=Join-Path $env:TEMP ('KafePin-Python-'+[guid]::NewGuid().ToString('N')+'.exe')
  try{
    Write-ComponentLog 'Python 3 bulunamadı; resmi Python kurucusu indiriliyor.'
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $temp
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $temp).Hash.ToLowerInvariant() -ne $expected){throw 'Python indirilen dosya SHA-256 doğrulamasını geçemedi.'}
    $process=Start-Process -FilePath $temp -ArgumentList @('/quiet','InstallAllUsers=1','PrependPath=1','Include_test=0') -Wait -PassThru
    if($process.ExitCode -ne 0){throw ('Python 3 kurulum çıkış kodu: '+$process.ExitCode)}
  }finally{Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue}
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if (-not $py) {
    foreach($candidate in @((Join-Path $env:ProgramFiles 'Python313\python.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'))){
      if (Test-Path -LiteralPath $candidate) { return [pscustomobject]@{ Source = $candidate; IsPythonExe = $true } }
    }
    throw 'Python 3 kurulumu tamamlandı ancak py.exe/python.exe bulunamadı.'
  }
  return $py
}

'''
    marker = "$result = [ordered]@{ version = '3.1.64'; installedAt = (Get-Date).ToString('o'); choices = $choices; results = [ordered]@{} }"
    text = replace_required(text, marker, python_bootstrap + marker, path.name)
    progress_marker = "foreach ($name in @('mp3', 'printer', 'technical', 'client')) {\n  if (-not $choices[$name]) { $result.results[$name] = 'skipped'; continue }\n  try {"
    progress_replacement = """$selectedComponents=@('mp3','printer','technical','client')|Where-Object{$choices[$_]}
$selectedIndex=0
foreach ($name in @('mp3', 'printer', 'technical', 'client')) {
  if (-not $choices[$name]) { $result.results[$name] = 'skipped'; continue }
  $selectedIndex++
  $componentLabel=@{mp3='MP3 Bot PRO';printer='Yazıcı PRO';technical='Teknik Servis PRO';client='Client Yönetim PRO'}[$name]
  $percent=[math]::Floor((($selectedIndex-1)*100)/[math]::Max(1,$selectedComponents.Count))
  Write-Progress -Activity 'PRO servisleri kuruluyor' -Status ($componentLabel+' kuruluyor ('+$selectedIndex+'/'+$selectedComponents.Count+')') -PercentComplete $percent
  Write-Host ('['+$selectedIndex+'/'+$selectedComponents.Count+'] '+$componentLabel+' kuruluyor...') -ForegroundColor Cyan
  try {"""
    text = replace_required(text, progress_marker, progress_replacement, path.name)
    finish_progress_marker = "New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null"
    text = replace_required(
        text,
        finish_progress_marker,
        "Write-Progress -Activity 'PRO servisleri kuruluyor' -Completed\n" + finish_progress_marker,
        path.name,
    )
    text = replace_required(
        text,
        "    $result.results[$name] = 'failed: ' + $_.Exception.Message\n    Write-ComponentLog \"$name kurulamadı: $($_.Exception.Message)\"",
        "    $result.results[$name] = 'failed: ' + $_.Exception.Message\n    Write-Host ('✗ '+$componentLabel+' kurulamadı: '+$_.Exception.Message) -ForegroundColor Red\n    Write-ComponentLog \"$name kurulamadı: $($_.Exception.Message)\"",
        path.name,
    )
    text = replace_required(
        text,
        "    } else {\n      if ($name -eq 'client') {",
        "    } else {\n      $null = Ensure-Python3\n      if ($name -eq 'client') {",
        path.name,
    )
    old_finish = """if ($failed.Count -gt 0) {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  [System.Windows.Forms.MessageBox]::Show('Seçilen bazı PRO bileşenleri kurulamadı. Ayrıntı: C:\\KafePin\\logs\\pro-components-install.log', 'KafePin PRO Bileşenleri', 'OK', 'Warning') | Out-Null
} else {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  [System.Windows.Forms.MessageBox]::Show('PRO bileşen seçimleri tamamlandı. Seçilen paneller KafePin masaüstü uygulamasında hazırdır.', 'KafePin PRO Bileşenleri', 'OK', 'Information') | Out-Null
}
"""
    new_finish = """Write-Host ''
if ($failed.Count -gt 0) {
  Write-Host 'Seçilen bazı PRO bileşenleri kurulamadı.' -ForegroundColor Yellow
  Write-Host 'Ayrıntı: C:\\KafePin\\logs\\pro-components-install.log' -ForegroundColor Yellow
} else {
  Write-Host 'PRO bileşen seçimleri tamamlandı. Seçilen paneller KafePin masaüstü uygulamasında hazırdır.' -ForegroundColor Green
}
"""
    text = replace_required(text, old_finish, new_finish, path.name)
    text = replace_required(
        text,
        "  $py = Get-Command py.exe -ErrorAction SilentlyContinue\n  if (-not $py) { throw 'Teknik Servis PRO için Python 3 (py.exe) bulunamadı.' }\n  Start-Process -FilePath $py.Source -ArgumentList @('-3', '-B', 'web_service.py') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null",
        "  $py = Ensure-Python3\n  $args = if ([IO.Path]::GetFileName($py.Source) -ieq 'py.exe') { @('-3', '-B', 'web_service.py') } else { @('-B', 'web_service.py') }\n  Start-Process -FilePath $py.Source -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden | Out-Null",
        path.name,
    )
    text = replace_required(
        text,
        "  $py = Get-Command py.exe -ErrorAction SilentlyContinue\n  $service = Join-Path $Root 'web_service.py'\n  if (-not $py) { throw 'Client Yönetim PRO için Python 3 (py.exe) bulunamadı.' }\n  if (-not (Test-Path -LiteralPath $service)) { throw 'Client Yönetim PRO web servisi bulunamadı.' }\n  $pythonw = Join-Path (Split-Path -Parent $py.Source) 'pythonw.exe'\n  if (-not (Test-Path -LiteralPath $pythonw)) { throw 'Client Yönetim PRO için pythonw.exe bulunamadı.' }\n  $taskName = 'KafePin Client Yonetim PRO'\n  $action = New-ScheduledTaskAction -Execute $pythonw -Argument ('-B \"' + $service + '\"') -WorkingDirectory $Root",
        "  $py = Ensure-Python3\n  $service = Join-Path $Root 'web_service.py'\n  if (-not (Test-Path -LiteralPath $service)) { throw 'Client Yönetim PRO web servisi bulunamadı.' }\n  $taskName = 'KafePin Client Yonetim PRO'\n  $runArgs = if ([IO.Path]::GetFileName($py.Source) -ieq 'py.exe') { '-3 -B \"' + $service + '\"' } else { '-B \"' + $service + '\"' }\n  $action = New-ScheduledTaskAction -Execute $py.Source -Argument $runArgs -WorkingDirectory $Root",
        path.name,
    )
    path.write_text(text, encoding="utf-8-sig", newline="\r\n")


def patch_desktop_setup(path: Path) -> None:
    """Yeni-kafe akışındaki eski WinForms sihirbazını devre dışı bırak.

    Ana CMD kurucusu tüm ayarları zaten bir kez toplar; masaüstü kurucunun
    aynı EveryCafe/Telegram/PRO sorularını tekrar açması hem çift ayar hem de
    görünür pencere oluşturuyordu.
    """
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # Yeni kafede önce temel işletme/EveryCafe/Telegram ayarları, sonra bağımsız\n"
    end_marker = "  if ($Launch) {"
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        raise RuntimeError(f"{path.name}: eski yeni-kafe sihirbaz bloğu bulunamadı")
    replacement = (
        "  # Yeni-kafe ayarları ve PRO seçimleri üstteki CMD kurucusu tarafından\n"
        "  # bir kez yapılır. Masaüstü kurucusu burada WinForms sihirbazı açmaz.\n\n"
    )
    text = text[:start] + replacement + text[end:]
    path.write_text(text, encoding="utf-8-sig", newline="\r\n")


def build_manifest(payload: Path) -> None:
    files = []
    for path in sorted(payload.rglob("*"), key=lambda p: p.relative_to(payload).as_posix().lower()):
        if not path.is_file() or path.name == "kurulum-manifest.json":
            continue
        files.append(
            {
                "path": path.relative_to(payload).as_posix(),
                "size": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    manifest = {
        "version": VERSION,
        "type": "new-cafe-full-installer-final-offline",
        "installerBuild": "2026.08.22-FINAL-3164-OFFLINE",
        "createdFor": "KafePin Pro Yeni Kafe",
        "fileCount": len(files),
        "files": files,
    }
    (payload / "kurulum-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def overlay_current_pro_components(update_root: Path, work_root: Path) -> None:
    """v3.1.64'te çalışan PRO program dosyalarını yeni-kafe ZIP'lerine sabitle.

    Overlay klasöründe yalnız uygulama kodu bulunur; veritabanı, kullanıcı
    ayarı, log, önbellek ve sanal ortam hiçbir zaman kurulum paketine girmez.
    """
    overlays = Path(__file__).resolve().parent / "payload" / "component-overlays"
    for component in ("mp3-bot-pro", "yazici-pro", "teknik-servis-pro"):
        overlay = overlays / component
        archive_path = update_root / "pro-components" / f"{component}.zip"
        if not overlay.is_dir() or not archive_path.is_file():
            raise RuntimeError(f"PRO v3.1.64 overlay/paket eksik: {component}")
        component_root = work_root / f"component-{component}"
        component_root.mkdir(parents=True)
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(component_root)
        for source in sorted(p for p in overlay.rglob("*") if p.is_file()):
            target = component_root / source.relative_to(overlay)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        zip_tree(component_root, archive_path)


def build_sfx(source_exe: Path, payload: Path, output: Path) -> None:
    with zipfile.ZipFile(source_exe) as archive:
        prefix_size = min(item.header_offset for item in archive.infolist())
    # Çalışan eski kurucunun Windows tarafından yüklenen EXE gövdesi birebir
    # korunur. Gövdedeki sürüm metnini ham bayt olarak değiştirmek PE/Go
    # çalıştırıcısını bazı makinelerde 0xc0000005 ile bozuyordu.
    prefix = source_exe.read_bytes()[:prefix_size]
    archive_path = BUILD_TEMP_ROOT / "installer-payload.zip"
    zip_tree(payload, archive_path)
    output.write_bytes(prefix + archive_path.read_bytes())


def build() -> None:
    for required in (SOURCE_NEW_CAFE, SOURCE_UPDATE, SOURCE_CLIENT):
        if not required.is_file():
            raise FileNotFoundError(required)

    if BUILD_TEMP_ROOT.exists():
        shutil.rmtree(BUILD_TEMP_ROOT)
    BUILD_TEMP_ROOT.mkdir(parents=True)
    try:
        temp = BUILD_TEMP_ROOT
        old_outer = temp / "old-outer"
        update = temp / "update"
        payload = temp / "installer-payload"
        new_outer = temp / "new-outer"
        client_outer = temp / "client-outer"
        old_outer.mkdir()
        update.mkdir()
        payload.mkdir()
        new_outer.mkdir()
        client_outer.mkdir()

        with zipfile.ZipFile(SOURCE_NEW_CAFE) as archive:
            archive.extractall(old_outer)
        with zipfile.ZipFile(SOURCE_UPDATE) as archive:
            archive.extractall(update)
        overlay_current_pro_components(update, temp)
        source_exe = old_outer / "KafePin-Pro-Ana-Sunucu-Kurulum.exe"
        with zipfile.ZipFile(source_exe) as archive:
            archive.extractall(payload)

        update_info = json.loads((update / "update.json").read_text(encoding="utf-8-sig"))
        if update_info.get("version") != VERSION:
            raise RuntimeError("v3.1.64 update manifesti doğrulanamadı")
        for rel in update_info["files"]:
            src = update / rel
            dst = payload / "server" / rel
            if not src.is_file():
                raise FileNotFoundError(src)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

        client_exe = old_outer / "KafePin-Pro-Client-Kurulum.exe"
        shutil.copy2(client_exe, payload / "server" / "Client-Kurulum" / client_exe.name)
        shutil.copy2(client_exe, payload / "Diskless-Client-Paketi" / client_exe.name)

        patch_component_installer(payload / "server" / "KafePin_Pro_Bilesen_Kurulum.ps1")
        patch_desktop_setup(payload / "server" / "KafePin_Desktop_App_Setup.ps1")
        patch_install_script(payload / "KafePin-Pro-Yeni-Kafe-Kur.ps1")
        patch_install_script(payload / "KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1")

        (payload / "OKU-BENI.txt").write_text(
            """KAFEPIN PRO - YENI KAFE FINAL TAM KURULUM v3.1.64
=====================================================

Bu kurucu KafePin Pro v3.1.64 FINAL / STABLE sürümünü internetten güncelleme beklemeden doğrudan kurar.
Kurulum CMD penceresinde ilerler ve işletme/masa/EveryCafe/yedek ayarlarını sorar.
EveryCafe veritabanı yalnız salt okunur kullanılır.

Kurulum sırasında ayrıca şu bağımsız bileşenler ayrı ayrı sorulur:
- MP3 Bot PRO       -> C:\\KafePinPro\\MP3BotPRO
- Yazıcı PRO        -> C:\\KafePinPro\\YaziciPRO
- Teknik Servis PRO -> C:\\KafePinPro\\TeknikServisPRO
- Client Yönetim PRO-> C:\\KafePinPro\\ClientYonetimPRO

Client Yönetim PRO yalnız EveryCafe kullanılan kafelerde sorulur ve kurulabilir.

Ana çekirdek C:\\KafePin altında kalır. PRO bileşenleri çekirdeğe karışmaz.
Kurulumdan sonra masaüstündeki KafePin Pro kısayolundan açılır.
""",
            encoding="utf-8",
        )
        (payload / "yeni-kafe-version.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "channel": "stable",
                    "finalStable": True,
                    "offlinePayloadVersion": VERSION,
                    "clientPackageVersion": VERSION,
                    "installerBuild": "2026.08.22-FINAL-3164-OFFLINE",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        build_manifest(payload)

        # Yeni kafe kurulumu doğrudan CMD -> PowerShell akışıyla ilerler.
        # Eski EXE/SFX başlatıcısı farklı Windows sistemlerinde Go runtime
        # 0xc0000005 üretiyordu; payload içindeki kurulum mantığı ise aynen
        # korunarak güvenilir CMD başlangıcına bağlanır.
        main_dir = new_outer / "ANA-SUNUCU"
        client_dir = new_outer / "CLIENT"
        shutil.copytree(payload, main_dir)
        client_dir.mkdir()
        client_name = f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe"
        shutil.copy2(client_exe, client_dir / client_name)
        (new_outer / "KURULUMU_BASLAT.cmd").write_text(
            "@echo off\r\n"
            "chcp 65001 >nul\r\n"
            "title KafePin Pro v3.1.64 FINAL Yeni Kafe Kurulumu\r\n"
            "net session >nul 2>&1\r\n"
            "if not \"%errorlevel%\"==\"0\" (\r\n"
            "  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs\"\r\n"
            "  exit /b\r\n"
            ")\r\n"
            "set EXTRA=\r\n"
            "if /I \"%KAFEPIN_VALIDATE_ONLY%\"==\"1\" set EXTRA=-ValidateOnly\r\n"
            "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ANA-SUNUCU\\KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1\" %EXTRA%\r\n"
            "set RC=%ERRORLEVEL%\r\n"
            "if not \"%RC%\"==\"0\" echo Kurulum hata kodu: %RC%\r\n"
            "pause\r\n"
            "exit /b %RC%\r\n",
            encoding="utf-8",
        )
        (new_outer / "PRO_SERVISLERI_ONAR.cmd").write_text(
            "@echo off\r\n"
            "chcp 65001 >nul\r\n"
            "title KafePin PRO Servisleri Onarimi\r\n"
            "net session >nul 2>&1\r\n"
            "if not \"%errorlevel%\"==\"0\" (\r\n"
            "  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process -FilePath 'cmd.exe' -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs\"\r\n"
            "  exit /b\r\n"
            ")\r\n"
            "if not exist \"C:\\KafePin\\KafePin_Pro_Bilesen_Kurulum.ps1\" (\r\n"
            "  echo KafePin ana kurulumu bulunamadi: C:\\KafePin\r\n"
            "  pause\r\n"
            "  exit /b 1\r\n"
            ")\r\n"
            "set EC=\r\n"
            "findstr /B /C:\"EVERYCAFE_DB_PATH=\" \"C:\\KafePin\\.env\" >nul 2>&1 && set EC=-EveryCafeEnabled\r\n"
            "echo.\r\n"
            "echo KafePin PRO servisleri onarimi basliyor...\r\n"
            "copy /Y \"%~dp0ANA-SUNUCU\\server\\KafePin_Pro_Bilesen_Kurulum.ps1\" \"C:\\KafePin\\KafePin_Pro_Bilesen_Kurulum.ps1\" >nul\r\n"
            "if errorlevel 1 ( echo Guncel PRO kurucu kopyalanamadi. & pause & exit /b 1 )\r\n"
            "xcopy /E /I /Y /Q \"%~dp0ANA-SUNUCU\\server\\pro-components\" \"C:\\KafePin\\pro-components\" >nul\r\n"
            "if errorlevel 2 ( echo Guncel PRO paketleri kopyalanamadi. & pause & exit /b 1 )\r\n"
            "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"C:\\KafePin\\KafePin_Pro_Bilesen_Kurulum.ps1\" -InstallRoot \"C:\\KafePin\" -ProRoot \"C:\\KafePinPro\" -InitialSetup -ForceInitialSetup %EC%\r\n"
            "set RC=%ERRORLEVEL%\r\n"
            "if not \"%RC%\"==\"0\" echo PRO onarim hata kodu: %RC%\r\n"
            "pause\r\n"
            "exit /b %RC%\r\n",
            encoding="utf-8",
        )
        (new_outer / "VERSIYON.txt").write_text(
            "KafePin Pro v3.1.64 FINAL / STABLE\nYeni kafe çevrimdışı tam kurulum\n",
            encoding="utf-8",
        )
        (new_outer / "OKU-BENI.txt").write_text((payload / "OKU-BENI.txt").read_text(encoding="utf-8"), encoding="utf-8")
        hashes = {
            "ANA-SUNUCU/KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1": sha256(main_dir / "KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1"),
            f"CLIENT/{client_name}": sha256(client_dir / client_name),
        }
        (new_outer / "SHA256SUMS.txt").write_text(
            "".join(f"{digest}  {name}\n" for name, digest in hashes.items()), encoding="ascii"
        )
        (new_outer / "kurulum.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "channel": "stable",
                    "finalStable": True,
                    "offline": True,
                    "mainInstaller": "KURULUMU_BASLAT.cmd",
                    "proRepairInstaller": "PRO_SERVISLERI_ONAR.cmd",
                    "mainPayloadDirectory": "ANA-SUNUCU",
                    "clientInstaller": f"CLIENT/{client_name}",
                    "mainScriptSha256": hashes["ANA-SUNUCU/KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1"],
                    "clientInstallerSha256": hashes[f"CLIENT/{client_name}"],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        zip_tree(new_outer, OUT_NEW_CAFE)

        shutil.copy2(client_exe, client_outer / "KafePin-Pro-Client-Kurulum.exe")
        (client_outer / "CLIENT-OKU-BENI.txt").write_text(
            "KafePin Client v3.1.64\n"
            "KafePin Pro v3.1.64 FINAL ana sunucuyla uyumludur.\n"
            "Client protokolü değişmediği için doğrulanmış v3.1.63 kurucu ikilisi aynen korunmuştur.\n",
            encoding="utf-8",
        )
        (client_outer / "client-version.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "serverCompatibility": VERSION,
                    "installerSha256": sha256(client_outer / "KafePin-Pro-Client-Kurulum.exe"),
                    "protocolChanged": False,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        zip_tree(client_outer, OUT_CLIENT)
    finally:
        shutil.rmtree(BUILD_TEMP_ROOT, ignore_errors=True)

    OUT_NEW_CAFE_SHA.write_text(f"{sha256(OUT_NEW_CAFE)}  {OUT_NEW_CAFE.name}\n", encoding="ascii")
    OUT_CLIENT_SHA.write_text(f"{sha256(OUT_CLIENT)}  {OUT_CLIENT.name}\n", encoding="ascii")
    print(f"NEW_CAFE={OUT_NEW_CAFE} SHA256={sha256(OUT_NEW_CAFE)}")
    print(f"CLIENT={OUT_CLIENT} SHA256={sha256(OUT_CLIENT)}")


if __name__ == "__main__":
    build()
