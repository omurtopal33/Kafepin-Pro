param(
  [string]$InstallRoot = 'C:\KafePinPro\WebLimitAgent',
  [string]$ControlKey = ''
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Yonetici yetkisi gerekli.' }
if ([string]::IsNullOrWhiteSpace($ControlKey)) { throw 'ControlKey zorunlu.' }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path 'C:\ProgramData\KafePin\WebLimit' | Out-Null
Set-Content -LiteralPath 'C:\ProgramData\KafePin\WebLimit\control.key' -Value $ControlKey -Encoding ASCII -NoNewline
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'KafePin_WebLimit_Agent.exe') -Destination (Join-Path $InstallRoot 'KafePin_WebLimit_Agent.exe') -Force
$taskName = 'KafePin Web Limit Agent'
$exe = Join-Path $InstallRoot 'KafePin_WebLimit_Agent.exe'
& schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
& schtasks.exe /Create /TN $taskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR ('"{0}"' -f $exe) /F | Out-Null
& schtasks.exe /Run /TN $taskName | Out-Null
Write-Host 'KafePin Web Limit Agent kuruldu. Varsayilan politika KAPALI; Client Performans PRO uzerinden acilabilir.'
