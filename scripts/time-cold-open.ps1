<#
.SYNOPSIS
  Times how long a folder window takes to open, for Explorer or Trove (plan 21 gap 6).

.DESCRIPTION
  Explorer: starts `explorer.exe <Folder>` and polls the Shell.Application window list until a
  NEW window shows that folder with its items readable. The number is "command sent -> folder
  window listing", by stopwatch.

  Trove: starts the exe and waits for the line Trove writes itself,
  "startup: first <view> painted <N> ms after starting", in trove.log. It prints both the
  stopwatch time (launch -> line seen) and Trove's own N.

  COLD means the first open after sign-in (Explorer) or with no Trove process running (Trove).
  This script does NOT kill explorer.exe: that takes the taskbar down. For Explorer's cold
  number, sign in fresh, run it once, and keep only the first run; later runs are warm.
  Close the window it opened between runs.

.EXAMPLE
  pwsh scripts/time-cold-open.ps1 -App explorer -Folder C:\trove-test -Runs 1
  pwsh scripts/time-cold-open.ps1 -App trove -Exe <path to the installed Trove.exe> -Runs 5
#>
param(
  [ValidateSet('explorer', 'trove')][string]$App = 'explorer',
  [string]$Folder = $env:USERPROFILE,
  # the installed Trove.exe; no default, the install folder differs per installer
  [string]$Exe = '',
  [int]$Runs = 1,
  [int]$TimeoutMs = 30000
)
$ErrorActionPreference = 'Stop'

function Time-Explorer([string]$folder) {
  $shell = New-Object -ComObject Shell.Application
  $before = @($shell.Windows() | ForEach-Object { $_.HWND })
  $want = (Resolve-Path $folder).Path.TrimEnd('\')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Process explorer.exe -ArgumentList "`"$want`""
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    foreach ($w in @($shell.Windows())) {
      if ($before -contains $w.HWND) { continue }
      try {
        $path = $w.Document.Folder.Self.Path
        $count = $w.Document.Folder.Items().Count
      } catch { continue }
      if ($path -and $path.TrimEnd('\') -eq $want) {
        return [pscustomobject]@{ app = 'explorer'; stopwatchMs = $sw.ElapsedMilliseconds; ownMs = $null; items = $count }
      }
    }
    Start-Sleep -Milliseconds 10
  }
  throw "explorer: no new window on $want within $TimeoutMs ms"
}

function Time-Trove([string]$exe) {
  if (-not $exe -or -not (Test-Path $exe)) { throw "trove: pass -Exe <path to Trove.exe> (got '$exe')" }
  if (Get-Process trove -ErrorAction SilentlyContinue) {
    throw 'trove is already running: a second launch hands over to it and is not a cold start'
  }
  $log = Join-Path $env:LOCALAPPDATA 'com.joyahmed.trove\logs\trove.log'
  $skip = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process $exe -PassThru
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    if (Test-Path $log) {
      $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
      try {
        # the log rolls at 4 MB: a shorter file is a new one, read from its start
        if ($fs.Length -ge $skip) { [void]$fs.Seek($skip, 'Begin') }
        $tail = (New-Object IO.StreamReader($fs)).ReadToEnd()
      } finally { $fs.Dispose() }
      $m = [regex]::Match($tail, 'startup: first (\S+) painted (\d+) ms after starting \((\d+) rows\)')
      if ($m.Success) {
        $ms = $sw.ElapsedMilliseconds
        return [pscustomobject]@{ app = "trove ($($m.Groups[1].Value))"; stopwatchMs = $ms; ownMs = [int]$m.Groups[2].Value; items = [int]$m.Groups[3].Value; pid = $proc.Id }
      }
    }
    Start-Sleep -Milliseconds 10
  }
  throw "trove: no 'startup: first ... painted' line within $TimeoutMs ms (started hidden? see use-first-paint)"
}

$results = for ($i = 1; $i -le $Runs; $i++) {
  if ($App -eq 'explorer') { Time-Explorer $Folder } else {
    $r = Time-Trove $Exe
    Stop-Process -Id $r.pid -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    $r
  }
  if ($App -eq 'explorer' -and $i -lt $Runs) {
    Read-Host 'Close the Explorer window it opened, then press Enter' | Out-Null
  }
}
$results | Format-Table app, stopwatchMs, ownMs, items -AutoSize
