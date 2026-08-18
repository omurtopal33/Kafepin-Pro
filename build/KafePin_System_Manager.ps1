param([switch]$Loop)

$ErrorActionPreference = 'Stop'
$SystemRoot = Join-Path $env:ProgramData 'KafePinPro'
$ConfigFile = Join-Path $SystemRoot 'manager-config.json'
$TokenFile = Join-Path $SystemRoot 'manager.token'
$ManualStopFile = Join-Path $SystemRoot 'server.manual-stop'
$MaintenanceFile = Join-Path $SystemRoot 'maintenance.lock'
$PidFile = Join-Path $SystemRoot 'server.pid'
$RestoreRequestFile = Join-Path $SystemRoot 'restore-request.json'
$RestorePendingFile = Join-Path $SystemRoot 'restore-request.pending.json'
$RestoreResultFile = Join-Path $SystemRoot 'restore-result.json'
$RestoreApplyResult = Join-Path $SystemRoot 'restore-apply-result.json'
$RestoreWorkerJob = Join-Path $SystemRoot 'restore-worker-job.json'
$RestartRequestFile = Join-Path $SystemRoot 'server-restart-request.json'
$LogDir = Join-Path $SystemRoot 'logs'
$LogFile = Join-Path $LogDir 'system-manager.log'
$MaintenanceMaxAgeSeconds = 240
$ManagerVersion = '3.1.4'

New-Item -ItemType Directory -Force -Path $SystemRoot, $LogDir | Out-Null

function Log([string]$Message) {
  try {
    Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' [mgr-3.1.4] ' + $Message) -Encoding UTF8
  } catch {}
}

function Load-Config {
  if (-not (Test-Path -LiteralPath $ConfigFile)) { throw "Manager config yok: $ConfigFile" }
  return (Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json)
}

$Cfg = Load-Config
$Node = [string]$Cfg.nodePath
$Root = [string]$Cfg.root
$ServerJs = Join-Path $Root 'server.js'
$RestoreApply = Join-Path $Root 'KafePin_Restore_Apply.js'
$ControlPort = if ($Cfg.controlPort) { [int]$Cfg.controlPort } else { 2999 }
$ServerPort = if ($Cfg.port) { [int]$Cfg.port } else { 3000 }

if (-not (Test-Path -LiteralPath $Node)) { throw "Node yok: $Node" }
if (-not (Test-Path -LiteralPath $ServerJs)) { throw "server.js yok: $ServerJs" }
if (-not (Test-Path -LiteralPath $TokenFile)) {
  [guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $TokenFile -Encoding ASCII
}
$Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()

function Write-RestoreResult([bool]$Ok, [string]$Phase, [string]$Message, [bool]$RolledBack = $false) {
  try {
    [ordered]@{
      ok = $Ok
      phase = $Phase
      message = $Message
      rolledBack = $RolledBack
      time = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $RestoreResultFile -Encoding UTF8
  } catch {}
}

function Test-MaintenanceActive {
  if (-not (Test-Path -LiteralPath $MaintenanceFile)) { return $false }
  try {
    $age = ((Get-Date) - (Get-Item -LiteralPath $MaintenanceFile).LastWriteTime).TotalSeconds
    if ($age -gt $MaintenanceMaxAgeSeconds -and -not (Test-Path -LiteralPath $RestoreRequestFile) -and -not (Test-Path -LiteralPath $RestoreWorkerJob)) {
      Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction Stop
      Log ('STALE maintenance.lock temizlendi; yas=' + [int]$age + 'sn')
      return $false
    }
  } catch {}
  return (Test-Path -LiteralPath $MaintenanceFile)
}

function Health {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:3000/api/health?_mgr=' + [DateTime]::UtcNow.Ticks) -TimeoutSec 2 -Headers @{ 'Cache-Control' = 'no-cache' }
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Wait-HealthStable([int]$TimeoutSeconds = 60, [int]$StableChecks = 5) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $stable = 0
  while ((Get-Date) -lt $deadline) {
    if (Health) {
      $stable++
      if ($stable -ge $StableChecks) { return $true }
    } else {
      $stable = 0
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-ServerProcesses {
  $serverFull = ''
  try { $serverFull = [IO.Path]::GetFullPath($ServerJs) } catch { $serverFull = $ServerJs }
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $ok = $false
    try {
      $cmd = [string]$_.CommandLine
      $ok = $cmd -and ($cmd.IndexOf($serverFull, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    } catch {}
    $ok
  })
}

function Stop-Server([int]$ExtraPid = 0) {
  $ids = New-Object System.Collections.Generic.HashSet[int]
  if ($ExtraPid -gt 0) { [void]$ids.Add($ExtraPid) }
  try {
    if (Test-Path -LiteralPath $PidFile) {
      $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
      $pidValue = 0
      if ([int]::TryParse($raw, [ref]$pidValue) -and $pidValue -gt 0) { [void]$ids.Add($pidValue) }
    }
  } catch {}
  foreach ($p in @(Get-ServerProcesses)) {
    try { [void]$ids.Add([int]$p.ProcessId) } catch {}
  }
  foreach ($id in $ids) {
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      Log ('server stop PID=' + $id)
    } catch {}
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-ServerProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return ((Get-ServerProcesses).Count -eq 0)
}

function Start-Server {
  if (Test-MaintenanceActive) { return $null }
  $processes = Get-ServerProcesses
  if ($processes.Count -gt 0) { return [int]$processes[0].ProcessId }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '"' + $ServerJs + '"'
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  $proc = [Diagnostics.Process]::Start($psi)
  if ($proc) {
    $proc.Id | Set-Content -LiteralPath $PidFile -Encoding ASCII
    Log ('server start PID=' + $proc.Id)
    return $proc.Id
  }
  return $null
}

# v3.1.4 FAST CONTROL PATH.
# Normal sağlıklı durumda server.pid + Get-Process yeterlidir. Ağır CIM/port taraması
# yalnız PID yoksa, süreç ölmüşse veya PID şüpheliyse fallback olarak çalışır.
function Get-FastControlServerProcess {
  try {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    $pidValue = 0
    if (-not [int]::TryParse($raw, [ref]$pidValue) -or $pidValue -le 0) { return $null }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ([string]$proc.ProcessName -ine 'node') { return $null }
    return $proc
  } catch { return $null }
}

# v3.1.3 CONTROL-ONLY process detection.
# Restore motorunun stabil Stop-Server / Start-Server fonksiyonlari degistirilmez.
# Panel kontrolu ve update restart'i icin, tam command-line eslesmesine ek olarak
# PID dosyasi ve port 3000'i gercekten dinleyen node.exe de otorite kabul edilir.
function Get-ControlServerProcesses {
  $fast = Get-FastControlServerProcess
  if ($null -ne $fast) { return @($fast) }

  $found = @{}
  foreach ($p in @(Get-ServerProcesses)) {
    try { $found[[int]$p.ProcessId] = $p } catch {}
  }

  try {
    if (Test-Path -LiteralPath $PidFile) {
      $raw = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
      $pidValue = 0
      if ([int]::TryParse($raw, [ref]$pidValue) -and $pidValue -gt 0) {
        $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pidValue) -ErrorAction SilentlyContinue
        if ($pp -and [string]$pp.Name -ieq 'node.exe') { $found[$pidValue] = $pp }
      }
    }
  } catch {}

  $portResolved = $false
  try {
    foreach ($c in @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction Stop)) {
      $portResolved = $true
      $owner = [int]$c.OwningProcess
      if ($owner -le 0) { continue }
      $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $owner) -ErrorAction SilentlyContinue
      if ($pp -and [string]$pp.Name -ieq 'node.exe') { $found[$owner] = $pp }
    }
  } catch {}

  if (-not $portResolved) {
    try {
      foreach ($line in @(& netstat.exe -ano -p tcp 2>$null)) {
        $text = [string]$line
        if ($text -notmatch ('^\s*TCP\s+\S+:' + $ServerPort + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) { continue }
        $owner = [int]$Matches[1]
        $pp = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $owner) -ErrorAction SilentlyContinue
        if ($pp -and [string]$pp.Name -ieq 'node.exe') { $found[$owner] = $pp }
      }
    } catch {}
  }

  @($found.Values)
}

function Stop-ControlServer {
  $ids = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in @(Get-ControlServerProcesses)) {
    try { [void]$ids.Add([int]$p.ProcessId) } catch {}
  }
  foreach ($id in $ids) {
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      Log ('control server stop PID=' + $id)
    } catch {}
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-ControlServerProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return ((Get-ControlServerProcesses).Count -eq 0)
}

function Start-ControlServer {
  if (Test-MaintenanceActive) { return $null }
  $processes = Get-ControlServerProcesses
  if ($processes.Count -gt 0) { return [int]$processes[0].ProcessId }
  return (Start-Server)
}

function Cleanup-RestoreStage($Request) {
  try {
    if ($Request -and $Request.stageDir -and (Test-Path -LiteralPath ([string]$Request.stageDir))) {
      Remove-Item -LiteralPath ([string]$Request.stageDir) -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Run-Apply([bool]$Rollback = $false) {
  if (-not (Test-Path -LiteralPath $RestoreApply)) { throw 'KafePin_Restore_Apply.js bulunamadi' }
  Remove-Item -LiteralPath $RestoreApplyResult -Force -ErrorAction SilentlyContinue
  $applyArgs = @($RestoreApply, $RestoreRequestFile)
  if ($Rollback) { $applyArgs += '--rollback' }
  & $Node @applyArgs 2>&1 | ForEach-Object { Log ('apply: ' + [string]$_) }
  if ($LASTEXITCODE -ne 0) { throw ('Restore apply cikis kodu ' + $LASTEXITCODE) }
  if (-not (Test-Path -LiteralPath $RestoreApplyResult)) { throw 'Restore apply sonuc dosyasi olusmadi' }
  $applyResult = Get-Content -LiteralPath $RestoreApplyResult -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $applyResult.ok) { throw ('Restore apply basarisiz: ' + [string]$applyResult.error) }
}

function Start-ServerStableAfterRestore([int]$Attempts = 1, [int]$TimeoutSeconds = 90) {
  Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $startedPid = Start-Server
    if ($startedPid) { Log ('restore server start deneme=' + $attempt + ' PID=' + $startedPid) }
    else { Log ('restore server start deneme=' + $attempt + ' PID alinamadi') }
    if (Wait-HealthStable $TimeoutSeconds 5) {
      Log ('restore server stabil deneme=' + $attempt + ' - 5 health OK')
      return $true
    }
    Log ('restore server stabil olmadi deneme=' + $attempt)
    if ($attempt -lt $Attempts) {
      Stop-Server 0 | Out-Null
      Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

function Invoke-RestoreRequest {
  if (-not (Test-Path -LiteralPath $RestoreRequestFile)) { return $false }
  $request = $null
  try {
    $request = Get-Content -LiteralPath $RestoreRequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $request -or [string]$request.type -ne 'KAFEPIN_DB_RESTORE') { throw 'restore-request tipi gecersiz' }

    Log ('RESTORE JOB basladi • ' + [string]$request.sourceBackup)
    Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $MaintenanceFile -Value ('restore-manager ' + (Get-Date).ToString('o')) -Encoding ASCII
    Write-RestoreResult $false 'restoring' 'Server Manager geri yuklemeyi uyguluyor' $false

    $sourcePid = 0
    try { $sourcePid = [int]$request.sourceServerPid } catch {}
    if (-not (Stop-Server $sourcePid)) { throw 'KafePin server tamamen durdurulamadi' }
    Start-Sleep -Milliseconds 500

    Run-Apply $false
    Log 'database.db atomik kopya + SHA256 dogrulamasi tamam.'

    Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
    if (-not (Start-ServerStableAfterRestore 1 90)) { throw 'Yeni DB ile sunucu otomatik yeniden baslatilamadi veya stabil olmadi' }

    Write-RestoreResult $true 'complete' 'Yedekten geri yukleme tamamlandi; sunucu stabil' $false
    Log 'RESTORE JOB BASARILI • 5 ardisik health OK'
    Remove-Item -LiteralPath $RestoreRequestFile, $RestoreApplyResult -Force -ErrorAction SilentlyContinue
    Cleanup-RestoreStage $request
    return $true
  } catch {
    $message = $_.Exception.Message
    Log ('RESTORE JOB HATA: ' + $message)
    try {
      Stop-Server 0 | Out-Null
      if ($request -and $request.safetyDb -and (Test-Path -LiteralPath ([string]$request.safetyDb))) {
        Log 'Rollback DB uygulanıyor.'
        Run-Apply $true
        Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        $rollbackOk = Start-ServerStableAfterRestore 1 90
        $suffix = if ($rollbackOk) { ' • eski DB geri alindi' } else { ' • rollback sonrasi server acilamadi' }
        Write-RestoreResult $false 'error' ($message + $suffix) $rollbackOk
        Log ('Rollback sonucu health=' + $rollbackOk)
      } else {
        Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        Start-ServerStableAfterRestore 1 90 | Out-Null
        Write-RestoreResult $false 'error' $message $false
      }
    } catch {
      $rollbackMessage = $_.Exception.Message
      Log ('ROLLBACK HATA: ' + $rollbackMessage)
      Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
      try { Start-ServerStableAfterRestore 1 90 | Out-Null } catch {}
      Write-RestoreResult $false 'error' ($message + ' • rollback hatasi: ' + $rollbackMessage) $false
    }
    Remove-Item -LiteralPath $RestoreRequestFile, $RestoreApplyResult -Force -ErrorAction SilentlyContinue
    Cleanup-RestoreStage $request
    return $true
  } finally {
    Remove-Item -LiteralPath $MaintenanceFile -Force -ErrorAction SilentlyContinue
  }
}

function Server-State {
  $processes = Get-ControlServerProcesses
  $serverPid = $null
  if ($processes.Count -gt 0) { $serverPid = [int]$processes[0].ProcessId }
  [ordered]@{
    ok = $true
    running = ($null -ne $serverPid)
    pid = $serverPid
    manualStopped = (Test-Path -LiteralPath $ManualStopFile)
    maintenance = (Test-MaintenanceActive)
    restorePending = ((Test-Path -LiteralPath $RestoreRequestFile) -or (Test-Path -LiteralPath $RestorePendingFile) -or (Test-Path -LiteralPath $RestoreWorkerJob))
    managerVersion = $ManagerVersion
  }
}

function Send-Json($Context, [int]$Status, $Object) {
  $json = $Object | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $Status
  $Context.Response.ContentType = 'application/json; charset=utf-8'
  $Context.Response.Headers['Access-Control-Allow-Origin'] = '*'
  $Context.Response.Headers['Access-Control-Allow-Headers'] = 'X-KafePin-Manager-Token, Content-Type'
  $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Handle-Request($Context) {
  try {
    if ($Context.Request.HttpMethod -eq 'OPTIONS') { Send-Json $Context 200 @{ ok = $true }; return }
    $given = [string]$Context.Request.Headers['X-KafePin-Manager-Token']
    if (-not $given -or $given -ne $Token) { Send-Json $Context 403 @{ ok = $false; error = 'Yetkisiz' }; return }
    $route = $Context.Request.Url.AbsolutePath.ToLowerInvariant()
    switch ($route) {
      '/status' { Send-Json $Context 200 (Server-State); return }
      '/start' {
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        if (Test-MaintenanceActive) { Send-Json $Context 409 @{ ok = $false; error = 'Bakim modu aktif' }; return }
        Start-ControlServer | Out-Null
        Start-Sleep -Milliseconds 250
        Send-Json $Context 200 (Server-State)
        return
      }
      '/stop' {
        'manual' | Set-Content -LiteralPath $ManualStopFile -Encoding ASCII
        Stop-ControlServer | Out-Null
        Send-Json $Context 200 (Server-State)
        return
      }
      '/restart' {
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        if (Test-MaintenanceActive) { Send-Json $Context 409 @{ ok = $false; error = 'Bakim modu aktif' }; return }
        Stop-ControlServer | Out-Null
        Start-Sleep -Milliseconds 400
        Start-ControlServer | Out-Null
        Send-Json $Context 200 (Server-State)
        return
      }
      '/restore-async' {
        if (Test-Path -LiteralPath $RestoreRequestFile) {
          Send-Json $Context 409 @{ ok = $false; error = 'Restore isi zaten aktif' }
          return
        }
        if (-not (Test-Path -LiteralPath $RestorePendingFile)) {
          Send-Json $Context 409 @{ ok = $false; error = 'Restore pending isi bulunamadi' }
          return
        }
        Move-Item -LiteralPath $RestorePendingFile -Destination $RestoreRequestFile -Force
        Log 'RESTORE async handoff kabul edildi; pending -> request.'
        Send-Json $Context 202 @{ ok = $true; accepted = $true; action = 'restore-async' }
        return
      }
      '/restart-async' {
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $RestartRequestFile -Force -ErrorAction SilentlyContinue
        if (Test-MaintenanceActive) { Send-Json $Context 409 @{ ok = $false; error = 'Bakim modu aktif' }; return }

        # Once HTTP cevabini kesin kapat; sonra ayni Manager restarti dogrudan uygular.
        # Eski kuyruk modeli "kabul edildi" deyip Node'u calisir halde birakabildigi
        # icin update kilidi acik kaliyordu.
        Log 'ASYNC restart istegi kabul edildi; direct restart uygulanacak.'
        Send-Json $Context 202 @{ ok = $true; accepted = $true; action = 'restart-async'; managerVersion = $ManagerVersion }
        Start-Sleep -Milliseconds 250
        try {
          Log 'ASYNC restart uygulanıyor (direct).'
          $stopped = Stop-ControlServer
          if (-not $stopped) { Log 'ASYNC restart: eski server tam kapanmadi.' }
          Start-Sleep -Milliseconds 500
          $newPid = Start-ControlServer
          if ($newPid) { Log ('ASYNC restart yeni server PID=' + $newPid) }
          else { Log 'ASYNC restart yeni server PID alinamadi.' }
        } catch {
          Log ('ASYNC restart direct hata: ' + $_.Exception.Message)
        }
        return
      }
      default { Send-Json $Context 404 @{ ok = $false; error = 'Bilinmeyen istek' }; return }
    }
  } catch {
    try { Send-Json $Context 500 @{ ok = $false; error = $_.Exception.Message } } catch {}
  }
}

try {
  if (Test-Path -LiteralPath $RestorePendingFile) {
    $pendingAge = ((Get-Date) - (Get-Item -LiteralPath $RestorePendingFile).LastWriteTime).TotalMinutes
    if ($pendingAge -gt 10) {
      Remove-Item -LiteralPath $RestorePendingFile -Force
      Log 'Stale restore-request.pending temizlendi.'
    }
  }
} catch {}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add(('http://127.0.0.1:' + $ControlPort + '/'))
try {
  $listener.Start()
  Log ("manager v3.1.4 control listening 127.0.0.1:$ControlPort")
} catch {
  Log ('HttpListener start error: ' + $_.Exception.Message)
  throw
}

# En kritik kural: Manager acilir acilmaz once restore job'u ele alir.
# Restore job varken eski DB ile server baslatilmaz.
if (Test-Path -LiteralPath $RestoreRequestFile) {
  Invoke-RestoreRequest | Out-Null
} elseif (-not (Test-Path -LiteralPath $ManualStopFile) -and -not (Test-MaintenanceActive)) {
  Start-ControlServer | Out-Null
}

try {
  $pendingContext = $listener.BeginGetContext($null, $null)
  while ($true) {
    if (Test-Path -LiteralPath $RestoreRequestFile) {
      Invoke-RestoreRequest | Out-Null
    } elseif (Test-Path -LiteralPath $RestartRequestFile) {
      try {
        Remove-Item -LiteralPath $RestartRequestFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ManualStopFile -Force -ErrorAction SilentlyContinue
        if (-not (Test-MaintenanceActive)) {
          Log 'ASYNC restart uygulanıyor.'
          Stop-ControlServer | Out-Null
          Start-Sleep -Milliseconds 500
          Start-ControlServer | Out-Null
        }
      } catch { Log ('ASYNC restart hata: ' + $_.Exception.Message) }
    } elseif (-not (Test-Path -LiteralPath $ManualStopFile) -and -not (Test-MaintenanceActive)) {
      if ((Get-ControlServerProcesses).Count -eq 0) { Start-ControlServer | Out-Null }
    }

    if ($pendingContext.AsyncWaitHandle.WaitOne(700)) {
      $context = $listener.EndGetContext($pendingContext)
      Handle-Request $context
      $pendingContext = $listener.BeginGetContext($null, $null)
    }
  }
} finally {
  try { $listener.Stop() } catch {}
}
