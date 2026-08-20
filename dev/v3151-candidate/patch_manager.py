from pathlib import Path
import hashlib, sys

manager=Path(sys.argv[1])
payload=Path(sys.argv[2])
s=manager.read_text(encoding='utf-8-sig')

files=[
 ('index.html',r'web\index.html'),
 ('KafePin_YaziciGelir_Service.js','KafePin_YaziciGelir_Service.js'),
 ('START_YAZICI_PRO.cmd','START_YAZICI_PRO.cmd'),
 ('yazici-pro-version.json','yazici-pro-version.json'),
]
items=[]
for src,dst in files:
    h=hashlib.sha256((payload/src).read_bytes()).hexdigest()
    items.append(f"    [pscustomobject]@{{ Src='{src}'; Dst='{dst}'; Sha='{h}' }}")

block=r'''

  # v3.1.51 CANDIDATE1 - Yazici PRO gelir katmani gercek kurulum klasorune
  # dogrudan uygulanir. MP3 PRO, Teknik Servis PRO ve diger bilesenlere dokunulmaz.
  $YaziciPayload = Join-Path $InstallRoot 'v3151-yazici-payload'
  $YaziciRoot = Join-Path $InstallRoot 'KafePinYaziciPRO'
  $YaziciWeb = Join-Path $YaziciRoot 'web'
  $YaziciLog = Join-Path $LogDir 'v3151-yazici-apply.log'
  function YaziciLog([string]$Text) {
    try { Add-Content -LiteralPath $YaziciLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [v3.1.51-candidate1] ' + $Text) -Encoding UTF8 } catch {}
  }
  function YaziciFileSha([string]$P) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $P).Hash.ToLowerInvariant() }

  if (-not (Test-Path -LiteralPath $YaziciPayload -PathType Container)) { throw 'v3.1.51 Yazici payload klasoru bulunamadi.' }
  if (-not (Test-Path -LiteralPath $YaziciRoot -PathType Container)) { throw ('Yazici PRO kurulum klasoru bulunamadi: ' + $YaziciRoot) }
  New-Item -ItemType Directory -Force -Path $YaziciWeb | Out-Null

  $pairs = @(
__PAIRS__
  )
  foreach ($pair in $pairs) {
    $src = Join-Path $YaziciPayload ([string]$pair.Src)
    $dst = Join-Path $YaziciRoot ([string]$pair.Dst)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw ('Yazici payload dosyasi eksik: ' + [string]$pair.Src) }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    if ((YaziciFileSha $dst) -ne [string]$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }
    YaziciLog ('Kopya+SHA OK: ' + [string]$pair.Dst)
  }

  $indexPath = Join-Path $YaziciWeb 'index.html'
  $indexRaw = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8
  if ($indexRaw.IndexOf('v3151Verified',[StringComparison]::Ordinal) -lt 0) { throw 'Yazici PRO v3.1.51 arayuz marker dogrulamasi basarisiz.' }
  if ($indexRaw.IndexOf('WHATSAPP / HIZLI CIKTI',[StringComparison]::OrdinalIgnoreCase) -lt 0 -and $indexRaw.IndexOf('WHATSAPP / HIZLI ÇIKTI',[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Yazici PRO Hizli Cikti sekmesi bulunamadi.' }

  Set-Content -LiteralPath (Join-Path $YaziciRoot 'node-path.txt') -Value $node -Encoding ASCII
  try { & wevtutil.exe sl 'Microsoft-Windows-PrintService/Operational' /e:true 2>$null | Out-Null } catch {}

  $revenueService = Join-Path $YaziciRoot 'KafePin_YaziciGelir_Service.js'
  $syntax = Start-Process -FilePath $node -ArgumentList @('--check', $revenueService) -WorkingDirectory $YaziciRoot -WindowStyle Hidden -Wait -PassThru
  if ($syntax.ExitCode -ne 0) { throw ('Yazici Geliri Node syntax kontrolu basarisiz. exit=' + $syntax.ExitCode) }

  # Eski v3.1.50/3.1.51 gelir servisi aciksa ayni portta eski kod kalmasin.
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $cmd=[string]$_.CommandLine
      $cmd -and $cmd.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { try { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue } catch {} }
  } catch {}
  Start-Process -FilePath $node -ArgumentList @($revenueService) -WorkingDirectory $YaziciRoot -WindowStyle Hidden | Out-Null

  [ordered]@{
    version='3.1.51'; build='candidate1'; appliedAt=(Get-Date).ToString('o');
    yaziciRoot=$YaziciRoot; revenuePort=17893
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $SystemRoot 'v3151-yazici-applied.json') -Encoding UTF8
  YaziciLog 'BASARILI: v3.1.51 Yazici PRO payload gercek hedefe uygulandi.'
'''.replace('__PAIRS__',',\n'.join(items))

needle='''try {\n  $node = Find-Node\n'''
if needle not in s:
    raise SystemExit('manager insertion marker missing')
if 'v3.1.51 CANDIDATE1' in s:
    raise SystemExit('manager already patched')
s=s.replace(needle, needle+block, 1)
manager.write_text(s,encoding='utf-8-sig')
print('MANAGER_PATCH_OK')
