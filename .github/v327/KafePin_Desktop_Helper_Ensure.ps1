param(
  [string]$InstallRoot = 'C:\KafePin'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'KafePin Pro Desktop Action'
$ActionScript = Join-Path $InstallRoot 'KafePin_Desktop_Action.ps1'
$programDataRoot = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
$BridgeDir = Join-Path $programDataRoot 'KafePinPro\DesktopBridge'

function Get-InteractiveUser {
  try {
    $u = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
    if ($u) { return $u }
  } catch {}
  try {
    $items = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | Sort-Object SessionId -Descending
    foreach ($p in $items) {
      if ([int]$p.SessionId -le 0) { continue }
      try {
        $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop
        if ($owner.User) {
          if ($owner.Domain) { return ([string]$owner.Domain + '\' + [string]$owner.User) }
          return [string]$owner.User
        }
      } catch {}
    }
  } catch {}
  return ''
}

if (-not (Test-Path -LiteralPath $ActionScript -PathType Leaf)) {
  throw ('Masaüstü yardımcısı bulunamadı: ' + $ActionScript)
}

$user = Get-InteractiveUser
if (-not $user) { throw 'Aktif Windows masaüstü kullanıcısı bulunamadı.' }
New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null

# Yalnız bu küçük bridge klasöründe interaktif kullanıcıya Modify verilir.
try {
  $acl = Get-Acl -LiteralPath $BridgeDir
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $BridgeDir -AclObject $acl
} catch {
  throw ('Masaüstü bridge izinleri ayarlanamadı: ' + $_.Exception.Message)
}

$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$root = $service.GetFolder('\')
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'KafePin Pro klasör açma işlemlerini gerçek interaktif Windows masaüstü oturumunda çalıştırır.'
$definition.Settings.Enabled = $true
$definition.Settings.AllowDemandStart = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.Hidden = $true
$definition.Settings.ExecutionTimeLimit = 'PT1M'
$definition.Settings.MultipleInstances = 3 # TASK_INSTANCES_STOP_EXISTING
$definition.Principal.UserId = $user
$definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
$definition.Principal.RunLevel = 0 # least privilege; Explorer aynı kullanıcı oturumunda çalışır

$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ActionScript + '" -BridgeDir "' + $BridgeDir + '"'
$action.WorkingDirectory = $InstallRoot

# TASK_CREATE_OR_UPDATE=6, TASK_LOGON_INTERACTIVE_TOKEN=3. Parola gerekmez;
# aktif kullanıcının mevcut interaktif tokenı kullanılır.
$null = $root.RegisterTaskDefinition($TaskName, $definition, 6, $user, $null, 3, $null)

# Kaydın gerçekten doğru kullanıcıya bağlı olduğunu doğrula.
$registered = $root.GetTask($TaskName)
if (-not $registered) { throw 'Masaüstü görevi kaydedilemedi.' }
Write-Output ('READY|' + $user)
exit 0
