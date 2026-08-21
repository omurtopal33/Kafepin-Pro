param(
  [string]$InstallRoot = 'C:\KafePin',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'KafePin Pro Server Manager'
$RestoreTaskName = 'KafePin Pro Restore Worker'
$SystemRoot = Join-Path $env:ProgramData 'KafePinPro'
$ManagerSource = Join-Path $InstallRoot 'KafePin_System_Manager.ps1'
$ManagerLive = Join-Path $SystemRoot 'KafePin_System_Manager.ps1'
$RestoreSource = Join-Path $InstallRoot 'KafePin_Restore_Worker.ps1'
$RestoreLive = Join-Path $SystemRoot 'KafePin_Restore_Worker.ps1'
$ConfigFile = Join-Path $SystemRoot 'manager-config.json'
$TokenFile = Join-Path $SystemRoot 'manager.token'
$RestartRequestFile = Join-Path $SystemRoot 'server-restart-request.json'
$LogDir = Join-Path $SystemRoot 'logs'
$LogFile = Join-Path $LogDir 'manager-ensure.log'
$ControlPort = 2999
$ExpectedManagerVersion = '3.1.4'
New-Item -ItemType Directory -Force -Path $SystemRoot,$LogDir | Out-Null

function Log([string]$Message) {
  try { Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [ensure-3.1.4] ' + $Message) -Encoding UTF8 } catch {}
}
function Find-Node {
  if ($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $NodePath }
  try {
    if (Test-Path -LiteralPath $ConfigFile) {
      $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.nodePath -and (Test-Path -LiteralPath ([string]$cfg.nodePath) -PathType Leaf)) { return [string]$cfg.nodePath }
    }
  } catch {}
  $candidates = @(
    (Join-Path $InstallRoot 'node\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
  try {
    $cmd = Get-Command node.exe -ErrorAction Stop
    if ($cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) { return $cmd.Source }
  } catch {}
  throw 'Node.exe bulunamadi.'
}
function Get-ControlState {
  try {
    if (-not (Test-Path -LiteralPath $TokenFile)) { return $null }
    $token = (Get-Content -LiteralPath $TokenFile -Raw -ErrorAction Stop).Trim()
    if (-not $token) { return $null }
    $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $ControlPort + '/status?_=' + [DateTime]::UtcNow.Ticks) -TimeoutSec 2 -Headers @{ 'X-KafePin-Manager-Token'=$token; 'Cache-Control'='no-cache' }
    if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { return $null }
    $j = $r.Content | ConvertFrom-Json
    if (-not [bool]$j.ok) { return $null }
    return $j
  } catch { return $null }
}
function Test-Control {
  return ($null -ne (Get-ControlState))
}
function Test-ControlExpectedVersion {
  $state = Get-ControlState
  return ($null -ne $state -and [string]$state.managerVersion -eq $ExpectedManagerVersion)
}
function Wait-Control([int]$Seconds) {
  for ($i=0; $i -lt $Seconds; $i++) {
    if (Test-ControlExpectedVersion) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Stop-ManagerProcesses {
  try { & schtasks.exe /End /TN $TaskName 2>$null | Out-Null } catch {}
  Start-Sleep -Milliseconds 400
  try {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $cmd=[string]$_.CommandLine
      $cmd -and $cmd.IndexOf('KafePin_System_Manager.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { try { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue } catch {} }
  } catch {}
  Start-Sleep -Milliseconds 500
}
function Ensure-RestoreTask {
  if (-not (Test-Path -LiteralPath $RestoreSource -PathType Leaf)) { throw 'KafePin_Restore_Worker.ps1 bulunamadi.' }
  Copy-Item -LiteralPath $RestoreSource -Destination $RestoreLive -Force
  try { & schtasks.exe /End /TN $RestoreTaskName 2>$null | Out-Null } catch {}
  try { & schtasks.exe /Delete /TN $RestoreTaskName /F 2>$null | Out-Null } catch {}
  $powershellExe = Join-Path $PSHOME 'powershell.exe'
  $taskCommand = '"' + $powershellExe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $RestoreLive + '"'
  $out = & schtasks.exe /Create /TN $RestoreTaskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $taskCommand /F 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('Restore Worker gorevi olusturulamadi: ' + ($out -join ' ')) }
  Log 'Restore Worker SYSTEM gorevi hazirlandi.'
}

function Register-Task([string]$Node) {
  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'KafePin_System_Manager.ps1 bulunamadi.' }
  Copy-Item -LiteralPath $ManagerSource -Destination $ManagerLive -Force
  [ordered]@{ nodePath=$Node; root=$InstallRoot; port=3000; controlPort=$ControlPort; version=$ExpectedManagerVersion } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
  if (-not (Test-Path -LiteralPath $TokenFile)) { [guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $TokenFile -Encoding ASCII }
  try { & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null } catch {}
  $powershellExe = Join-Path $PSHOME 'powershell.exe'
  $taskCommand = '"' + $powershellExe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ManagerLive + '" -Loop'
  $out = & schtasks.exe /Create /TN $TaskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $taskCommand /F 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('Server Manager gorevi olusturulamadi: ' + ($out -join ' ')) }
  $out = & schtasks.exe /Run /TN $TaskName 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('Server Manager gorevi baslatilamadi: ' + ($out -join ' ')) }
}

try {
  $node = Find-Node


  # v3.1.54 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi.
  # Server Manager on-kontrolunun 35 sn timeout sinirina girmemek icin burada servis/WebView2 beklenmez.
  $YaziciPayload = Join-Path $InstallRoot 'v3154-yazici-payload'
  $YaziciRoot = Join-Path $InstallRoot 'KafePinYaziciPRO'
  $YaziciWeb = Join-Path $YaziciRoot 'web'
  $YaziciLog = Join-Path $LogDir 'v3154-yazici-apply.log'
  function YaziciLog([string]$Text) { try { Add-Content -LiteralPath $YaziciLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [v3.1.54-candidate2] ' + $Text) -Encoding UTF8 } catch {} }
  function YaziciFileSha([string]$P) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $P).Hash.ToLowerInvariant() }
  if (-not (Test-Path -LiteralPath $YaziciPayload -PathType Container)) { throw 'v3.1.54 Yazici payload klasoru bulunamadi.' }
  if (-not (Test-Path -LiteralPath $YaziciRoot -PathType Container)) { throw ('Yazici PRO kurulum klasoru bulunamadi: ' + $YaziciRoot) }
  New-Item -ItemType Directory -Force -Path $YaziciWeb | Out-Null
  $pairs = @(
    [pscustomobject]@{ Src='KafePin_AI_Ayarla.cmd'; Dst='KafePin_AI_Ayarla.cmd'; Sha='96848d3cbfe32faa7579c581909c3b676726d75686fcdde8a88242433847f89d' },
    [pscustomobject]@{ Src='KafePin_AI_Ayarla.ps1'; Dst='KafePin_AI_Ayarla.ps1'; Sha='72030bf512c3bc04eb567b295e4d7918d72729e5bd928cb8b2c1af6f35f3d4d5' },
    [pscustomobject]@{ Src='KafePin_YaziciGelir_Service.js'; Dst='KafePin_YaziciGelir_Service.js'; Sha='c4e16a2f6603ac663f7747615c2c61d5c69fb5409ae5a04550fe54c93a2514cf' },
    [pscustomobject]@{ Src='KafePin_YaziciPRO_WebView2.ps1'; Dst='KafePin_YaziciPRO_WebView2.ps1'; Sha='a158f13bf8ab9efa114deb510afa973e3b94807a399d647e22ba93bfbf7a021f' },
    [pscustomobject]@{ Src='START_YAZICI_PRO.cmd'; Dst='START_YAZICI_PRO.cmd'; Sha='54e37666b33d184cdc8322275432665e10d9f07c693ab5ee4cf0357b21053d30' },
    [pscustomobject]@{ Src='index.html'; Dst='web\index.html'; Sha='1008cfe04bdfd2004613171c9e56f912b6fad2b8adf2e024719323477c5b9f3f' },
    [pscustomobject]@{ Src='v3154-ai.js'; Dst='web\v3154-ai.js'; Sha='6c0a6480e65751bea86d32478d69d12130f8a0f16d37a2b4eb331273a6192d20' },
    [pscustomobject]@{ Src='vendor\qrcode\LUT.py'; Dst='vendor\qrcode\LUT.py'; Sha='3635ca3df1d24c56282e51a45e11637f6394abf1060fa9ab772607206ddd35c9' },
    [pscustomobject]@{ Src='vendor\qrcode\__init__.py'; Dst='vendor\qrcode\__init__.py'; Sha='d02f23c778031d2278cb27651cdd35cadca2a4d876a4c3b75584bd0e4fa6e285' },
    [pscustomobject]@{ Src='vendor\qrcode\base.py'; Dst='vendor\qrcode\base.py'; Sha='f49ff52f29c5e5d5c92b5e00cecf17c87258eba15f4e5b9827ae85f198de4ad6' },
    [pscustomobject]@{ Src='vendor\qrcode\compat\__init__.py'; Dst='vendor\qrcode\compat\__init__.py'; Sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    [pscustomobject]@{ Src='vendor\qrcode\compat\etree.py'; Dst='vendor\qrcode\compat\etree.py'; Sha='ac4c96440f5032c545bdaffdace76d877440911a453a6905e7d736110338e201' },
    [pscustomobject]@{ Src='vendor\qrcode\compat\png.py'; Dst='vendor\qrcode\compat\png.py'; Sha='3827b95acba24c8fd44ea9b256a2db70996849b66f80260974c0b39cabcc0823' },
    [pscustomobject]@{ Src='vendor\qrcode\console_scripts.py'; Dst='vendor\qrcode\console_scripts.py'; Sha='9fe6d0e6fa4ab5c8c6df49758e443fab6d874d5e17f8910cc242d17499e8f2f7' },
    [pscustomobject]@{ Src='vendor\qrcode\constants.py'; Dst='vendor\qrcode\constants.py'; Sha='d02b1af1861d790f0d685ad19ade3799a560d763bcf5dfa82a088a01520edace' },
    [pscustomobject]@{ Src='vendor\qrcode\exceptions.py'; Dst='vendor\qrcode\exceptions.py'; Sha='2f67d9b9838ab1cbdd9fbdab6bec05f06c2caf6641f5e4595aba757f4203c781' },
    [pscustomobject]@{ Src='vendor\qrcode\image\__init__.py'; Dst='vendor\qrcode\image\__init__.py'; Sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    [pscustomobject]@{ Src='vendor\qrcode\image\base.py'; Dst='vendor\qrcode\image\base.py'; Sha='8c2adbb78503d597ce0bc8cc1632b77a565f81427b33f16c1ca44c56f8def811' },
    [pscustomobject]@{ Src='vendor\qrcode\image\pil.py'; Dst='vendor\qrcode\image\pil.py'; Sha='cb96b7b7a541e209efb132b8792474e181153ff424f36893d4d5cbea314fd634' },
    [pscustomobject]@{ Src='vendor\qrcode\image\pure.py'; Dst='vendor\qrcode\image\pure.py'; Sha='07c3c900dbc01cfc9dd43681b400bcdc2b1bdb129b67e7cfe12496bb0d4d36f5' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styledpil.py'; Dst='vendor\qrcode\image\styledpil.py'; Sha='442ec9a034be5337b3da737e236c7078fb065f7a980de1e0f187a94f615b3bf3' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\__init__.py'; Dst='vendor\qrcode\image\styles\__init__.py'; Sha='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\colormasks.py'; Dst='vendor\qrcode\image\styles\colormasks.py'; Sha='87c6ac22f40a31346eaba6c5cef6a2660172a1afb6b6abc86ff841e47e57c0cd' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\moduledrawers\__init__.py'; Dst='vendor\qrcode\image\styles\moduledrawers\__init__.py'; Sha='324970e528d88866ecd80ca6dfc8f0c2b2add299491b3c0856067efa388e5417' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\moduledrawers\base.py'; Dst='vendor\qrcode\image\styles\moduledrawers\base.py'; Sha='80b16adb4a74eed0449ac15f8ab10cd7d5d9b2162c68d3f65abd54340909abdd' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\moduledrawers\pil.py'; Dst='vendor\qrcode\image\styles\moduledrawers\pil.py'; Sha='9644fc23cabc3d407f4dd601acfe4397328df14b505be5d0118aa85c15a40fb6' },
    [pscustomobject]@{ Src='vendor\qrcode\image\styles\moduledrawers\svg.py'; Dst='vendor\qrcode\image\styles\moduledrawers\svg.py'; Sha='f969e012f645f0bc2d4e95a649db74b4367a74ab58ccb72d603358f8c8bb72b7' },
    [pscustomobject]@{ Src='vendor\qrcode\image\svg.py'; Dst='vendor\qrcode\image\svg.py'; Sha='1b6766bb26d53f77f0920cab145e517d04f776958309897cd0e29ed976a5f205' },
    [pscustomobject]@{ Src='vendor\qrcode\main.py'; Dst='vendor\qrcode\main.py'; Sha='385eee1c3033d938a1a5ee857ed79fe9f8951f6b69a152797a42c2206e25c890' },
    [pscustomobject]@{ Src='vendor\qrcode\release.py'; Dst='vendor\qrcode\release.py'; Sha='c098d51249569c04d487c094f3c1c42b285481953d873a65fff499632c8d519a' },
    [pscustomobject]@{ Src='vendor\qrcode\util.py'; Dst='vendor\qrcode\util.py'; Sha='54e1b846b27a4243ecd1f2da6647de330c70c5d2292ac4479ba757be3a3d625e' },
    [pscustomobject]@{ Src='web_service.py'; Dst='web_service.py'; Sha='a627c2139268a6b7721488f7bbf7d1463302801c744d283c6ae83e4f09340769' },
    [pscustomobject]@{ Src='yazici-pro-version.json'; Dst='yazici-pro-version.json'; Sha='ff6d6e5a443c3be025f873adc7cfadaae52df02681282ea46d37574746332b29' }
  )
  foreach ($pair in $pairs) {
    $src = Join-Path $YaziciPayload ([string]$pair.Src); $dst = Join-Path $YaziciRoot ([string]$pair.Dst)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw ('Yazici payload dosyasi eksik: ' + [string]$pair.Src) }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    if ((YaziciFileSha $dst) -ne [string]$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }
  }
  Remove-Item -LiteralPath (Join-Path $YaziciWeb 'v3153-ai.js') -Force -ErrorAction SilentlyContinue
  $indexRaw = Get-Content -LiteralPath (Join-Path $YaziciWeb 'index.html') -Raw -Encoding UTF8
  foreach ($marker in @('v3154Verified','WHATSAPP WEB','BELGE / DİLEKÇE & AI','FOTOĞRAFTAN WORD','confirm3154Cancel','confirm3154Delete','ai3154Mobile','qjobdel','txdel')) {
    if ($indexRaw.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw ('Yazici PRO v3.1.54 marker yok: ' + $marker) }
  }
  Set-Content -LiteralPath (Join-Path $YaziciRoot 'node-path.txt') -Value $node -Encoding ASCII
  try { & wevtutil.exe sl 'Microsoft-Windows-PrintService/Operational' /e:true 2>$null | Out-Null } catch {}
  try {
    if (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue) {
      Get-NetFirewallRule -DisplayName 'KafePin Yazici PRO Mobil QR' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName 'KafePin Yazici PRO Mobil QR' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 17891 -Profile Private -RemoteAddress LocalSubnet | Out-Null
    }
  } catch { YaziciLog ('Mobil QR firewall uyarisi: ' + $_.Exception.Message) }
  $startCmd = Join-Path $YaziciRoot 'START_YAZICI_PRO.cmd'
  try {
    $shell = New-Object -ComObject WScript.Shell; $desktopDirs = @([Environment]::GetFolderPath('Desktop')); if ($env:PUBLIC) { $desktopDirs += (Join-Path $env:PUBLIC 'Desktop') }
    foreach ($desk in ($desktopDirs | Select-Object -Unique)) { if (-not $desk) { continue }; New-Item -ItemType Directory -Force -Path $desk | Out-Null; foreach ($shortcutName in @('KafePin Yazıcı PRO.lnk','KafePin Yazici PRO.lnk')) { $lnk=Join-Path $desk $shortcutName; $sc=$shell.CreateShortcut($lnk); $sc.TargetPath=$startCmd; $sc.WorkingDirectory=$YaziciRoot; $sc.Description='KafePin Yazıcı PRO 3.1.54'; $sc.Save() } }
  } catch { YaziciLog ('Kisayol uyarisi: ' + $_.Exception.Message) }
  [ordered]@{ version='3.1.54'; build='candidate2'; appliedAt=(Get-Date).ToString('o'); yaziciRoot=$YaziciRoot; runtimeActivation='on-first-launch'; updaterWait='none'; mobileQr='same-lan-token-only' } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $SystemRoot 'v3154-yazici-applied.json') -Encoding UTF8
  YaziciLog 'BASARILI: v3.1.54 dosyalar+SHA+kisayol uygulandi. Runtime ilk Yazici PRO acilisinda dogrulanacak.'
  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }
  Copy-Item -LiteralPath $ManagerSource -Destination $ManagerLive -Force
  [ordered]@{ nodePath=$node; root=$InstallRoot; port=3000; controlPort=$ControlPort; version=$ExpectedManagerVersion } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
  if (-not (Test-Path -LiteralPath $TokenFile)) { [guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $TokenFile -Encoding ASCII }
  Ensure-RestoreTask

  if (Test-ControlExpectedVersion) { Log 'Manager control zaten hazir ve surum dogru.'; exit 0 }

  if (Test-Control) {
    Log 'Manager control var fakat surum eski; yeni surum temizden kaydediliyor.'
    Stop-ManagerProcesses
    Remove-Item -LiteralPath $RestartRequestFile -Force -ErrorAction SilentlyContinue
    Register-Task $node
    if (-not (Wait-Control 15)) { throw 'Yeni Server Manager surumu 15 saniye icinde hazir olmadi.' }
    Log 'BASARILI: Manager yeni surume gecirildi.'
    exit 0
  }

  Log 'Manager control yok; mevcut gorev tetikleniyor.'
  try { & schtasks.exe /Run /TN $TaskName 2>$null | Out-Null } catch {}
  if (Wait-Control 6) { Log 'Manager mevcut gorev ile hazirlandi.'; exit 0 }

  Log 'Manager hala yok; gorev temizden kaydediliyor.'
  Stop-ManagerProcesses
  Remove-Item -LiteralPath $RestartRequestFile -Force -ErrorAction SilentlyContinue
  Register-Task $node
  if (-not (Wait-Control 15)) { throw 'Server Manager control portu 15 saniye icinde hazir olmadi.' }
  Log 'BASARILI: Manager gorevi yeniden kaydedildi ve control portu dogrulandi.'
  exit 0
} catch {
  Log ('HATA: ' + $_.Exception.Message)
  Write-Error $_.Exception.Message
  exit 21
}
