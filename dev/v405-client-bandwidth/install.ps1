param(
  [string]$InstallRoot = 'C:\KafePinPro\WebLimitAgent',
  [string]$ControlKey = ''
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Yonetici yetkisi gerekli.' }
if ([string]::IsNullOrWhiteSpace($ControlKey)) { throw 'ControlKey zorunlu.' }
$stateRoot = 'C:\ProgramData\KafePin\WebLimit'
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
Set-Content -LiteralPath (Join-Path $stateRoot 'control.key') -Value $ControlKey -Encoding ASCII -NoNewline
@{
  enabled = $true
  downMbps = 50.0
  upMbps = 10.0
  updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateRoot 'state.json') -Encoding UTF8
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
$headers = @{ 'X-KafePin-Token' = $ControlKey }
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 300
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17906/api/health' -Headers $headers -TimeoutSec 2
    if ($health.ok) { $ready = $true; break }
  } catch { }
}
if (-not $ready) { throw 'Web Limit Agent basladi ancak health endpoint hazir olmadi.' }
$body = @{ action='enable'; downMbps=50; upMbps=10 } | ConvertTo-Json
$enabled = Invoke-RestMethod -Uri 'http://127.0.0.1:17906/api/control' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 3
if (-not $enabled.ok -or -not $enabled.enabled) { throw 'Web Limit Agent 50/10 aktif edilemedi.' }
Write-Host 'KafePin Web Limit Agent kuruldu. Varsayilan politika AKTIF 50/10; Client Performans PRO uzerinden acilip kapatilabilir.'
