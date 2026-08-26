from __future__ import annotations


def _replace(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def _replace_in_block(text: str, start_marker: str, end_marker: str, old: str, new: str, label: str) -> str:
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    block = text[start:end]
    count = block.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one occurrence in block, found {count}")
    return text[:start] + block.replace(old, new, 1) + text[end:]


def patch_manager_source(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")

    # A valid PID-file process is only one candidate.  Returning it early hid
    # stale exact server.js processes, so restart could leave a DB writer alive
    # and spawn a second KafePin server.
    text = _replace(
        text,
        "function Get-ControlServerProcesses {\n  $fast = Get-FastControlServerProcess\n  if ($null -ne $fast) { return @($fast) }\n\n  $found = @{}",
        "function Get-ControlServerProcesses {\n  $found = @{}\n  $fast = Get-FastControlServerProcess\n  if ($null -ne $fast) {\n    try { $found[[int]$fast.ProcessId] = $fast } catch {\n      try { $found[[int]$fast.Id] = $fast } catch {}\n    }\n  }",
        "manager process enumeration",
    )
    text = _replace_in_block(
        text,
        "function Stop-ControlServer {",
        "\nfunction Ensure-ProPayloadBeforeServer",
        "    } catch {}\n  }\n  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue",
        "    } catch { Log ('control server stop failed PID=' + $id + ' error=' + $_.Exception.Message) }\n  }\n  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue",
        "manager stop failure log",
    )
    text = _replace(
        text,
        "        Stop-ControlServer | Out-Null\n        Start-Sleep -Milliseconds 400\n        Start-ControlServer | Out-Null\n        Send-Json $Context 200 (Server-State)",
        "        $stopped = Stop-ControlServer\n        if (-not $stopped) {\n          Log 'SYNC restart iptal: eski server tamamen kapanmadi.'\n          Send-Json $Context 409 @{ ok = $false; error = 'Eski server tamamen kapanmadi; yeni server baslatilmadi' }\n          return\n        }\n        Start-Sleep -Milliseconds 400\n        Start-ControlServer | Out-Null\n        Send-Json $Context 200 (Server-State)",
        "manager synchronous restart guard",
    )
    text = _replace(
        text,
        "          if (-not $stopped) { Log 'ASYNC restart: eski server tam kapanmadi.' }\n          Start-Sleep -Milliseconds 500\n          $newPid = Start-ControlServer",
        "          if (-not $stopped) {\n            Log 'ASYNC restart iptal: eski server tamamen kapanmadi; yeni server baslatilmadi.'\n            return\n          }\n          Start-Sleep -Milliseconds 500\n          $newPid = Start-ControlServer",
        "manager async restart guard",
    )
    text = _replace(
        text,
        "          Stop-ControlServer | Out-Null\n          Start-Sleep -Milliseconds 500\n          Start-ControlServer | Out-Null",
        "          $stopped = Stop-ControlServer\n          if (-not $stopped) {\n            Log 'Kuyruk restart iptal: eski server tamamen kapanmadi; yeni server baslatilmadi.'\n          } else {\n            Start-Sleep -Milliseconds 500\n            Start-ControlServer | Out-Null\n          }",
        "manager queued restart guard",
    )
    return ("\ufeff" + text).encode("utf-8")


def patch_manager_ensure_source(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")
    text = _replace(
        text,
        "  $managerSource = Join-Path $InstallRoot 'KafePin_System_Manager.ps1'\n  $managerLive = Join-Path $systemRoot 'KafePin_System_Manager.ps1'\n  if (Test-Path -LiteralPath $managerSource -PathType Leaf) {\n    Copy-Item -LiteralPath $managerSource -Destination $managerLive -Force -ErrorAction SilentlyContinue\n  }",
        "  $managerSource = Join-Path $InstallRoot 'KafePin_System_Manager.ps1'\n"
        "  $managerLive = Join-Path $systemRoot 'KafePin_System_Manager.ps1'\n"
        "  $managerChanged = $false\n"
        "  if (Test-Path -LiteralPath $managerSource -PathType Leaf) {\n"
        "    if (-not (Test-Path -LiteralPath $managerLive -PathType Leaf)) { $managerChanged = $true }\n"
        "    else {\n"
        "      try { $managerChanged = ((Get-FileHash -LiteralPath $managerSource -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $managerLive -Algorithm SHA256).Hash) } catch { $managerChanged = $true }\n"
        "    }\n"
        "    if ($managerChanged) { Copy-Item -LiteralPath $managerSource -Destination $managerLive -Force -ErrorAction Stop }\n"
        "  }",
        "manager ensure hash-aware copy",
    )
    text = _replace(
        text,
        "  if (Test-Path -LiteralPath $schtasks -PathType Leaf) {\n    $psi = New-Object System.Diagnostics.ProcessStartInfo",
        "  if (Test-Path -LiteralPath $schtasks -PathType Leaf) {\n"
        "    if ($managerChanged) {\n"
        "      try { & $schtasks /End /TN 'KafePin Pro Server Manager' 2>$null | Out-Null } catch {}\n"
        "      Start-Sleep -Milliseconds 500\n"
        "    }\n"
        "    $psi = New-Object System.Diagnostics.ProcessStartInfo",
        "manager ensure task reload",
    )
    return ("\ufeff" + text).encode("utf-8")
