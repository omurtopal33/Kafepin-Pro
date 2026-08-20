@echo off
setlocal
cd /d "%~dp0"
set "SILENT=0"
if /I "%~1"=="/silent" set "SILENT=1"
py -3 -m venv .venv || exit /b 1
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if not exist ".venv\Scripts\pythonw.exe" exit /b 1
if "%SILENT%"=="1" exit /b 0
echo.
echo Yazici PRO kuruldu. START_YAZICI_PRO.cmd dosyasini calistirin.
pause
