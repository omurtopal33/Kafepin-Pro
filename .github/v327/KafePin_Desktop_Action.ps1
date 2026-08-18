param(
  [string]$BridgeDir = 'C:\ProgramData\KafePinPro\DesktopBridge'
)

$ErrorActionPreference = 'Stop'
$requestFile = Join-Path $BridgeDir 'request.json'
$resultFile = Join-Path $BridgeDir 'result.json'

function Write-Result([string]$RequestId, [bool]$Ok, [bool]$Foreground, [long]$Hwnd, [string]$ErrorText) {
  try {
    New-Item -ItemType Directory -Force -Path $BridgeDir | Out-Null
    $payload = [ordered]@{
      requestId = $RequestId
      ok = $Ok
      foreground = $Foreground
      hwnd = $Hwnd
      sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
      error = $ErrorText
      completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $tmp = $resultFile + '.tmp'
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $resultFile -Force
  } catch {}
}

$requestId = ''
try {
  $desktopSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  if ([int]$desktopSessionId -le 0) { throw 'Masaüstü yardımcısı interaktif kullanıcı oturumunda çalışmıyor.' }
  if (-not (Test-Path -LiteralPath $requestFile -PathType Leaf)) { throw 'Masaüstü isteği bulunamadı.' }
  $request = Get-Content -LiteralPath $requestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $requestId = [string]$request.requestId
  $target = [string]$request.folder
  if (-not $requestId) { throw 'İstek kimliği boş.' }
  if (-not $target) { throw 'Klasör yolu boş.' }
  $target = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw ('Klasör bulunamadı: ' + $target) }

  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KafePinDesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
}
'@

  function Normalize-Path([string]$Value) {
    try { return [System.IO.Path]::GetFullPath($Value).TrimEnd('\') } catch { return '' }
  }

  function Find-Window([string]$Wanted) {
    try {
      $shell = New-Object -ComObject Shell.Application
      foreach ($window in @($shell.Windows())) {
        try {
          if (-not $window.HWND) { continue }
          $url = [string]$window.LocationURL
          if (-not $url.StartsWith('file:', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
          $candidate = Normalize-Path ([System.Uri]::UnescapeDataString(([System.Uri]$url).LocalPath))
          if ($candidate -ieq $Wanted) { return $window }
        } catch {}
      }
    } catch {}
    return $null
  }

  function Force-Foreground([IntPtr]$Hwnd) {
    [KafePinDesktopNative]::ShowWindowAsync($Hwnd, 9) | Out-Null
    try {
      $wshell = New-Object -ComObject WScript.Shell
      $wshell.SendKeys('%')
    } catch {}
    try {
      [KafePinDesktopNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [KafePinDesktopNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    } catch {}
    [KafePinDesktopNative]::SwitchToThisWindow($Hwnd, $true)
    $flags = 0x0001 -bor 0x0002 -bor 0x0040
    [KafePinDesktopNative]::SetWindowPos($Hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags) | Out-Null
    Start-Sleep -Milliseconds 40
    [KafePinDesktopNative]::SetWindowPos($Hwnd, [IntPtr](-2), 0, 0, 0, 0, $flags) | Out-Null
    [KafePinDesktopNative]::BringWindowToTop($Hwnd) | Out-Null
    [KafePinDesktopNative]::SetActiveWindow($Hwnd) | Out-Null
    [KafePinDesktopNative]::SetForegroundWindow($Hwnd) | Out-Null
  }

  $window = Find-Window $target
  if (-not $window) {
    # Bu script interaktif kullanıcının gerçek masaüstü oturumunda çalışır.
    # Shell.Application ile açmak Explorer'ın aynı kullanıcı oturumunda açılmasını sağlar.
    try {
      $shell = New-Object -ComObject Shell.Application
      $shell.Open($target)
    } catch {
      Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') -ArgumentList @($target) | Out-Null
    }
  }

  $deadline = (Get-Date).AddSeconds(5)
  $hwnd = [IntPtr]::Zero
  do {
    $window = Find-Window $target
    if ($window) {
      $hwnd = [IntPtr]([Int64]$window.HWND)
      for ($i=0; $i -lt 4; $i++) {
        Force-Foreground $hwnd
        Start-Sleep -Milliseconds 110
        if ([KafePinDesktopNative]::GetForegroundWindow() -eq $hwnd) {
          Write-Result $requestId $true $true ([Int64]$hwnd) ''
          exit 0
        }
      }
    }
    Start-Sleep -Milliseconds 140
  } while ((Get-Date) -lt $deadline)

  # Son güvenli deneme: klasörü tekrar Shell üzerinden çağır; ardından bulunan HWND'yi üstte tut.
  try {
    $shell = New-Object -ComObject Shell.Application
    $shell.Open($target)
  } catch {}
  Start-Sleep -Milliseconds 350
  $window = Find-Window $target
  if ($window) {
    $hwnd = [IntPtr]([Int64]$window.HWND)
    Force-Foreground $hwnd
    Start-Sleep -Milliseconds 180
    if ([KafePinDesktopNative]::GetForegroundWindow() -eq $hwnd) {
      Write-Result $requestId $true $true ([Int64]$hwnd) ''
      exit 0
    }
  }

  throw 'Explorer penceresi kullanıcı masaüstünde öne alınamadı.'
} catch {
  Write-Result $requestId $false $false 0 ([string]$_.Exception.Message)
  exit 31
}
