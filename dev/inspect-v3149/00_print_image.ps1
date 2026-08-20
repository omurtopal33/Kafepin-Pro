param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [int]$Copies = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
if (-not (Test-Path -LiteralPath $ImagePath)) { throw 'Yazdırılacak görüntü bulunamadı.' }

$document = New-Object System.Drawing.Printing.PrintDocument
$document.PrinterSettings.PrinterName = $PrinterName
$document.PrinterSettings.Copies = [Math]::Max(1,[Math]::Min(99,$Copies))
if (-not $document.PrinterSettings.IsValid) { throw "Windows yazıcısı bulunamadı: $PrinterName" }
$document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('A4',827,1169)
$document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(20,20,20,20)
$script:image = [System.Drawing.Image]::FromFile($ImagePath)
$document.DefaultPageSettings.Landscape = $script:image.Width -gt $script:image.Height
$document.add_PrintPage({
  param($sender,$event)
  $target = $event.MarginBounds
  $ratio = [Math]::Min($target.Width / $script:image.Width, $target.Height / $script:image.Height)
  $width = [int]($script:image.Width * $ratio)
  $height = [int]($script:image.Height * $ratio)
  $left = $target.Left + [int](($target.Width-$width)/2)
  $top = $target.Top + [int](($target.Height-$height)/2)
  $event.Graphics.DrawImage($script:image,$left,$top,$width,$height)
  $event.HasMorePages = $false
})
try { $document.Print() } finally { $script:image.Dispose(); $document.Dispose() }
