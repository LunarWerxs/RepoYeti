# RepoYeti system-tray host (Windows). Runs the daemon with NO console window and
# shows a tray icon with Open / Rebuild & Restart / Restart / Quit. Launched via
# RepoYeti.vbs (which sets the port). The shortcut launches FAST with the existing
# web\dist build; use the tray's "Rebuild & Restart" to rebuild the UI from source
# and restart. This script lives in misc/, so the project root is one level up.
#
# RepoYeti specifics worth knowing:
#  * Port comes from the --port CLI FLAG, not an env var — so we pass it in
#    Start-App. It's the PREFERRED port: if it's busy the daemon hops to the next
#    free one and records where it landed in ~/.repoyeti/runtime.json, which we read
#    (validated with an /api/health probe) so we open the URL it ACTUALLY bound.
#  * bun on Windows is an npm shim (bun.cmd), which CreateProcess can't run
#    directly, so we launch through `cmd.exe /c bun …` (taskkill /T later kills
#    the whole cmd→bun tree).
#  * The daemon serves the BUILT PWA from web\dist and refuses to start with no
#    scan root configured — both handled below (first-run build + readiness poll).
param([int]$Port = 7171, [switch]$SelfTest)   # preferred port (matches config.ts DEFAULTS)
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

# Headless self-test (tests/launcher.test.ts). Proves the tray can actually start —
# bun on PATH, the daemon entry exists, and the icon LOADS into a real NotifyIcon —
# then exits WITHOUT opening a browser or entering the message loop. A missing/corrupt
# icon (the classic "tray icon is broken") makes this exit non-zero.
if ($SelfTest) {
  $fail = @()
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { $fail += "bun not on PATH" }
  if (-not (Test-Path (Join-Path $root "src\index.ts")))     { $fail += "daemon entry src\index.ts missing" }
  $icoPath = Join-Path $scriptDir "RepoYeti.ico"
  if (-not (Test-Path $icoPath)) {
    $fail += "tray icon RepoYeti.ico missing"
  } else {
    try {
      # Load the TRAY-sized frame (not the 256 jumbo) and force a decode — this catches a
      # 256-only icon, which renders blank in the tray (the classic "tray icon is broken").
      $ico = New-Object System.Drawing.Icon($icoPath, [System.Windows.Forms.SystemInformation]::SmallIconSize)
      $null = $ico.ToBitmap()                            # forces decode of the chosen frame
      $ni  = New-Object System.Windows.Forms.NotifyIcon  # the actual tray-icon object
      $ni.Icon = $ico                                    # must accept the icon
      $ni.Dispose(); $ico.Dispose()
      # The tray needs a small frame; a 256-only .ico has none. Require one (<=48px).
      $icoBytes = [System.IO.File]::ReadAllBytes($icoPath)
      $frameCount = [BitConverter]::ToUInt16($icoBytes, 4); $hasSmallFrame = $false
      for ($fi = 0; $fi -lt $frameCount; $fi++) { $fw = $icoBytes[6 + $fi*16]; if ($fw -ne 0 -and $fw -le 48) { $hasSmallFrame = $true } }
      if (-not $hasSmallFrame) { $fail += "tray icon has no small (<=48px) frame; a 256-only icon renders blank" }
    } catch { $fail += "tray icon failed to load: $($_.Exception.Message)" }
  }
  if ($fail.Count) { Write-Output ("REPOYETI_TRAY_SELFTEST_FAIL: " + ($fail -join "; ")); exit 1 }
  Write-Output "REPOYETI_TRAY_SELFTEST_OK"; exit 0
}
$port = $Port
# Runtime pointer the daemon writes (honours REPOYETI_HOME, like the daemon does).
$gmHome = if ($env:REPOYETI_HOME) { $env:REPOYETI_HOME } else { Join-Path $env:USERPROFILE ".repoyeti" }
$infoFile = Join-Path $gmHome "runtime.json"
# Current live URL — refreshed whenever we (re)start the daemon, so the tray menu
# always opens wherever the daemon actually is now.
$script:url = "http://127.0.0.1:$port"

# Is a RepoYeti daemon answering at this URL? (/api/health is auth-exempt, and reports
# service:"repoyeti" — so this won't mistake some other app on the port for us.)
function Test-RepoYeti($u) {
  if (-not $u) { return $false }
  try {
    $r = Invoke-RestMethod -Uri "$u/api/health" -TimeoutSec 1 -ErrorAction Stop
    return ($r.ok -eq $true -and $r.service -eq "repoyeti")
  } catch { return $false }
}

# The URL of a live RepoYeti instance (from the runtime pointer, else the preferred
# port), or $null if none is actually answering.
function Get-RunningUrl {
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

# Already running? Just open the live UI and exit (no second instance).
$existing = Get-RunningUrl
if ($existing) { Start-Process $existing; return }

# Bun must be on PATH.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  [System.Windows.Forms.MessageBox]::Show("Bun was not found on PATH.`nInstall it from https://bun.sh then click RepoYeti again.", "RepoYeti") | Out-Null
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

$script:proc = $null
function Start-App {
  if ($script:proc -and -not $script:proc.HasExited) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName  = "cmd.exe"
  # --port pins the PREFERRED port; the daemon hops past it if busy (and records where).
  $psi.Arguments = "/c bun run src\index.ts start --port $port"
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false                 # required so CreateNoWindow works
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = "Hidden"
  $script:proc = [System.Diagnostics.Process]::Start($psi)
}
function Stop-App {
  if ($script:proc -and -not $script:proc.HasExited) {
    & taskkill /PID $script:proc.Id /T /F 2>$null | Out-Null   # /T kills cmd→bun tree
  }
  $script:proc = $null
}
function Rebuild-Ui {
  # Rebuild web\dist from source (the daemon serves it as static files). The
  # "Rebuild & Restart" handler restarts the daemon afterward for a clean reload.
  & cmd.exe /c "bun run --cwd web build:fast" | Out-Null
}

# Wait for the daemon we just started to come up and return the URL it bound (read
# from the runtime pointer, validated by /api/health). The daemon serves as soon as
# it binds, but a large scan root delays the initial hydration, so allow generous
# time. If the process EXITS before serving, that almost always means no scan root
# is configured — return whatever's running (usually nothing) so the caller can warn.
function Wait-ForUrl([int]$timeoutMs = 60000) {
  $elapsed = 0
  while ($elapsed -lt $timeoutMs) {
    $u = Get-RunningUrl
    if ($u) { return $u }
    if ($script:proc -and $script:proc.HasExited) { return Get-RunningUrl }  # one last look
    Start-Sleep -Milliseconds 400; $elapsed += 400
  }
  return Get-RunningUrl
}

Start-App
$script:url = Wait-ForUrl
if (-not $script:url) {
  Stop-App
  $msg = "RepoYeti started but isn't serving.`n`n" +
         "The most likely cause is that no scan root is configured. " +
         "Open a terminal in this folder and run:`n`n" +
         "    bun run src\index.ts add-root <path-to-your-git-projects>`n`n" +
         "then click RepoYeti again. (Other causes: a failed web build, or no free port.)"
  [System.Windows.Forms.MessageBox]::Show($msg, "RepoYeti") | Out-Null
  return
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = "RepoYeti"
$iconPath = Join-Path $scriptDir "RepoYeti.ico"
# Pull the TRAY-sized frame from the multi-size .ico so it renders crisply (not blank).
# Fall back to the default frame, then a system icon, if anything goes wrong.
$tray.Icon = if (Test-Path $iconPath) {
  try { New-Object System.Drawing.Icon($iconPath, [System.Windows.Forms.SystemInformation]::SmallIconSize) }
  catch { try { New-Object System.Drawing.Icon($iconPath) } catch { [System.Drawing.SystemIcons]::Application } }
} else { [System.Drawing.SystemIcons]::Application }
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem    = New-Object System.Windows.Forms.ToolStripMenuItem("Open RepoYeti")
# --- DEV-ONLY: remove before public distribution ----------------------------------
# "Rebuild & Restart" rebuilds the PWA from SOURCE — a developer convenience so UI
# edits show up without a manual build. Public/end users get a prebuilt web\dist and
# have no source (or bun) to build with, so before you ship this publicly: delete
# $rebuildItem + its menu entry below and the Rebuild-Ui function above, and do your
# own rebuilds with the standalone misc\Rebuild.bat instead.
$rebuildItem = New-Object System.Windows.Forms.ToolStripMenuItem("Rebuild && Restart")
# ----------------------------------------------------------------------------------
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Restart")
$quitItem    = New-Object System.Windows.Forms.ToolStripMenuItem("Quit")
$openItem.Add_Click({ Start-Process $script:url })
$rebuildItem.Add_Click({
  $tray.ShowBalloonTip(1500, "RepoYeti", "Rebuilding the web UI and restarting...", [System.Windows.Forms.ToolTipIcon]::Info)
  Rebuild-Ui
  Stop-App; Start-Sleep -Milliseconds 400; Start-App
  $u = Wait-ForUrl; if ($u) { $script:url = $u }
  $tray.ShowBalloonTip(2500, "RepoYeti", "UI rebuilt - daemon restarted. Refresh your browser (Ctrl+R).", [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Process $script:url
})
$restartItem.Add_Click({ Stop-App; Start-Sleep -Milliseconds 600; Start-App; $u = Wait-ForUrl; if ($u) { $script:url = $u } })
$quitItem.Add_Click({ Stop-App; $tray.Visible = $false; $tray.Dispose(); [System.Windows.Forms.Application]::Exit() })
$menu.Items.Add($openItem) | Out-Null
$menu.Items.Add($rebuildItem) | Out-Null
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$tray.ContextMenuStrip = $menu
$tray.Add_MouseDoubleClick({ Start-Process $script:url })

$tray.ShowBalloonTip(2500, "RepoYeti", "Running in the tray - right-click for options.", [System.Windows.Forms.ToolTipIcon]::Info)
Start-Process $script:url
[System.Windows.Forms.Application]::Run()       # keeps the tray alive until Quit
