@echo off
setlocal
cd /d "%~dp0"
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if exist "C:\KafePin\node\node.exe" set "NODE=C:\KafePin\node\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if defined NODE if exist "%NODE%" (
  start "KafePin Yazici Gelir" /min "%NODE%" "%~dp0KafePin_YaziciGelir_Service.js"
)
if not exist ".venv\Scripts\pythonw.exe" (
  echo Yazici PRO Python ortami bulunamadi.
  exit /b 21
)
start "Yazici PRO" /min "%~dp0.venv\Scripts\pythonw.exe" "%~dp0web_service.py"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:17891/?v=3151candidate1"
