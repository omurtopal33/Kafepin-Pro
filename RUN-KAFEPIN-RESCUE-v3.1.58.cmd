@echo off
setlocal
title KafePin Pro v3.1.58 Direct Rescue

net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ============================================================
echo   KafePin Pro v3.1.58 - DIRECT RESCUE INSTALL
echo ============================================================
echo.
echo Do not close this window until FINAL OK appears.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0KafePin-RESCUE-INSTALL-v3.1.58.ps1"
set "EC=%ERRORLEVEL%"
echo.
if "%EC%"=="0" (
  echo [OK] KafePin v3.1.58 direct rescue completed.
) else (
  echo [ERROR] Rescue failed. Send this full screen to ChatGPT.
)
echo.
pause
exit /b %EC%
