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
$oldPref = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
& schtasks.exe /Query /TN $taskName *> $null
if ($LASTEXITCODE -eq 0) { & schtasks.exe /Delete /TN $taskName /F *> $null }
$ErrorActionPreference = $oldPref
& schtasks.exe /Create /TN $taskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR ('"{0}"' -f $exe) /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Zamanlanmis gorev olusturulamadi. schtasks exit=$LASTEXITCODE" }
& schtasks.exe /Run /TN $taskName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Zamanlanmis gorev baslatilamadi. schtasks exit=$LASTEXITCODE" }
Write-Host 'KafePin Web Limit Agent kuruldu. Varsayilan politika KAPALI; Client Performans PRO uzerinden acilabilir.'
