# RepoYeti system-tray host (Windows). Runs the daemon with NO console window and
# shows a tray icon with Open / Rebuild & Restart / Restart / Quit. Launched via
# RepoYeti.vbs (which sets the port). The shortcut launches FAST with the existing
# web\dist build; use the tray's "Rebuild & Restart" to rebuild the UI from source
# and restart. This script lives in misc/, so the project root is one level up.
#
# RepoYeti specifics worth knowing:
#  * Port comes from the --port CLI FLAG, not an env var — so we pass it in
#    Start-RepoYeti. It's the PREFERRED port: if it's busy the daemon hops to the
#    next free one and records where it landed in ~/.repoyeti/runtime.json, which we
#    read (validated with an /api/health probe) so we open the URL it ACTUALLY bound.
#  * bun on Windows is an npm shim (bun.cmd), which CreateProcess can't run
#    directly, so we launch through `cmd.exe /c bun …` (taskkill /T later kills
#    the whole cmd→bun tree).
#  * The daemon serves the BUILT PWA from web\dist and refuses to start with no
#    scan root configured — both handled below (first-run build + readiness poll).
#
# Responsiveness: "Rebuild & Restart" and "Restart" do their slow work (bun build,
# stop, readiness poll — which can take a MINUTE on a large scan root) on a
# BACKGROUND runspace, and a WinForms timer marshals the result back to the UI
# thread, so the tray never freezes. Daemon control is stateless — it finds the live
# instance via the runtime pointer + /api/health and kills whatever owns the bound
# port — so it works on the UI thread and in the worker, and survives restarts.
param([int]$Port = 7171, [switch]$SelfTest)   # preferred port (matches config.ts DEFAULTS)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

function New-RepoYetiTrayIcon([string]$appScriptDir) {
  $icoPath = Join-Path $appScriptDir "RepoYeti.ico"
  if (-not (Test-Path $icoPath)) { throw "tray icon RepoYeti.ico missing" }

  $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
  if ($icoBytes.Length -le 6 -or $icoBytes[0] -ne 0 -or $icoBytes[1] -ne 0 -or $icoBytes[2] -ne 1 -or $icoBytes[3] -ne 0) {
    throw "tray icon RepoYeti.ico is not a valid .ico file"
  }
  $frameCount = [BitConverter]::ToUInt16($icoBytes, 4)
  $hasSmallFrame = $false
  for ($fi = 0; $fi -lt $frameCount; $fi++) {
    $fw = $icoBytes[6 + $fi*16]
    if ($fw -ne 0 -and $fw -le 48) { $hasSmallFrame = $true }
  }
  if (-not $hasSmallFrame) { throw "tray icon has no small (<=48px) frame; a 256-only icon renders blank" }

  # Hard startup gate: the shortcut may only drive the daemon once the real
  # notification-area icon exists. Do not fall back to a generic system icon.
  $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) -ErrorAction Stop
  $null = $ico.ToBitmap()
  $ni = New-Object System.Windows.Forms.NotifyIcon -ErrorAction Stop
  $ni.Text = "RepoYeti"
  $ni.Icon = $ico
  $ni.Visible = $true
  return $ni
}

function Close-RepoYetiTrayHost($activeTray) {
  if ($activeTray) {
    try { $activeTray.Visible = $false } catch {}
    try { $activeTray.Dispose() } catch {}
  }
  if ($script:trayMutex) {
    try { $script:trayMutex.ReleaseMutex() } catch {}
    try { $script:trayMutex.Dispose() } catch {}
    $script:trayMutex = $null
  }
}

# Headless self-test (tests/launcher.test.ts). Proves the tray can actually start —
# bun on PATH, the daemon entry exists, and the icon LOADS into a real NotifyIcon —
# then exits WITHOUT opening a browser or entering the message loop. A missing/corrupt
# icon (the classic "tray icon is broken") makes this exit non-zero.
if ($SelfTest) {
  $fail = @()
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { $fail += "bun not on PATH" }
  if (-not (Test-Path (Join-Path $root "src\index.ts")))     { $fail += "daemon entry src\index.ts missing" }
  try { Close-RepoYetiTrayHost (New-RepoYetiTrayIcon $scriptDir) }
  catch { $fail += "tray icon failed to load: $($_.Exception.Message)" }
  if ($fail.Count) { Write-Output ("REPOYETI_TRAY_SELFTEST_FAIL: " + ($fail -join "; ")); exit 1 }
  Write-Output "REPOYETI_TRAY_SELFTEST_OK"; exit 0
}
$port = $Port
# Runtime pointer the daemon writes (honours REPOYETI_HOME, like the daemon does).
$gmHome = if ($env:REPOYETI_HOME) { $env:REPOYETI_HOME } else { Join-Path $env:USERPROFILE ".repoyeti" }
$infoFile = Join-Path $gmHome "runtime.json"
# Where the daemon self-logs (see src/log-file.ts) — surfaced in the crash balloons so the
# user knows where to look when the watchdog reports a restart.
$logPath = Join-Path $gmHome "logs\daemon.log"
# Current live URL — refreshed whenever we (re)start the daemon, so the tray menu
# always opens wherever the daemon actually is now.
$script:url = "http://127.0.0.1:$port"

# Probe the usual Chromium install locations, most-preferred first (Edge is preinstalled on
# every supported Windows; Chrome may be absent). Mirrors src/portable-window.mjs's candidate
# order so the cold-start launcher and the running daemon agree on which browser to use.
function Resolve-ChromiumBrowser {
  $candidates = @()
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe")
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  }
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

# Open the app UI: a chromeless Chromium app window when Portable window is on (runtime.json,
# re-read fresh every call so a toggle flipped mid-run takes effect on the very next open) and a
# Chromium browser is installed; a normal tab otherwise. Never throws — worst case it falls back.
function Open-AppUi([string]$url) {
  $portable = $false
  try {
    if (Test-Path $infoFile) {
      $info = Get-Content $infoFile -Raw | ConvertFrom-Json
      if ($info.portableMode) { $portable = $true }
    }
  } catch { $portable = $false }

  if ($portable) {
    $browser = Resolve-ChromiumBrowser
    if ($browser) {
      # Dedicated profile (sibling of runtime.json) so the window remembers its own
      # size/position across launches — same family convention + path the daemon's
      # POST /api/portable-window uses, so both open paths share one profile.
      $profileDir = Join-Path (Split-Path -Parent $infoFile) "portable-profile"
      $profileOk = $true
      try {
        if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Force -Path $profileDir | Out-Null }
      } catch { $profileOk = $false }

      if ($profileOk) {
        Start-Process $browser -ArgumentList @("--user-data-dir=`"$profileDir`"", "--no-first-run", "--no-default-browser-check", "--app=$url")
      } else {
        # Profile dir couldn't be created — still open the window, just without geometry memory.
        Start-Process $browser -ArgumentList "--app=$url"
      }
      return
    }
  }
  Start-Process $url
}

# --- Daemon control ---------------------------------------------------------------
# Defined once as a scriptblock so the exact same functions run on the UI thread
# (launch, quit) AND inside the background worker runspace (rebuild, restart). All
# stateless: they locate the live instance via the runtime pointer + /api/health and
# act on the bound port, so nothing depends on WinForms or a shared Process handle.
$YetiControl = {
  # Is a RepoYeti daemon answering here? (/api/health is auth-exempt and reports
  # service:"repoyeti", so this won't mistake another app on the port for us.)
  function Test-RepoYeti($u) {
    if (-not $u) { return $false }
    try {
      $r = Invoke-RestMethod -Uri "$u/api/health" -TimeoutSec 1 -ErrorAction Stop
      return ($r.ok -eq $true -and $r.service -eq "repoyeti")
    } catch { return $false }
  }
  # The URL of a live RepoYeti instance (runtime pointer, else preferred port), or $null.
  function Get-RunningUrl($infoFile, $port) {
    if (Test-Path $infoFile) {
      try {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        if ($info.url -and (Test-RepoYeti $info.url)) { return $info.url }
      } catch { }
    }
    $u = "http://127.0.0.1:$port"
    if (Test-RepoYeti $u) { return $u }
    return $null
  }
  function Get-PortFromUrl($u) { try { return ([uri]$u).Port } catch { return 0 } }
  # PIDs LISTENING on a port (via netstat, always present). Plain `netstat -ano`
  # (no `-p tcp`) so IPv4 AND IPv6 listeners are both included.
  function Get-PortPids([int]$p) {
    $ids = @()
    try {
      foreach ($line in (& netstat -ano 2>$null)) {
        $t = $line.Trim()
        if ($t -notmatch 'LISTENING') { continue }
        $parts = $t -split '\s+'
        if ($parts.Length -ge 5 -and $parts[1] -match (':' + $p + '$') -and $parts[4] -match '^\d+$') { $ids += [int]$parts[4] }
      }
    } catch {}
    return ($ids | Select-Object -Unique)
  }
  # Kill the live daemon: force-kill whatever owns the bound port (from the runtime
  # pointer) and the preferred port, then wait for /api/health to stop answering.
  function Stop-RepoYeti($infoFile, $port) {
    $ports = @($port)
    $u = Get-RunningUrl $infoFile $port
    if ($u) { $pp = Get-PortFromUrl $u; if ($pp -gt 0) { $ports += $pp } }
    foreach ($pp in ($ports | Select-Object -Unique)) {
      foreach ($procId in (Get-PortPids $pp)) { if ($procId -gt 0) { & taskkill /PID $procId /T /F 2>$null | Out-Null } }
    }
    for ($i = 0; $i -lt 25; $i++) {
      if (-not (Get-RunningUrl $infoFile $port)) { return }
      Start-Sleep -Milliseconds 200
    }
  }
  # Launch the daemon (cmd→bun so taskkill /T can later reap the whole tree). --port
  # pins the PREFERRED port; the daemon hops past it if busy (and records where).
  function Start-RepoYeti($appRoot, $port) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c bun run src\index.ts start --port $port"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false                 # required so CreateNoWindow works
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    return [System.Diagnostics.Process]::Start($psi)
  }
  # Wait for the daemon to come up and return the URL it bound (validated via
  # /api/health). If a process handle is given, bail early when it exits before
  # serving — which for RepoYeti almost always means no scan root is configured.
  function Wait-ForUrl($infoFile, $port, $timeoutMs, $proc) {
    $elapsed = 0
    while ($elapsed -lt $timeoutMs) {
      $u = Get-RunningUrl $infoFile $port
      if ($u) { return $u }
      if ($proc -and $proc.HasExited) { return (Get-RunningUrl $infoFile $port) }
      Start-Sleep -Milliseconds 400; $elapsed += 400
    }
    return (Get-RunningUrl $infoFile $port)
  }
}
. $YetiControl   # make the functions available on the UI thread

# One tray host per desktop session. If it already exists, open the live UI and exit;
# otherwise keep this process alive as the tray host even when the daemon was already running.
$createdMutex = $false
$script:trayMutex = New-Object System.Threading.Mutex($true, "RepoYetiTrayHost", [ref]$createdMutex)
if (-not $createdMutex) {
  $u = Get-RunningUrl $infoFile $port
  if (-not $u) { $u = "http://127.0.0.1:$port" }
  Open-AppUi $u
  return
}

# If this shortcut invocation becomes the tray host, the notification-area icon must
# exist before we reuse or start the daemon. That prevents a headless shortcut launch.
try {
  $tray = New-RepoYetiTrayIcon $scriptDir
} catch {
  [System.Windows.Forms.MessageBox]::Show(
    "RepoYeti will not start because the notification-area icon could not be created.`n`n$($_.Exception.Message)",
    "RepoYeti"
  ) | Out-Null
  Close-RepoYetiTrayHost $null
  return
}

# Already running? Reuse it, but still show the tray icon from this host.
$existing = Get-RunningUrl $infoFile $port
if ($existing) {
  $script:url = $existing
} else {
  # Bun must be on PATH.
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    [System.Windows.Forms.MessageBox]::Show("Bun was not found on PATH.`nInstall it from https://bun.sh then click RepoYeti again.", "RepoYeti") | Out-Null
    Close-RepoYetiTrayHost $tray
    return
  }

  # First-run setup: install deps and build the PWA the daemon serves (web\dist).
  if (-not (Test-Path "node_modules")) {
    & cmd.exe /c "bun install" | Out-Null
  }
  if (-not (Test-Path (Join-Path "web" "node_modules"))) {
    & cmd.exe /c "cd /d web && bun install" | Out-Null
  }
  if (-not (Test-Path (Join-Path "web" (Join-Path "dist" "index.html")))) {
    & cmd.exe /c "bun run --cwd web build:fast" | Out-Null
  }

  # Startup launch (single-threaded, before the tray is shown). Uses the process handle
  # so we can fail fast with the "no scan root" hint instead of waiting the full poll.
  $startProc = Start-RepoYeti $root $port
  $script:url = Wait-ForUrl $infoFile $port 60000 $startProc
  if (-not $script:url) {
    Stop-RepoYeti $infoFile $port
    $msg = "RepoYeti started but isn't serving.`n`n" +
           "The most likely cause is that no scan root is configured. " +
           "Open a terminal in this folder and run:`n`n" +
           "    bun run src\index.ts add-root <path-to-your-git-projects>`n`n" +
           "then click RepoYeti again. (Other causes: a failed web build, or no free port.)"
    [System.Windows.Forms.MessageBox]::Show($msg, "RepoYeti") | Out-Null
    Close-RepoYetiTrayHost $tray
    return
  }
}

# --- Background worker ------------------------------------------------------------
# Rebuild (optional) + stop + start + wait, off the UI thread. Self-contained: it
# re-defines the daemon-control helpers from the passed-in text.
$worker = {
  param($appRoot, $appScriptDir, $infoFile, $appPort, $doRebuild, $helpersText, $shared)
  $ErrorActionPreference = 'SilentlyContinue'
  . ([scriptblock]::Create($helpersText))
  $result = [pscustomobject]@{ Ok = $true; Ready = $false; Url = $null }

  if ($doRebuild) {
    $logPath = Join-Path $appScriptDir "RepoYeti-Rebuild.log"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c cd /d `"$appRoot`" && bun run --cwd web build:fast > `"$logPath`" 2>&1"
    $psi.WorkingDirectory = $appRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = "Hidden"
    $p = [System.Diagnostics.Process]::Start($psi)
    $shared.buildPid = $p.Id
    # Poll HasExited (interruptible) instead of WaitForExit so a Quit can cancel
    # promptly and reap the build tree instead of the UI blocking on it.
    while (-not $p.HasExited) {
      if ($shared.cancel) { try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}; $result.Ok = $false; return $result }
      Start-Sleep -Milliseconds 200
    }
    $shared.buildPid = 0
    if ($p.ExitCode -ne 0) { $result.Ok = $false; return $result }
  }
  if ($shared.cancel) { return $result }

  Stop-RepoYeti $infoFile $appPort
  Start-Sleep -Milliseconds 300
  $proc = Start-RepoYeti $appRoot $appPort
  if ($proc) { $shared.serverPid = $proc.Id }   # so Quit can reap it even before it binds
  $u = Wait-ForUrl $infoFile $appPort 60000 $proc
  $result.Url = $u
  $result.Ready = [bool]$u
  return $result
}

$script:busy = $false
$script:ps = $null
$script:psAsync = $null
$script:jobKind = ''
# --- Auto-restart watchdog state --------------------------------------------------
# The daemon exits (code 1) on any uncaught exception — see src/index.ts — and nothing
# else brings it back. This host is the natural supervisor: a timer probes /api/health and
# relaunches a daemon that died on its own. Guards keep it from fighting deliberate stops:
#   · $intentionalStop — set during Quit so we never resurrect a daemon the user is closing.
#   · $script:busy      — a Rebuild/Restart worker owns the daemon; the watchdog stands down.
#   · reviveGraceUntil  — after firing a relaunch, wait for it to bind before trying again
#                         (a fresh daemon takes a few seconds), so we don't spawn a pile-up.
#   · crash-loop guard  — >= MAX restarts within WINDOW seconds ⇒ pause auto-restart and tell
#                         the user (a persistently-broken build must not spin forever; mirrors
#                         the daemon's own "never relaunch without a successor" caution).
$script:intentionalStop = $false
$script:autoRestartPaused = $false
$script:reviveGraceUntil = [DateTime]::MinValue
$script:restartTimes = New-Object System.Collections.Generic.List[DateTime]
$CrashLoopMax = 4       # restarts…
$CrashLoopWindowSec = 120  # …within this many seconds ⇒ pause
# Shared with the worker runspace (same process heap): the worker records the PIDs it
# spawns so Quit can reap them, and Quit sets `cancel` to stop the worker early.
$script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem    = New-Object System.Windows.Forms.ToolStripMenuItem("Open RepoYeti")
# --- DEV-ONLY: remove before public distribution ----------------------------------
# "Rebuild & Restart" rebuilds the PWA from SOURCE — a developer convenience so UI
# edits show up without a manual build. Public/end users get a prebuilt web\dist and
# have no source (or bun) to build with, so before you ship this publicly: delete
# $rebuildItem + its menu entry below and the rebuild branch in the worker above, and
# do your own rebuilds with the standalone misc\Rebuild.bat instead.
$rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild && Restart")
# ----------------------------------------------------------------------------------
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
$quitItem    = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")

# Ticks on the UI thread — polls the worker and, once it finishes, reports the
# outcome, updates the live URL, and re-enables the menu. Only place worker results
# touch the UI, so there's no cross-thread control access.
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 350
$pollTimer.Add_Tick({
  if (-not $script:ps -or -not $script:psAsync) { $pollTimer.Stop(); return }
  if (-not $script:psAsync.IsCompleted) { return }
  $pollTimer.Stop()
  $out = $null
  try {
    $res = $script:ps.EndInvoke($script:psAsync)
    if ($res -and $res.Count -gt 0) { $out = $res[$res.Count - 1] }
  } catch {}
  try { $script:ps.Dispose() } catch {}
  $script:ps = $null; $script:psAsync = $null

  if ($out -and -not $out.Ok) {
    $tray.ShowBalloonTip(3500, "RepoYeti", "Web build failed. See misc\RepoYeti-Rebuild.log.", [System.Windows.Forms.ToolTipIcon]::Error)
  } elseif ($out -and $out.Ready) {
    if ($out.Url) { $script:url = $out.Url }
    if ($script:jobKind -eq 'rebuild') { Open-AppUi $script:url }
  } else {
    $tray.ShowBalloonTip(3500, "RepoYeti", "Restarted, but RepoYeti isn't answering yet.", [System.Windows.Forms.ToolTipIcon]::Warning)
  }
  $rebuildItem.Enabled = $true
  $restartItem.Enabled = $true
  $script:busy = $false
})

function Start-Job-Async([bool]$doRebuild) {
  if ($script:busy) { return }
  $script:busy = $true
  $script:jobKind = if ($doRebuild) { 'rebuild' } else { 'restart' }
  # An explicit Restart/Rebuild is the user re-arming things: clear any crash-loop pause and
  # the restart history so the watchdog resumes cleanly once the worker hands the daemon back.
  $script:autoRestartPaused = $false
  $script:restartTimes.Clear()
  $rebuildItem.Enabled = $false
  $restartItem.Enabled = $false

  try {
    $script:shared = [hashtable]::Synchronized(@{ buildPid = 0; serverPid = 0; cancel = $false })
    $script:ps = [System.Management.Automation.PowerShell]::Create()
    [void]$script:ps.AddScript($worker.ToString())
    [void]$script:ps.AddArgument($root)
    [void]$script:ps.AddArgument($scriptDir)
    [void]$script:ps.AddArgument($infoFile)
    [void]$script:ps.AddArgument($port)
    [void]$script:ps.AddArgument($doRebuild)
    [void]$script:ps.AddArgument($YetiControl.ToString())
    [void]$script:ps.AddArgument($script:shared)
    $script:psAsync = $script:ps.BeginInvoke()
    $pollTimer.Start()
  } catch {
    # Kicking off the runspace failed — never leave the menu stuck disabled.
    if ($script:ps) { try { $script:ps.Dispose() } catch {} }
    $script:ps = $null; $script:psAsync = $null
    $rebuildItem.Enabled = $true
    $restartItem.Enabled = $true
    $script:busy = $false
    $tray.ShowBalloonTip(3500, "RepoYeti", "Couldn't start the background worker. Try again.", [System.Windows.Forms.ToolTipIcon]::Error)
  }
}

$openItem.Add_Click({ Open-AppUi $script:url })
$rebuildItem.Add_Click({ Start-Job-Async $true })
$restartItem.Add_Click({ Start-Job-Async $false })
$quitItem.Add_Click({
  # Tell the watchdog we're closing on purpose BEFORE we kill the daemon, so it doesn't
  # relaunch what we're about to stop.
  $script:intentionalStop = $true
  if ($healthTimer) { $healthTimer.Stop() }
  $script:shared.cancel = $true
  $pollTimer.Stop()
  # If a job is in flight, reap what the worker spawned (build + a daemon that may not
  # have bound the port yet) so nothing is orphaned and $script:ps.Stop() doesn't block
  # on the build's WaitForExit. When idle the tracked PIDs are stale (the live daemon is
  # killed by-port/url below) — skip so we never taskkill a reused PID.
  if ($script:busy) {
    foreach ($k in @('buildPid', 'serverPid')) {
      $procId = $script:shared[$k]
      if ($procId -and $procId -gt 0) { try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {} }
    }
  }
  if ($script:ps) { try { $script:ps.Stop(); $script:ps.Dispose() } catch {} }
  Stop-RepoYeti $infoFile $port
  Close-RepoYetiTrayHost $tray
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add($openItem) | Out-Null
$menu.Items.Add($rebuildItem) | Out-Null
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Open-AppUi $script:url })

# --- Auto-restart watchdog --------------------------------------------------------
# Ticks on the UI thread; each tick is cheap (one /api/health probe) and NEVER blocks —
# a relaunch is fire-and-forget (Start-RepoYeti returns as soon as it spawns), and recovery
# is observed on a later tick, so the tray stays responsive even while the daemon reboots.
$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 5000
$healthTimer.Add_Tick({
  # Deliberate close, or a Rebuild/Restart worker owns the daemon → stand down.
  if ($script:intentionalStop -or $script:busy) { return }

  $u = Get-RunningUrl $infoFile $port
  if ($u) { $script:url = $u; return }         # healthy (track where it actually bound)

  # Down. Wait out the grace window after a relaunch so a still-booting daemon isn't
  # double-spawned, and honour a crash-loop pause.
  if ((Get-Date) -lt $script:reviveGraceUntil) { return }
  if ($script:autoRestartPaused) { return }

  # Crash-loop guard: prune attempts outside the window, then bail if we've hit the cap.
  $cutoff = (Get-Date).AddSeconds(-$CrashLoopWindowSec)
  for ($i = $script:restartTimes.Count - 1; $i -ge 0; $i--) {
    if ($script:restartTimes[$i] -lt $cutoff) { $script:restartTimes.RemoveAt($i) }
  }
  if ($script:restartTimes.Count -ge $CrashLoopMax) {
    $script:autoRestartPaused = $true
    $tray.ShowBalloonTip(6000, "RepoYeti", "RepoYeti keeps crashing - auto-restart paused. See $logPath, then use Restart to try again.", [System.Windows.Forms.ToolTipIcon]::Error)
    return
  }

  # Relaunch (same path the tray uses everywhere else — cmd->bun so taskkill /T can reap it).
  $script:restartTimes.Add((Get-Date))
  $script:reviveGraceUntil = (Get-Date).AddSeconds(20)
  Start-RepoYeti $root $port | Out-Null
  $tray.ShowBalloonTip(4000, "RepoYeti", "RepoYeti stopped unexpectedly - restarting. Log: $logPath", [System.Windows.Forms.ToolTipIcon]::Warning)
})
$healthTimer.Start()

$tray.ShowBalloonTip(2500, "RepoYeti", "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
Open-AppUi $script:url
[System.Windows.Forms.Application]::Run()       # keeps the tray alive until Quit
