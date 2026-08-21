@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%~dp0"
set "LOGDIR=%ProgramData%\KafePinPro\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul
set "NODE="
if exist "%ROOT%node-path.txt" set /p NODE=<"%ROOT%node-path.txt"
if not defined NODE if exist "C:\KafePin\node\node.exe" set "NODE=C:\KafePin\node\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE (
  echo Yazici PRO gelir servisi icin node.exe bulunamadi.
  exit /b 23
)
if not exist "%ROOT%.venv\Scripts\python.exe" (
  echo Yazici PRO Python ortami bulunamadi: %ROOT%.venv\Scripts\python.exe
  exit /b 21
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $self=$PID; Get-CimInstance Win32_Process | ? { $c=[string]$_.CommandLine; $n=[string]$_.Name; ([int]$_.ProcessId -ne [int]$self) -and $c -and ((($n -ieq 'python.exe' -or $n -ieq 'pythonw.exe') -and $c.IndexOf('web_service.py',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.IndexOf('KafePinYaziciPRO',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'node.exe') -and $c.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'powershell.exe' -or $n -ieq 'pwsh.exe') -and $c.IndexOf('KafePin_YaziciPRO_WebView2.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0)) } | %% { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }" >nul 2>nul
timeout /t 1 /nobreak >nul
start "KafePin Yazici Gelir" /min "%NODE%" "%ROOT%KafePin_YaziciGelir_Service.js"
del /q "%LOGDIR%\v3155-webservice.out.log" "%LOGDIR%\v3155-webservice.err.log" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%ROOT%.venv\Scripts\python.exe' -ArgumentList @('%ROOT%web_service.py') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\v3155-webservice.out.log' -RedirectStandardError '%LOGDIR%\v3155-webservice.err.log'" >nul 2>nul
set "READY="
for /L %%I in (1,1,25) do (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try{$w=Invoke-RestMethod 'http://127.0.0.1:17891/api/health' -TimeoutSec 1;$r=Invoke-RestMethod 'http://127.0.0.1:17893/health' -TimeoutSec 1;if($w.ok -and $w.version -eq '3.1.55-candidate1' -and $r.ok -and $r.version -eq '3.1.55-candidate1'){exit 0}}catch{};exit 1" >nul 2>nul
  if not errorlevel 1 (set "READY=1"&goto :READY)
  timeout /t 1 /nobreak >nul
)
:READY
if not defined READY (
  echo Yazici PRO servisleri birlikte baslamadi. 17891/17893 kontrol edilmeli.
  exit /b 22
)
if /I "%~1"=="--service-only" exit /b 0
echo Yazici PRO servisleri hazir. Paneli KafePin Pro icindeki Yazici PRO dugmesinden acin.
exit /b 0
