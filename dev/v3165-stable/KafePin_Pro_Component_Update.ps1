param(
  [string]$InstallRoot = 'C:\KafePin',
  [string]$ProRoot = 'C:\KafePinPro'
)

$ErrorActionPreference = 'Stop'
$payload = Join-Path $InstallRoot 'pro-components'
$log = Join-Path $InstallRoot 'logs\pro-component-update.log'
$marker = Join-Path $InstallRoot 'config\pro-components-sync-v3.1.65.done'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null

# Her kararlı paket yalnız bir kez uygulanır. Böylece çalışan oturumlar her
# yönetici sayfası açılışında tekrar kopyalanmaz.
if (Test-Path -LiteralPath $marker -PathType Leaf) { exit 0 }

function Log([string]$message) {
  Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $message) -Encoding UTF8
}

function Sync-SelectedComponent([string]$name, [string]$target) {
  $archive = Join-Path $payload ($name + '.zip')
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { Log ($name + ' seçili değil; atlandı.'); return }
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { Log ($name + ' paketi bulunamadı; atlandı.'); return }
  $temp = Join-Path $env:TEMP ('KafePin-Pro-Update-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $temp -Force
    Get-ChildItem -LiteralPath $temp -Force | Where-Object {
      $_.Name -notin @('config.py', 'state.json', 'favorites.json', '.env')
    } | ForEach-Object {
      # Kullanıcının çalışma ayarları ve kayıtları korunur; yalnız program dosyaları eşitlenir.
      Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }
    Log ($name + ' program dosyaları eşitlendi: ' + $target)
  } catch {
    Log ($name + ' güncellemesi başarısız: ' + $_.Exception.Message)
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Sync-SelectedComponent 'mp3-bot-pro' (Join-Path $ProRoot 'MP3BotPRO')
Sync-SelectedComponent 'yazici-pro' (Join-Path $ProRoot 'YaziciPRO')
Sync-SelectedComponent 'teknik-servis-pro' (Join-Path $ProRoot 'TeknikServisPRO')
Sync-SelectedComponent 'client-yonetim-pro' (Join-Path $ProRoot 'ClientYonetimPRO')
New-Item -ItemType File -Force -Path $marker | Out-Null
Log 'v3.1.65 PRO eşitlemesi tamamlandı.'
