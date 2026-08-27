param([string]$InstallRoot = 'C:\KafePinPro\WebLimitAgent')
$ErrorActionPreference = 'SilentlyContinue'
$exe = Join-Path $InstallRoot 'KafePin_WebLimit_Agent.exe'
if (Test-Path $exe) { & $exe --disable | Out-Null }
& schtasks.exe /End /TN 'KafePin Web Limit Agent' | Out-Null
& schtasks.exe /Delete /TN 'KafePin Web Limit Agent' /F | Out-Null
Remove-Item -LiteralPath $InstallRoot -Recurse -Force
Remove-Item -LiteralPath 'C:\ProgramData\KafePin\WebLimit' -Recurse -Force
Write-Host 'KafePin Web Limit Agent kaldirildi; tarayici limiti kapali.'
