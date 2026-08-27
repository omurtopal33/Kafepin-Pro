@echo off
cd /d "%~dp0"
start "KafePin Client Yönetim PRO" /b py.exe -3 -B "%~dp0web_service.py"
