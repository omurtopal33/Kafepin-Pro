param(
  [string]$InstallRoot = "C:\KafePin",
  [string]$AppVersion = "1.1.3",
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AppDir = Join-Path $InstallRoot 'desktop-app'
$SourceFile = Join-Path $AppDir 'KafePinProDesktop.cs'
$IconFile = Join-Path $AppDir 'KafePin.ico'
$ExeFile = Join-Path $AppDir 'KafePin Pro.exe'
$TempExeFile = Join-Path $AppDir ('KafePin Pro.new.' + [guid]::NewGuid().ToString('N') + '.exe')
$OldDesktopWasRunning = $false
$MarkerFile = Join-Path $AppDir 'desktop-app-installed.json'
$LogDir = Join-Path $InstallRoot 'logs'
$LogFile = Join-Path $LogDir 'desktop-app-setup.log'
$SdkVersion = '1.0.4129.50'
$SdkRoot = Join-Path $AppDir (Join-Path 'sdk' $SdkVersion)

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-KafePinLog([string]$Text) {
  $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text)
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Get-WebView2RuntimeVersion {
  $keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  )
  foreach ($key in $keys) {
    try {
      $pv = [string](Get-ItemProperty -LiteralPath $key -Name 'pv' -ErrorAction Stop).pv
      if ($pv -and $pv -ne '0.0.0.0') { return $pv }
    } catch {}
  }
  return ''
}

function Ensure-WebView2Runtime {
  $v = Get-WebView2RuntimeVersion
  if ($v) {
    Write-KafePinLog ('WebView2 Runtime hazir: ' + $v)
    return $v
  }

  Write-KafePinLog 'WebView2 Runtime bulunamadi; Microsoft Evergreen Bootstrapper indiriliyor.'
  $bootstrap = Join-Path $env:TEMP ('KafePin-WebView2Setup-' + [guid]::NewGuid().ToString('N') + '.exe')
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrap
    $p = Start-Process -FilePath $bootstrap -ArgumentList '/silent','/install' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw ('WebView2 kurulum cikis kodu: ' + $p.ExitCode) }
  } finally {
    Remove-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
  $v = Get-WebView2RuntimeVersion
  if (-not $v) { throw 'Microsoft Edge WebView2 Runtime kurulumu dogrulanamadi.' }
  Write-KafePinLog ('WebView2 Runtime kuruldu: ' + $v)
  return $v
}

function Ensure-WebView2Sdk {
  $core = Join-Path $SdkRoot 'Microsoft.Web.WebView2.Core.dll'
  $forms = Join-Path $SdkRoot 'Microsoft.Web.WebView2.WinForms.dll'
  $loader = Join-Path $SdkRoot 'WebView2Loader.dll'
  if ((Test-Path $core) -and (Test-Path $forms) -and (Test-Path $loader)) {
    return @{ Core=$core; Forms=$forms; Loader=$loader }
  }

  Write-KafePinLog ('WebView2 SDK indiriliyor: ' + $SdkVersion)
  $temp = Join-Path $env:TEMP ('KafePin-WebView2Sdk-' + [guid]::NewGuid().ToString('N'))
  $nupkg = Join-Path $temp 'webview2.nupkg'
  $zip = Join-Path $temp 'webview2.zip'
  $expanded = Join-Path $temp 'expanded'
  New-Item -ItemType Directory -Force -Path $temp,$expanded | Out-Null
  try {
    $url = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/' + $SdkVersion
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $nupkg
    Copy-Item -LiteralPath $nupkg -Destination $zip -Force
    Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force

    $coreSrc = Get-ChildItem -Path (Join-Path $expanded 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.Core.dll' -File |
      Sort-Object { if ($_.FullName -match 'net462') {0} elseif ($_.FullName -match 'net45') {1} else {2} }, FullName |
      Select-Object -First 1
    $formsSrc = Get-ChildItem -Path (Join-Path $expanded 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.WinForms.dll' -File |
      Sort-Object { if ($_.FullName -match 'net462') {0} elseif ($_.FullName -match 'net45') {1} else {2} }, FullName |
      Select-Object -First 1
    $loaderSrc = Get-ChildItem -Path (Join-Path $expanded 'runtimes') -Recurse -Filter 'WebView2Loader.dll' -File |
      Where-Object { $_.FullName -match 'win-x64' } | Select-Object -First 1

    if (-not $coreSrc -or -not $formsSrc -or -not $loaderSrc) {
      throw 'WebView2 SDK icinde gerekli WinForms/x64 dosyalari bulunamadi.'
    }

    New-Item -ItemType Directory -Force -Path $SdkRoot | Out-Null
    Copy-Item -LiteralPath $coreSrc.FullName -Destination $core -Force
    Copy-Item -LiteralPath $formsSrc.FullName -Destination $forms -Force
    Copy-Item -LiteralPath $loaderSrc.FullName -Destination $loader -Force
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
  return @{ Core=$core; Forms=$forms; Loader=$loader }
}

function Find-Csc {
  $candidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw '.NET Framework C# derleyicisi bulunamadi.'
}

function Test-FileUnlocked([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

function Wait-KafePinDesktopFilesUnlocked([int]$TimeoutSeconds = 12) {
  $targets = @(
    $ExeFile,
    (Join-Path $AppDir 'Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $AppDir 'Microsoft.Web.WebView2.WinForms.dll'),
    (Join-Path $AppDir 'WebView2Loader.dll')
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $locked = @($targets | Where-Object { -not (Test-FileUnlocked $_) })
    if ($locked.Count -eq 0) { return }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  $locked = @($targets | Where-Object { -not (Test-FileUnlocked $_) })
  if ($locked.Count -gt 0) {
    throw ('KafePin masaustu dosya kilidi kalkmadi: ' + ($locked -join ', '))
  }
}

function Stop-RunningKafePinDesktop {
  $wasRunning = $false
  try {
    $procs = @(Get-Process -Name 'KafePin Pro' -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
      $wasRunning = $true
      foreach ($proc in $procs) {
        Write-KafePinLog ('Eski KafePin Pro.exe kapatiliyor. PID=' + $proc.Id)
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
      }
    }
  } catch {}

  # Yol sorgusu oturumlar arasi bazen bos donebildigi icin, yalnizca bu benzersiz
  # EXE adina ikinci bir guvenli kapatma denemesi yapilir. Edge/EveryCafe etkilenmez.
  try { & taskkill.exe /F /IM 'KafePin Pro.exe' 2>$null | Out-Null } catch {}

  if ($wasRunning) { $script:OldDesktopWasRunning = $true }
  Wait-KafePinDesktopFilesUnlocked 12
}

function Copy-KafePinDependency([string]$Source, [string]$Destination) {
  if ((Test-Path -LiteralPath $Destination)) {
    try {
      $srcHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
      $dstHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
      if ($srcHash -eq $dstHash) {
        Write-KafePinLog ('Bagimlilik zaten ayni, kopyalanmadi: ' + (Split-Path -Leaf $Destination))
        return
      }
    } catch {}
  }
  $deadline = (Get-Date).AddSeconds(12)
  while (-not (Test-FileUnlocked $Destination)) {
    if ((Get-Date) -ge $deadline) { throw ('Dosya kullanimda: ' + $Destination) }
    Start-Sleep -Milliseconds 300
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function New-KafePinShortcut([string]$Path) {
  $dir = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($Path)
  $sc.TargetPath = $ExeFile
  $sc.WorkingDirectory = $AppDir
  $sc.IconLocation = ($ExeFile + ',0')
  $sc.Description = 'KafePin Pro Yonetim Merkezi'
  $sc.Save()
}

function Remove-OldKafePinBrowserShortcuts {
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('CommonPrograms')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

  $ws = New-Object -ComObject WScript.Shell
  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'KafePin' -and ($_.Extension -ieq '.lnk' -or $_.Extension -ieq '.url') } |
      ForEach-Object {
        try {
          $remove = $false
          if ($_.Extension -ieq '.lnk') {
            $old = $ws.CreateShortcut($_.FullName)
            $target = [string]$old.TargetPath
            $args = [string]$old.Arguments
            if (($target -match 'msedge\.exe|chrome\.exe') -and ($args -match 'kafepin-pro-yonetim|127\.0\.0\.1:3000|localhost:3000')) {
              $remove = $true
            }
          } else {
            $text = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
            if ($text -match 'kafepin-pro-yonetim|127\.0\.0\.1:3000|localhost:3000') { $remove = $true }
          }
          if ($remove) {
            Write-KafePinLog ('Eski tarayici kisayolu kaldirildi: ' + $_.FullName)
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
          }
        } catch {}
      }
  }
}

try {
  Write-KafePinLog ('KafePin desktop setup basladi. app=' + $AppVersion)
  if (-not (Test-Path $SourceFile)) { throw ('Kaynak dosya bulunamadi: ' + $SourceFile) }
  if (-not (Test-Path $IconFile)) { throw ('Ikon bulunamadi: ' + $IconFile) }

  # WebView2 DLL kilidini daha en basta kaldir. Yalniz KafePin Pro.exe kapatilir.
  Stop-RunningKafePinDesktop

  $runtimeVersion = Ensure-WebView2Runtime
  $sdk = Ensure-WebView2Sdk
  $csc = Find-Csc

  # WebView2 managed DLL'leri ve x64 loader EXE ile ayni klasorde tutulur.
  Copy-KafePinDependency $sdk.Core (Join-Path $AppDir 'Microsoft.Web.WebView2.Core.dll')
  Copy-KafePinDependency $sdk.Forms (Join-Path $AppDir 'Microsoft.Web.WebView2.WinForms.dll')
  Copy-KafePinDependency $sdk.Loader (Join-Path $AppDir 'WebView2Loader.dll')
  $runtimeDir = Join-Path $AppDir 'runtimes\win-x64\native'
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Copy-KafePinDependency $sdk.Loader (Join-Path $runtimeDir 'WebView2Loader.dll')

  $args = @(
    '/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output',
    ('/win32icon:' + $IconFile),
    ('/out:' + $TempExeFile),
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll',
    ('/reference:' + (Join-Path $AppDir 'Microsoft.Web.WebView2.Core.dll')),
    ('/reference:' + (Join-Path $AppDir 'Microsoft.Web.WebView2.WinForms.dll')),
    $SourceFile
  )

  Write-KafePinLog ('EXE derleniyor: ' + $csc)
  $compilerOutput = & $csc @args 2>&1
  $compileExit = $LASTEXITCODE
  $compilerOutput | ForEach-Object { Write-KafePinLog ([string]$_) }
  if ($compileExit -ne 0 -or -not (Test-Path $TempExeFile)) {
    throw ('KafePin Pro.exe derlenemedi. Cikis kodu: ' + $compileExit)
  }

  Move-Item -LiteralPath $TempExeFile -Destination $ExeFile -Force
  Write-KafePinLog 'Yeni KafePin Pro.exe aktif edildi.'

  Remove-OldKafePinBrowserShortcuts
  # Kısayollar tum kullanicilar icin olusturulur. Sunucu SYSTEM olarak calissa bile
  # KafePin Pro masaustunde ve Baslat menusunde gorunur kalir.
  $desktopRoot=[Environment]::GetFolderPath('CommonDesktopDirectory')
  if([string]::IsNullOrWhiteSpace($desktopRoot)){$desktopRoot=Join-Path $env:PUBLIC 'Desktop'}
  $programsRoot=[Environment]::GetFolderPath('CommonPrograms')
  if([string]::IsNullOrWhiteSpace($programsRoot)){$programsRoot=Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'}
  $desktopLink = Join-Path $desktopRoot 'KafePin Pro.lnk'
  $startLink = Join-Path $programsRoot 'KafePin Pro\KafePin Pro.lnk'

  if (-not (Test-Path -LiteralPath $desktopLink)) {
    try {
      New-KafePinShortcut $desktopLink
      Write-KafePinLog ('Masaustu kisayolu olusturuldu: ' + $desktopLink)
    } catch {
      # Kısayol izni yoksa derlenmiş EXE ve sürüm işareti geri alınmaz.
      Write-KafePinLog ('Masaustu kisayolu atlandi (izin): ' + $_.Exception.Message)
    }
  } else {
    Write-KafePinLog ('Masaustu kisayolu zaten mevcut, dokunulmadi: ' + $desktopLink)
  }

  if (-not (Test-Path -LiteralPath $startLink)) {
    try {
      New-KafePinShortcut $startLink
      Write-KafePinLog ('Baslat menusu kisayolu olusturuldu: ' + $startLink)
    } catch {
      Write-KafePinLog ('Baslat menusu kisayolu atlandi (izin): ' + $_.Exception.Message)
    }
  } else {
    Write-KafePinLog ('Baslat menusu kisayolu zaten mevcut, dokunulmadi: ' + $startLink)
  }

  $marker = [ordered]@{
    version = $AppVersion
    installedAt = (Get-Date).ToString('o')
    exe = $ExeFile
    webView2Sdk = $SdkVersion
    webView2Runtime = $runtimeVersion
  }
  $marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $MarkerFile -Encoding UTF8
  Write-KafePinLog ('KafePin Pro.exe hazir: ' + $ExeFile)

  # Yeni kafe kurulumunda v3.1.49 ile gelen bağımsız PRO bileşenleri yalnız
  # bir kez sorulur. Mevcut KafePin veritabanı olan kurulumlar etkilenmez.
  $componentInstaller = Join-Path $InstallRoot 'KafePin_Pro_Bilesen_Kurulum.ps1'
  $databasePath = Join-Path $InstallRoot 'database.db'
  if ((-not (Test-Path -LiteralPath $databasePath)) -and (Test-Path -LiteralPath $componentInstaller)) {
    try {
      Write-KafePinLog 'Yeni kafe PRO bileşen seçim ekranı başlatılıyor.'
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $componentInstaller -InstallRoot $InstallRoot -InitialSetup
      Write-KafePinLog ('PRO bileşen seçim ekranı tamamlandı. Çıkış=' + $LASTEXITCODE)
    } catch {
      # Bileşen kurulumu çekirdek KafePin kurulumunu kesmez; ayrıntı logdadır.
      Write-KafePinLog ('PRO bileşen kurulumu atlandı/hatalı: ' + $_.Exception.Message)
    }
  }

  if ($Launch) {
    Start-Process -FilePath $ExeFile -WorkingDirectory $AppDir | Out-Null
    Write-KafePinLog 'KafePin Pro.exe baslatildi.'
  }

  Write-Output 'KAFEPIN_DESKTOP_APP_OK'
  exit 0
} catch {
  $msg = $_.Exception.Message
  Remove-Item -LiteralPath $TempExeFile -Force -ErrorAction SilentlyContinue
  Write-KafePinLog ('HATA: ' + $msg)
  if ($OldDesktopWasRunning -and (Test-Path $ExeFile)) {
    try { Start-Process -FilePath $ExeFile -WorkingDirectory $AppDir | Out-Null; Write-KafePinLog 'Eski KafePin Pro.exe kurtarma amaciyla yeniden acildi.' } catch {}
  }
  Write-Error $msg
  exit 1
}
