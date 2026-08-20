param(
  [string]$InstallRoot = 'C:\KafePin',
  [switch]$InitialSetup
)

$ErrorActionPreference = 'Stop'
$PayloadRoot = Join-Path $InstallRoot 'pro-components'
$StatePath = Join-Path $InstallRoot 'config\pro-components.json'
$FreshInstall = -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'database.db'))

function Write-ComponentLog([string]$Text) {
  $log = Join-Path $InstallRoot 'logs\pro-components-install.log'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
  Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding UTF8
}

function Ask-Component([string]$Title, [string]$Text) {
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

function Copy-Component([string]$SourceName, [string]$TargetPath) {
  $source = Join-Path $PayloadRoot ($SourceName + '.zip')
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Bileşen paketi bulunamadı: $SourceName"
  }
  $temp = Join-Path $env:TEMP ('KafePin-Pro-Component-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  try {
    Expand-Archive -LiteralPath $source -DestinationPath $temp -Force
    if (-not (Get-ChildItem -LiteralPath $temp -Force | Select-Object -First 1)) {
      throw "Bileşen paketi boş: $SourceName"
    }
    New-Item -ItemType Directory -Force -Path $TargetPath | Out-Null
    Get-ChildItem -LiteralPath $temp -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $TargetPath -Recurse -Force
    }
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-SilentCmd([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory) {
  $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Kurulum çıkış kodu: $($p.ExitCode)" }
}

function Start-Mp3Service([string]$Root) {
  $launcher = Join-Path $Root 'START_WEB.ps1'
  Invoke-SilentCmd 'powershell.exe' ('-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"') $Root
}

function Start-PrinterService([string]$Root) {
  $pythonw = Join-Path $Root '.venv\Scripts\pythonw.exe'
  if (-not (Test-Path -LiteralPath $pythonw)) { throw 'Yazıcı PRO pythonw.exe bulunamadı.' }
  Start-Process -FilePath $pythonw -ArgumentList 'web_service.py' -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
}

function Start-TechnicalService([string]$Root) {
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if (-not $py) { throw 'Teknik Servis PRO için Python 3 (py.exe) bulunamadı.' }
  Start-Process -FilePath $py.Source -ArgumentList @('-3', '-B', 'web_service.py') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
}

if (-not $InitialSetup -or -not $FreshInstall -or (Test-Path -LiteralPath $StatePath)) {
  exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $PayloadRoot 'mp3-bot-pro.zip') -PathType Leaf)) {
  Write-ComponentLog 'Bileşen seçimi atlandı: paket klasörü yok.'
  exit 0
}

$choices = [ordered]@{
  mp3 = Ask-Component 'KafePin MP3 Bot PRO' 'MP3 Bot PRO kurulsun mu?`n`nYouTube arama/indirme, Dinleme Modu, Winamp Modu ve Favori Listem bağımsız olarak kurulacaktır.'
  printer = Ask-Component 'KafePin Yazıcı PRO' 'Yazıcı PRO kurulsun mu?`n`nTarayıcı, kimlik fotokopisi, PDF/dosya dönüştürme ve Windows yazıcı seçimi kurulacaktır.'
  technical = Ask-Component 'KafePin Teknik Servis PRO' 'Teknik Servis PRO kurulsun mu?`n`nServis kaydı, A4 servis fişi ve Nakit/Kart tahsilat kaydı bağımsız olarak kurulacaktır.'
}

$result = [ordered]@{ version = '3.1.49'; installedAt = (Get-Date).ToString('o'); choices = $choices; results = [ordered]@{} }

foreach ($name in @('mp3', 'printer', 'technical')) {
  if (-not $choices[$name]) { $result.results[$name] = 'skipped'; continue }
  try {
    if ($name -eq 'mp3') {
      $target = 'C:\KafePinMp3BotPRO'
      Copy-Component 'mp3-bot-pro' $target
      Invoke-SilentCmd 'cmd.exe' '/c KURULUM.cmd /silent' $target
      Start-Mp3Service $target
    } elseif ($name -eq 'printer') {
      $target = Join-Path $InstallRoot 'KafePinYaziciPRO'
      Copy-Component 'yazici-pro' $target
      Invoke-SilentCmd 'cmd.exe' '/c KURULUM.cmd /silent' $target
      Start-PrinterService $target
    } else {
      $target = 'C:\KafePinTeknikServisPRO'
      Copy-Component 'teknik-servis-pro' $target
      Start-TechnicalService $target
    }
    $result.results[$name] = 'installed'
    Write-ComponentLog "$name kuruldu: $target"
  } catch {
    $result.results[$name] = 'failed: ' + $_.Exception.Message
    Write-ComponentLog "$name kurulamadı: $($_.Exception.Message)"
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StatePath -Encoding UTF8
$failed = @($result.results.Values | Where-Object { $_ -like 'failed:*' })
if ($failed.Count -gt 0) {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  [System.Windows.Forms.MessageBox]::Show('Seçilen bazı PRO bileşenleri kurulamadı. Ayrıntı: C:\KafePin\logs\pro-components-install.log', 'KafePin PRO Bileşenleri', 'OK', 'Warning') | Out-Null
} else {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  [System.Windows.Forms.MessageBox]::Show('PRO bileşen seçimleri tamamlandı. Seçilen paneller KafePin masaüstü uygulamasında hazırdır.', 'KafePin PRO Bileşenleri', 'OK', 'Information') | Out-Null
}
