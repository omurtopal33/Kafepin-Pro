param([string]$InstallRoot='C:\KafePin')
$ErrorActionPreference='Stop'
function Get-Version {
  $p=Join-Path $InstallRoot 'kafepin-pro-version.json'
  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){return ''}
  try{return [string]((Get-Content -LiteralPath $p -Raw -Encoding UTF8|ConvertFrom-Json).version)}catch{return ''}
}
function Find-Node {
  foreach($p in @((Join-Path $InstallRoot 'node\node.exe'),'C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')){if(Test-Path -LiteralPath $p -PathType Leaf){return $p}}
  try{$c=Get-Command node.exe -ErrorAction Stop;return [string]$c.Source}catch{}
  throw 'node.exe not found.'
}
function Get-PortPid([int]$Port){
  try{$c=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop|Select-Object -First 1;if($c){return [int]$c.OwningProcess}}catch{}
  try{$line=(& netstat.exe -ano -p tcp|Select-String -Pattern (':'+$Port+'\s+.*LISTENING\s+(\d+)')|Select-Object -First 1).Line;if($line -match 'LISTENING\s+(\d+)'){return [int]$Matches[1]}}catch{}
  return 0
}
function Test-ServerHttp {
  try{$r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 3;return ([int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 500)}catch{return $false}
}
function Wait-NewServer([int]$OldPid,[int]$Seconds=120){
  $deadline=(Get-Date).AddSeconds($Seconds)
  while((Get-Date) -lt $deadline){
    Start-Sleep -Seconds 2
    $serverPid=Get-PortPid 3000
    if($serverPid -gt 0 -and ($OldPid -le 0 -or $serverPid -ne $OldPid) -and (Test-ServerHttp)){Write-Host ('SERVER_READY PID='+$serverPid);return $serverPid}
  }
  throw 'Server did not return on port 3000 with a new PID.'
}
if((Get-Version) -ne '3.1.58'){throw ('Expected v3.1.58 on disk, found: '+(Get-Version))}
$mgr=Join-Path $InstallRoot 'KafePin_Manager_Ensure.ps1'
if(-not (Test-Path -LiteralPath $mgr -PathType Leaf)){throw 'Manager script missing.'}
$node=Find-Node
Write-Host 'Ensuring Server Manager...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $mgr -InstallRoot $InstallRoot -NodePath $node
if($LASTEXITCODE -ne 0){throw ('Manager ensure failed. Exit='+$LASTEXITCODE)}
$tokenFile=Join-Path $env:ProgramData 'KafePinPro\manager.token'
if(-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)){throw 'Manager token missing.'}
$token=(Get-Content -LiteralPath $tokenFile -Raw).Trim();if(-not $token){throw 'Manager token empty.'}
$oldPid=Get-PortPid 3000
$headers=@{'X-KafePin-Manager-Token'=$token;'Cache-Control'='no-cache'}
$r=Invoke-RestMethod -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:2999/restart-async' -Headers $headers -TimeoutSec 10
if(-not $r.ok -or -not $r.accepted){throw 'Manager restart request not accepted.'}
Write-Host 'Manager restart accepted.'
$newPid=Wait-NewServer $oldPid 120
Start-Sleep -Seconds 5
if((Get-Version) -ne '3.1.58'){throw 'Version changed after restart.'}
if(-not (Test-ServerHttp)){throw 'Final server HTTP verify failed.'}
$lock=Join-Path $env:ProgramData 'KafePinPro\update-install-lock.json'
if(Test-Path -LiteralPath $lock){Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue}
Write-Host ('FINAL_OK v3.1.58 PID='+$newPid)
exit 0
