$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $root 'test_failsafe_update_lock.js')
if ($LASTEXITCODE -ne 0) { throw "fail-safe update lock tests failed: $LASTEXITCODE" }
node (Join-Path $root 'test_runtime_regressions.js')
if ($LASTEXITCODE -ne 0) { throw "runtime regression tests failed: $LASTEXITCODE" }
Write-Host 'FAILSAFE_UPDATE_LOCK_WINDOWS_TESTS_OK'
