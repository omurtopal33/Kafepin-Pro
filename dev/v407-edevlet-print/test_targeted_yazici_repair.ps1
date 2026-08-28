param([Parameter(Mandatory=$true)][string]$CandidateZip)
$ErrorActionPreference='Stop'
$root=Join-Path $env:TEMP ('v407-yazici-repair-'+[guid]::NewGuid().ToString('N'))
try {
  $candidate=Join-Path $root 'candidate'; $payload=Join-Path $root 'payload'; $target=Join-Path $root 'YaziciPRO'
  New-Item -ItemType Directory -Force -Path $candidate,$payload,$target | Out-Null
  Expand-Archive -LiteralPath $CandidateZip -DestinationPath $candidate -Force
  Expand-Archive -LiteralPath (Join-Path $candidate 'pro-components\yazici-pro.zip') -DestinationPath $payload -Force
  Set-Content -LiteralPath (Join-Path $target 'KafePin_YaziciGelir_Service.js') -Value 'STALE_SAME_VERSION_PAYLOAD' -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $payload 'yazici-pro-version.json') -Destination (Join-Path $target 'yazici-pro-version.json') -Force
  Set-Content -LiteralPath (Join-Path $target 'settings.json') -Value '{"keep":true}' -Encoding UTF8

  . (Join-Path $candidate 'KafePin_Pro_Component_Manager.ps1') -Action status -Component yazici-pro | Out-Null
  Copy-ComponentFiles $payload $target $true

  $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'KafePin_YaziciGelir_Service.js')).Hash
  $expected=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $payload 'KafePin_YaziciGelir_Service.js')).Hash
  if($actual -ne $expected){throw "Stale same-version payload was not repaired: actual=$actual expected=$expected"}
  if((Get-Content -Raw -LiteralPath (Join-Path $target 'settings.json')) -notmatch 'keep'){throw 'User settings were not preserved'}
  'TARGETED_YAZICI_REPAIR_PASS same-version-stale=replaced settings=preserved'
} finally {
  if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
}
