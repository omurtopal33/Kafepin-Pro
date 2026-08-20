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
