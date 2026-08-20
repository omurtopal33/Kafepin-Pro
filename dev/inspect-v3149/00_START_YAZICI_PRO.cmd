@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  start "" /wait "%~dp0KURULUM.cmd"
)
start "Yazici PRO" /min "%~dp0.venv\Scripts\pythonw.exe" "%~dp0web_service.py"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:17891/"

