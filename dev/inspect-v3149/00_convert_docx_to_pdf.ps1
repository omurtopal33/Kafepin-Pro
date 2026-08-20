param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $document = $word.Documents.Open($InputPath, $false, $true)
  # Word's fixed-format PDF type.
  $document.ExportAsFixedFormat($OutputPath, 17)
} finally {
  if ($document) { $document.Close($false) }
  if ($word) { $word.Quit() }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
