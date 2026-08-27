$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'install_elevated_service.log'
Start-Transcript -Path $log -Force | Out-Null
trap {
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
  exit 1
}
$service = Join-Path $root 'web_service.py'
$py = Get-Command py.exe -ErrorAction SilentlyContinue
$pythonw = if ($py) { Join-Path (Split-Path -Parent $py.Source) 'pythonw.exe' } else { $null }
if (-not $pythonw -or -not (Test-Path -LiteralPath $pythonw)) {
  $pythonw = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs\Python') -Filter 'pythonw.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path -LiteralPath $service)) { throw "Servis bulunamadı: $service" }
if (-not (Test-Path -LiteralPath $pythonw)) { throw "pythonw.exe bulunamadı: $pythonw" }

$taskName = 'KafePin Client Yonetim PRO'
$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('-B "' + $service + '"') -WorkingDirectory $root
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'KafePin Client PRO - EveryCafe UI köprüsü; DB salt okunur.' -Force | Out-Null
$oldPids = @(netstat -ano | Select-String ':17894\s+.*LISTENING' | ForEach-Object {
  if ($_ -match 'LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
} | Sort-Object -Unique)
foreach ($pidValue in $oldPids) {
  Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
}
Start-ScheduledTask -TaskName $taskName

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17894/api/health' -TimeoutSec 1
    if ($health.ok) { Stop-Transcript | Out-Null; exit 0 }
  } catch {}
} while ((Get-Date) -lt $deadline)
throw 'Client Yönetim PRO yetkili servisi başlatılamadı.'
