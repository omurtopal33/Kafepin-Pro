param(
  [ValidateSet('list','scan')][string]$Mode,
  [string]$DeviceId = '',
  [int]$Dpi = 300,
  [ValidateSet('color','gray')][string]$ColorMode = 'color',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'

function Get-WiaProperty($Collection, [int]$Id) {
  try { return $Collection.Item($Id) } catch { return $null }
}

if ($Mode -eq 'list') {
  $manager = New-Object -ComObject WIA.DeviceManager
  $items = @()
  for ($i = 1; $i -le $manager.DeviceInfos.Count; $i++) {
    $info = $manager.DeviceInfos.Item($i)
    # 1 = ScannerType; other WIA devices (camera etc.) are intentionally hidden.
    if ([int]$info.Type -ne 1) { continue }
    $name = ''
    $manufacturer = ''
    try { $name = [string]$info.Properties.Item('Name').Value } catch {}
    try { $manufacturer = [string]$info.Properties.Item('Manufacturer').Value } catch {}
    $items += [pscustomobject]@{
      id = [string]$info.DeviceID
      name = $name
      manufacturer = $manufacturer
      supports_adf = $false
    }
  }
  @($items) | ConvertTo-Json -Compress
  exit 0
}

if (-not $DeviceId) { throw 'Tarayıcı seçilmedi.' }
if (-not $Output) { throw 'Tarama çıktı yolu eksik.' }
$manager = New-Object -ComObject WIA.DeviceManager
$selected = $null
for ($i = 1; $i -le $manager.DeviceInfos.Count; $i++) {
  $candidate = $manager.DeviceInfos.Item($i)
  if ([string]$candidate.DeviceID -eq $DeviceId) { $selected = $candidate; break }
}
if ($null -eq $selected) { throw 'Seçilen WIA tarayıcısı Windows tarafından bulunamadı.' }
$device = $selected.Connect()
$item = $device.Items.Item(1)

# WIA_IPS_XRES / YRES / CUR_INTENT. Device support varies; unsupported
# properties are skipped and the driver uses its own safe default.
foreach ($propertyId in @(6147,6148)) {
  $property = Get-WiaProperty $item.Properties $propertyId
  if ($null -ne $property) { try { $property.Value = [Math]::Max(75,[Math]::Min(600,$Dpi)) } catch {} }
}
$intent = Get-WiaProperty $item.Properties 6146
if ($null -ne $intent) { try { $intent.Value = if($ColorMode -eq 'gray'){2}else{1} } catch {} }

# Bazı Epson WIA sürücüleri format GUID'i verilince "Geçersiz sınıf dizesi"
# döndürür. Parametresiz Transfer cihazın desteklediği varsayılan formatı
# seçer; Python katmanı veriyi sonra PNG/PDF'ye dönüştürür.
$image = $item.Transfer()
$folder = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$image.SaveFile($Output)
[pscustomobject]@{ ok=$true; output=$Output } | ConvertTo-Json -Compress
