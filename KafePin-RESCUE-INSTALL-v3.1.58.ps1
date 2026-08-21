param(
  [string]$InstallRoot = 'C:\KafePin',
  [string]$LocalZipPath = '',
  [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$TargetVersion = '3.1.58'
$DownloadUrl = 'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.58.zip'
$ExpectedZipSha = '0e911bccdc67f2bdeb612f6de65116c5f5ab64a2779c931587fe8940d4486099'
$ProgramDataRoot = Join-Path ($env:ProgramData) 'KafePinPro'
$LogDir = Join-Path $ProgramDataRoot 'logs'
$RescueLog = Join-Path $LogDir 'v3158-direct-rescue.log'
$ManagerTokenFile = Join-Path $ProgramDataRoot 'manager.token'
$UpdateLockFile = Join-Path $ProgramDataRoot 'update-install-lock.json'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log([string]$m) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Write-Host $line
  Add-Content -LiteralPath $RescueLog -Value $line -Encoding UTF8
}
function FileSha([string]$p) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
function Get-Version {
  $p = Join-Path $InstallRoot 'kafepin-pro-version.json'
  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ return '' }
  try { return [string]((Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { return '' }
}
function Compare-Version([string]$a,[string]$b) {
  $aa=@($a.Split('.')|ForEach-Object{[int]$_});$bb=@($b.Split('.')|ForEach-Object{[int]$_})
  for($i=0;$i -lt [Math]::Max($aa.Count,$bb.Count);$i++){
    $av=if($i -lt $aa.Count){$aa[$i]}else{0};$bv=if($i -lt $bb.Count){$bb[$i]}else{0}
    if($av -gt $bv){return 1};if($av -lt $bv){return -1}
  }
  return 0
}
function Get-PortPid([int]$Port) {
  try {
    $c=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop|Select-Object -First 1
    if($c){return [int]$c.OwningProcess}
  } catch {}
  try {
    $line = (& netstat.exe -ano -p tcp | Select-String -Pattern (':'+$Port+'\s+.*LISTENING\s+(\d+)') | Select-Object -First 1).Line
    if($line -match 'LISTENING\s+(\d+)'){return [int]$Matches[1]}
  } catch {}
  return 0
}
function Test-ServerHttp {
  try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 3; return ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 500) } catch { return $false }
}
function Wait-NewServer([int]$OldPid,[int]$Seconds=90) {
  $deadline=(Get-Date).AddSeconds($Seconds)
  while((Get-Date) -lt $deadline){
    Start-Sleep -Seconds 2
    $pid=Get-PortPid 3000
    if($pid -gt 0 -and ($OldPid -le 0 -or $pid -ne $OldPid) -and (Test-ServerHttp)){ Log ('Server ready. PID='+$pid); return $pid }
  }
  throw 'Server did not return on port 3000 with a new PID.'
}
function Repair-OldManagerSha {
  $mgr=Join-Path $InstallRoot 'KafePin_Manager_Ensure.ps1'
  if(-not (Test-Path -LiteralPath $mgr -PathType Leaf)){ throw ('Manager missing: '+$mgr) }
  $text=Get-Content -LiteralPath $mgr -Raw -Encoding UTF8
  $normalized=$text.Replace("`r`n","`n")
  if($normalized.Contains('$destSha -ne $sourceSha')){ Log 'Manager SHA mode already repaired.'; return }
  $copyLine='    Copy-Item -LiteralPath $src -Destination $dst -Force'
  $oldCompare="    if ((YaziciFileSha `$dst) -ne [string]`$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]`$pair.Dst) }"
  if(-not $normalized.Contains($copyLine) -or -not $normalized.Contains($oldCompare)){ throw 'Old Manager SHA block not found; refusing blind edit.' }
  $backup=$mgr+'.before-direct-rescue-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.bak'
  Copy-Item -LiteralPath $mgr -Destination $backup -Force
  $newCopy="    # direct rescue: use real package source SHA, never stale pair.Sha`n    `$sourceSha = YaziciFileSha `$src`n$copyLine"
  $newCompare="    `$destSha = YaziciFileSha `$dst`n    if (`$destSha -ne `$sourceSha) { throw ('Yazici PRO source-target SHA256 verify failed: ' + [string]`$pair.Dst) }"
  $normalized=$normalized.Replace($copyLine,$newCopy).Replace($oldCompare,$newCompare)
  [IO.File]::WriteAllText($mgr,$normalized.Replace("`n","`r`n"),(New-Object Text.UTF8Encoding($true)))
  $tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($mgr,[ref]$tokens,[ref]$errors)|Out-Null
  if($errors.Count){Copy-Item -LiteralPath $backup -Destination $mgr -Force;throw 'Manager parse failed; backup restored.'}
  Log 'Old Manager stale SHA gate repaired.'
}
function Find-Node {
  foreach($p in @((Join-Path $InstallRoot 'node\node.exe'),'C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')){if(Test-Path -LiteralPath $p -PathType Leaf){return $p}}
  try{$c=Get-Command node.exe -ErrorAction Stop;return [string]$c.Source}catch{}
  throw 'node.exe not found.'
}
function Ensure-Manager {
  $mgr=Join-Path $InstallRoot 'KafePin_Manager_Ensure.ps1';$node=Find-Node
  Log 'Ensuring Server Manager...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mgr -InstallRoot $InstallRoot -NodePath $node
  if($LASTEXITCODE -ne 0){throw ('Manager ensure failed. Exit='+$LASTEXITCODE)}
  Log 'Server Manager ready.'
}
function Request-Restart {
  if(-not (Test-Path -LiteralPath $ManagerTokenFile -PathType Leaf)){throw 'Manager token missing.'}
  $token=(Get-Content -LiteralPath $ManagerTokenFile -Raw).Trim();if(-not $token){throw 'Manager token empty.'}
  $headers=@{'X-KafePin-Manager-Token'=$token;'Cache-Control'='no-cache'}
  $r=Invoke-RestMethod -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:2999/restart-async' -Headers $headers -TimeoutSec 10
  if(-not $r.ok -or -not $r.accepted){throw 'Manager restart request not accepted.'}
  Log 'Manager restart accepted.'
}
function Stop-InFlightUpdater {
  $oldPid=Get-PortPid 3000
  if($oldPid -le 0){Log 'No active server PID; no in-flight updater to cancel.';return}
  Log ('Preflight restart cancels any old in-flight updater. Old PID='+$oldPid)
  Request-Restart
  [void](Wait-NewServer $oldPid 90)
}

if(-not (Test-Path -LiteralPath $InstallRoot -PathType Container)){throw ('Install root missing: '+$InstallRoot)}
Log ('DIRECT RESCUE START target='+$TargetVersion+' root='+$InstallRoot)

if(-not $PrepareOnly){
  Repair-OldManagerSha
  Ensure-Manager
  $current=Get-Version
  if($current -and (Compare-Version $current $TargetVersion) -ge 0){
    Log ('Target already on disk: v'+$current+'. Verifying clean restart.')
    $oldPid=Get-PortPid 3000
    Request-Restart
    [void](Wait-NewServer $oldPid 90)
    if(Test-Path -LiteralPath $UpdateLockFile){Remove-Item -LiteralPath $UpdateLockFile -Force -ErrorAction SilentlyContinue}
    Write-Host 'KAFEPIN_V3158_DIRECT_RESCUE_OK'
    exit 0
  }
  Stop-InFlightUpdater
}

$work=Join-Path $env:TEMP ('kafepin-v3158-direct-'+[guid]::NewGuid().ToString('N'))
$zip=if($LocalZipPath){$LocalZipPath}else{Join-Path $work 'KafePin-Pro-Update-v3.1.58.zip'}
$expanded=Join-Path $work 'expanded'
New-Item -ItemType Directory -Force -Path $work,$expanded|Out-Null
try {
  if(-not $LocalZipPath){
    Log 'Downloading official v3.1.58 package directly...'
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $zip -TimeoutSec 300
  }
  if(-not (Test-Path -LiteralPath $zip -PathType Leaf)){throw 'Update ZIP missing.'}
  $sha=FileSha $zip
  if($sha -ne $ExpectedZipSha){throw ('ZIP SHA256 mismatch. Expected='+$ExpectedZipSha+' Actual='+$sha)}
  Log ('ZIP SHA256 verified: '+$sha)
  Expand-Archive -LiteralPath $zip -DestinationPath $expanded -Force
  $metaPath=Join-Path $expanded 'update.json'
  if(-not (Test-Path -LiteralPath $metaPath -PathType Leaf)){throw 'update.json missing.'}
  $meta=Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8|ConvertFrom-Json
  if([string]$meta.version -ne $TargetVersion){throw ('Package version mismatch: '+[string]$meta.version)}
  $files=@($meta.files);if($files.Count -lt 1){throw 'Package file list empty.'}
  foreach($relObj in $files){
    $rel=[string]$relObj
    if([IO.Path]::IsPathRooted($rel) -or $rel -match '(^|[\\/])\.\.([\\/]|$)'){throw ('Unsafe package path: '+$rel)}
    $src=Join-Path $expanded $rel
    if(-not (Test-Path -LiteralPath $src -PathType Leaf)){throw ('Package file missing: '+$rel)}
  }
  $backup=Join-Path $InstallRoot ('backups\direct-rescue-v3158-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $backup|Out-Null
  Log ('Backing up overwritten files to '+$backup)
  foreach($relObj in $files){
    $rel=[string]$relObj;$dst=Join-Path $InstallRoot $rel
    if(Test-Path -LiteralPath $dst -PathType Leaf){
      $bd=Join-Path $backup $rel;New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bd)|Out-Null;Copy-Item -LiteralPath $dst -Destination $bd -Force
    }
  }
  Log 'Copying verified package files...'
  foreach($relObj in $files){
    $rel=[string]$relObj;$src=Join-Path $expanded $rel;$dst=Join-Path $InstallRoot $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst)|Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    if((FileSha $src) -ne (FileSha $dst)){throw ('Source-target SHA mismatch after copy: '+$rel)}
  }
  $versionData=[ordered]@{version=$TargetVersion;channel='candidate';mode='direct-rescue';installedAt=(Get-Date).ToString('o')}
  $versionData|ConvertTo-Json -Depth 3|Set-Content -LiteralPath (Join-Path $InstallRoot 'kafepin-pro-version.json') -Encoding UTF8
  if((Get-Version) -ne $TargetVersion){throw 'Version marker write failed.'}
  Log 'All files copied and version marker is v3.1.58.'
  if($PrepareOnly){Write-Host 'KAFEPIN_V3158_DIRECT_RESCUE_PREPARE_OK';exit 0}

  Ensure-Manager
  $oldPid=Get-PortPid 3000
  Request-Restart
  $newPid=Wait-NewServer $oldPid 120
  Start-Sleep -Seconds 10
  if((Get-Version) -ne $TargetVersion){throw ('Final version verify failed: '+(Get-Version))}
  if(-not (Test-ServerHttp)){throw 'Final server HTTP verify failed.'}
  if(Test-Path -LiteralPath $UpdateLockFile){Remove-Item -LiteralPath $UpdateLockFile -Force -ErrorAction SilentlyContinue}
  Log ('FINAL OK v3.1.58 server PID='+$newPid)
  Write-Host 'KAFEPIN_V3158_DIRECT_RESCUE_OK'
} finally {
  if(-not $LocalZipPath){Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
}
