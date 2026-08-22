param(
  [string]$InstallRoot = 'C:\KafePinPro\YaziciPRO',
  [string]$NodePath = '',
  [string]$PythonPath = '',
  [switch]$SkipRepair
)
$ErrorActionPreference='Stop'
$Expected='3.1.60'
$LogDir=Join-Path $env:LOCALAPPDATA 'KafePinYaziciPRO\logs'
$LogFile=Join-Path $LogDir 'v3160-yazici-startup.log'
$StatusFile=Join-Path $LogDir 'v3160-yazici-startup.json'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
function Log([string]$m){ try{ Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')+' [v3160] '+$m) -Encoding UTF8 }catch{} }
function Health([string]$u){ try{ return Invoke-RestMethod -UseBasicParsing -Uri $u -TimeoutSec 2 }catch{ return $null } }
function Ready {
  $w=Health 'http://127.0.0.1:17891/api/health'
  $r=Health 'http://127.0.0.1:17893/health'
  return ($null -ne $w -and $null -ne $r -and [bool]$w.ok -and [bool]$r.ok -and [string]$w.version -eq $Expected -and [string]$r.version -eq $Expected)
}
function Stop-Old {
  try{
    $self=$PID
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $c=[string]$_.CommandLine; $n=[string]$_.Name
      ([int]$_.ProcessId -ne [int]$self) -and $c -and (
        (($n -ieq 'node.exe') -and $c.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or
        (($n -ieq 'python.exe' -or $n -ieq 'pythonw.exe') -and $c.IndexOf('web_service.py',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.IndexOf('KafePinYaziciPRO',[StringComparison]::OrdinalIgnoreCase) -ge 0)
      )
    } | ForEach-Object { try{ Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }catch{} }
  }catch{}
  Start-Sleep -Milliseconds 700
}
function Find-Node {
  if($NodePath -and (Test-Path -LiteralPath $NodePath -PathType Leaf)){ return $NodePath }
  $np=Join-Path $InstallRoot 'node-path.txt'
  if(Test-Path -LiteralPath $np){ try{ $v=(Get-Content -LiteralPath $np -Raw).Trim(); if($v -and (Test-Path -LiteralPath $v -PathType Leaf)){return $v} }catch{} }
  foreach($p in @('C:\KafePin\node\node.exe','C:\Program Files\nodejs\node.exe','C:\Program Files (x86)\nodejs\node.exe')){ if(Test-Path -LiteralPath $p -PathType Leaf){ return $p } }
  try{ $c=Get-Command node.exe -ErrorAction Stop; if($c.Source){return [string]$c.Source} }catch{}
  throw 'node.exe bulunamadı.'
}
function Find-Python {
  if($PythonPath -and (Test-Path -LiteralPath $PythonPath -PathType Leaf)){ return $PythonPath }
  foreach($n in @('pythonw.exe','python.exe')){
    $p=Join-Path $InstallRoot ('.venv\Scripts\'+$n)
    if(Test-Path -LiteralPath $p -PathType Leaf){ return $p }
  }
  return ''
}
function Repair-Python {
  if($SkipRepair){ return $false }
  $setup=Join-Path $InstallRoot 'KURULUM.cmd'
  if(-not (Test-Path -LiteralPath $setup -PathType Leaf)){ Log 'KURULUM.cmd yok; onarım yapılamadı.'; return $false }
  Log 'Python ortamı onarılıyor.'
  $p=Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',('""'+$setup+'" /silent"')) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -Wait
  Log ('KURULUM çıkış='+$p.ExitCode)
  return ($p.ExitCode -eq 0)
}
function Start-Both {
  $node=Find-Node; $py=Find-Python
  if(-not $py){ if(-not (Repair-Python)){ throw 'Yazıcı PRO Python ortamı bulunamadı.' }; $py=Find-Python }
  if(-not $py){ throw 'Yazıcı PRO Python çalıştırıcısı bulunamadı.' }
  $js=Join-Path $InstallRoot 'KafePin_YaziciGelir_Service.js'; $web=Join-Path $InstallRoot 'web_service.py'
  if(-not (Test-Path -LiteralPath $js)){ throw 'Gelir servisi dosyası bulunamadı.' }
  if(-not (Test-Path -LiteralPath $web)){ throw 'Web servisi dosyası bulunamadı.' }
  $nodeOut=Join-Path $LogDir 'v3160-revenue.out.log'; $nodeErr=Join-Path $LogDir 'v3160-revenue.err.log'
  $pyOut=Join-Path $LogDir 'v3160-webservice.out.log'; $pyErr=Join-Path $LogDir 'v3160-webservice.err.log'
  foreach($f in @($nodeOut,$nodeErr,$pyOut,$pyErr)){ Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  $nproc=Start-Process -FilePath $node -ArgumentList @($js) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  $pproc=Start-Process -FilePath $py -ArgumentList @($web) -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $pyOut -RedirectStandardError $pyErr
  [ordered]@{version=$Expected;startedAt=(Get-Date).ToString('o');nodePid=$nproc.Id;pythonPid=$pproc.Id;node=$node;python=$py} | ConvertTo-Json | Set-Content -LiteralPath $StatusFile -Encoding UTF8
  Log ('Süreçler başlatıldı nodePid='+$nproc.Id+' pythonPid='+$pproc.Id)
}
function Wait-Ready([int]$Seconds){ for($i=0;$i -lt ($Seconds*2);$i++){ if(Ready){return $true}; Start-Sleep -Milliseconds 500 }; return $false }
try{
  Log ('Başlangıç root='+$InstallRoot)
  if(Ready){ Log 'Servisler zaten 3.1.60 hazır.'; exit 0 }
  Stop-Old; Start-Both
  if(Wait-Ready 15){ Log 'BASARILI: 17891+17893 hazır.'; exit 0 }
  Log 'İlk başlatma başarısız; tek sefer Python onarımı deneniyor.'
  Stop-Old
  if(Repair-Python){ Start-Both; if(Wait-Ready 25){ Log 'BASARILI: onarım sonrası 17891+17893 hazır.'; exit 0 } }
  $tail=''
  foreach($f in @('v3160-webservice.err.log','v3160-revenue.err.log')){ $p=Join-Path $LogDir $f; if(Test-Path $p){ try{ $x=(Get-Content $p -Tail 8 -ErrorAction SilentlyContinue) -join ' | '; if($x){$tail += $f+': '+$x+' '} }catch{} } }
  throw ('17891 ve 17893 hazır olmadı. '+$tail)
}catch{ Log ('HATA: '+$_.Exception.Message); Write-Error $_.Exception.Message; exit 22 }
