param([Parameter(Mandatory=$true)][string]$Folder)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KafePinWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$target = (Resolve-Path -LiteralPath $Folder).Path.TrimEnd('\')
Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target + '"')

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 180
  $shell = New-Object -ComObject Shell.Application
  foreach ($window in @($shell.Windows())) {
    try {
      if (-not $window.LocationURL) { continue }
      $path = ([uri]$window.LocationURL).LocalPath.TrimEnd('\')
      if (-not [string]::Equals($path, $target, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $handle = [IntPtr]$window.HWND
      [KafePinWindow]::ShowWindow($handle, 9) | Out-Null
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.AppActivate([int]$window.HWND) | Out-Null
      $wshell.SendKeys('%')
      Start-Sleep -Milliseconds 80
      if ([KafePinWindow]::SetForegroundWindow($handle)) { Write-Output 'FOREGROUND_OK' } else { Write-Output 'OPENED_BACKGROUND' }
      exit 0
    } catch {}
  }
}
Write-Output 'OPENED_BACKGROUND'
