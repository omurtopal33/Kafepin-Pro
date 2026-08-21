@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%~dp0"
set "LOGDIR=%ProgramData%\KafePinPro\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>nul
set "NODE="
if exist "%ROOT%node-path.txt" set /p NODE=<"%ROOT%node-path.txt"
if not defined NODE if exist "C:\KafePin\node\node.exe" set "NODE=C:\KafePin\node\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%ROOT%.venv\Scripts\python.exe" (
  echo Yazici PRO Python ortami bulunamadi: %ROOT%.venv\Scripts\python.exe
  pause
  exit /b 21
)

rem Eski 3.1.52/3.1.54 runtime kalmasin. Bu sayede yeni endpointler gercekten devreye girer.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $self=$PID; Get-CimInstance Win32_Process | ? { $c=[string]$_.CommandLine; $n=[string]$_.Name; ([int]$_.ProcessId -ne [int]$self) -and $c -and ((($n -ieq 'python.exe' -or $n -ieq 'pythonw.exe') -and $c.IndexOf('web_service.py',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.IndexOf('KafePinYaziciPRO',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'node.exe') -and $c.IndexOf('KafePin_YaziciGelir_Service.js',[StringComparison]::OrdinalIgnoreCase) -ge 0) -or (($n -ieq 'powershell.exe' -or $n -ieq 'pwsh.exe') -and $c.IndexOf('KafePin_YaziciPRO_WebView2.ps1',[StringComparison]::OrdinalIgnoreCase) -ge 0)) } | %% { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }" >nul 2>nul
timeout /t 1 /nobreak >nul

if defined NODE if exist "%NODE%" (
  start "KafePin Yazici Gelir" /min "%NODE%" "%ROOT%KafePin_YaziciGelir_Service.js"
)
del /q "%LOGDIR%\v3154-webservice.out.log" "%LOGDIR%\v3154-webservice.err.log" >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%ROOT%.venv\Scripts\python.exe' -ArgumentList @('%ROOT%web_service.py') -WorkingDirectory '%ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%LOGDIR%\v3154-webservice.out.log' -RedirectStandardError '%LOGDIR%\v3154-webservice.err.log'" >nul 2>nul

set "READY="
for /L %%I in (1,1,20) do (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try{$j=Invoke-RestMethod 'http://127.0.0.1:17891/api/health' -TimeoutSec 1;if($j.ok -and $j.version -eq '3.1.54-candidate2'){exit 0}}catch{};exit 1" >nul 2>nul
  if not errorlevel 1 (
    set "READY=1"
    goto :WEBREADY
  )
  timeout /t 1 /nobreak >nul
)
:WEBREADY
if not defined READY (
  echo Yazici PRO 3.1.54 servisi baslamadi.
  echo Hata kaydi: %LOGDIR%\v3154-webservice.err.log
  if exist "%LOGDIR%\v3154-webservice.err.log" start "" notepad.exe "%LOGDIR%\v3154-webservice.err.log"
  pause
  exit /b 22
)

if exist "%ROOT%KafePin_YaziciPRO_WebView2.ps1" (
  start "KafePin Yazici PRO" powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%ROOT%KafePin_YaziciPRO_WebView2.ps1" -LocalUrl "http://127.0.0.1:17891/?v=3154candidate2"
) else (
  echo Yazici PRO WebView2 launcher bulunamadi.
  echo Dis tarayici acilmadi; kurulumu yeniden uygula.
  pause
  exit /b 31
)
exit /b 0
