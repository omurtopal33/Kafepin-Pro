param(
  [Parameter(Mandatory=$true)][string]$TargetDir,
  [Parameter(Mandatory=$true)][string]$ControlKey
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Yonetici PowerShell ile calistirin.' }
if ([string]::IsNullOrWhiteSpace($ControlKey)) { throw 'ControlKey bos olamaz.' }
$target = [IO.Path]::GetFullPath($TargetDir)
$targetService = Join-Path $target 'web_service.py'
$targetWeb = Join-Path $target 'web'
if (!(Test-Path -LiteralPath $targetService) -or !(Test-Path -LiteralPath $targetWeb)) { throw "Client Performans PRO klasoru dogrulanamadi: $target" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $target ("backup-v405-web-limit-" + $stamp)
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item -LiteralPath $targetService -Destination (Join-Path $backup 'web_service.py') -Force
Copy-Item -LiteralPath $targetWeb -Destination (Join-Path $backup 'web') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web_service.py') -Destination $targetService -Force
Remove-Item -LiteralPath $targetWeb -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web') -Destination $targetWeb -Recurse -Force
$keyDir = 'C:\ProgramData\KafePin\WebLimit'
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
Set-Content -LiteralPath (Join-Path $keyDir 'control.key') -Value $ControlKey -Encoding utf8 -NoNewline
Write-Host "Client Performans PRO v4.0.5 TEST patch uygulandi. Backup: $backup"
Write-Host 'KafePin/Client Performans servisini yeniden baslatin; kartlarda WEB LIMITI durumu canli health ile gorunecek.'
