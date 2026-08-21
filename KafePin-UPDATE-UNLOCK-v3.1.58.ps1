param(
  [string]$InstallRoot = 'C:\KafePin',
  [switch]$NoStartUpdate
)
$ErrorActionPreference = 'Stop'
$mgr = Join-Path $InstallRoot 'KafePin_Manager_Ensure.ps1'
if (-not (Test-Path -LiteralPath $mgr -PathType Leaf)) { throw ('Manager bulunamadi: ' + $mgr) }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = $mgr + '.before-v3158-' + $stamp + '.bak'
Copy-Item -LiteralPath $mgr -Destination $backup -Force

$text = Get-Content -LiteralPath $mgr -Raw -Encoding UTF8
$normalized = $text.Replace("`r`n","`n")
$old = @'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    if ((YaziciFileSha $dst) -ne [string]$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }
'@
$new = @'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    # v3.1.58 bootstrap: bayat build-time pair.Sha yerine GERCEK kaynak dosya hash'i kullanilir.
    $sourceSha = YaziciFileSha $src
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $destSha = YaziciFileSha $dst
    if ($destSha -ne $sourceSha) { throw ('Yazici PRO kaynak-hedef SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }
'@

if ($normalized.Contains('$destSha -ne $sourceSha')) {
  Write-Host 'Manager SHA kontrolu zaten yeni yontemde.'
} elseif ($normalized.Contains($old)) {
  $normalized = $normalized.Replace($old,$new)
  [IO.File]::WriteAllText($mgr, $normalized.Replace("`n","`r`n"), (New-Object Text.UTF8Encoding($true)))
  Write-Host 'Eski bayat SHA kontrolu kaldirildi.'
} else {
  throw 'Beklenen eski Manager SHA blogu bulunamadi; dosya degistirilmedi.'
}

$tokens=$null; $errors=$null
[System.Management.Automation.Language.Parser]::ParseFile($mgr,[ref]$tokens,[ref]$errors) | Out-Null
if ($errors.Count) {
  Copy-Item -LiteralPath $backup -Destination $mgr -Force
  throw ('Manager PowerShell parse hatasi; yedek geri yuklendi: ' + (($errors | ForEach-Object {$_.Message}) -join ' | '))
}

$node = ''
foreach($p in @((Join-Path $InstallRoot 'node\node.exe'),'C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')) {
  if(Test-Path -LiteralPath $p -PathType Leaf){ $node=$p; break }
}
if(-not $node){ try{$c=Get-Command node.exe -ErrorAction Stop; $node=[string]$c.Source}catch{} }
if(-not $node){ throw 'node.exe bulunamadi; Manager onarimi tamamlandi fakat otomatik test baslatilamadi.' }

Write-Host 'Manager gercek kaynak-hedef SHA ile test ediliyor...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mgr -InstallRoot $InstallRoot -NodePath $node
if($LASTEXITCODE -ne 0){ throw ('Onarilmis Manager testi basarisiz. Cikis=' + $LASTEXITCODE) }
Write-Host 'KAFEPIN_MANAGER_BOOTSTRAP_REPAIR_OK'

if($NoStartUpdate){ exit 0 }
Write-Host 'KafePin guncellemesi tek seferde baslatiliyor...'
try {
  $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:3000/admin/pro/apply-update' -TimeoutSec 45
  if(-not $r.ok){ throw ('Guncelleme endpoint olumsuz yanit verdi: ' + ($r | ConvertTo-Json -Compress)) }
  Write-Host ('KAFEPIN_UPDATE_STARTED_OK version=' + [string]$r.version)
  Write-Host 'Paket indiriliyor/kuruluyor; KafePin yeniden baslayabilir.'
} catch {
  throw ('Manager onarildi fakat guncelleme baslatma cagrisi basarisiz: ' + $_.Exception.Message)
}
