# RepoYeti system-tray host (Windows). Thin adapter over the shared Tray-Host engine
# (misc/Tray-Host.ps1). This file owns only what's genuinely app-specific: names,
# paths, the daemon start command, and a few documented behavior tweaks. Everything
# else -- mutex/tray lifecycle, watchdog, rebuild/restart worker, hide-tray live-sync,
# open path, full-shutdown sentinel -- lives in the shared engine.
#
# RepoYeti specifics worth knowing:
#  * Port comes from the --port CLI FLAG, not an env var — so PortEnvVar is $null
#    and {PORT} is substituted directly into StartCommand. It's the PREFERRED port:
#    if it's busy the daemon hops to the next free one and records where it landed
#    in ~/.repoyeti/runtime.json.
#  * Health check requires body.ok AND body.service -eq "repoyeti" (case-sensitive)
#    — the anti-collision check that stops the tray mistaking another app's server
#    on the same port for its own.
#  * Shutdown is pure force-kill (no HTTP token) — Stop-Daemon taskkills the port
#    owner by tree. Quit always sweeps the port.
#  * A stray daemon found at startup (mutex won, but something's already answering)
#    is ADOPTED — a tray is hosted for it, no second daemon is spawned.
#  * The daemon serves the BUILT PWA from web\dist and refuses to start with no scan
#    root configured — RepoYeti gets a domain-specific MessageBox for that case
#    (NoScanRootHint) with the exact `add-root` remediation command.
#  * "Rebuild & Restart" is always shown (no dev/distribution split for this app).
#  * Cold start can take up to 60s (large scan roots), well above the engine's
#    12-15s family default — pinned via StartupWaitSec/WorkerWaitSec.
param([int]$Port = 7171, [switch]$SelfTest)   # preferred port (matches config.ts DEFAULTS)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

# Runtime pointer / log dir the daemon writes to (honours REPOYETI_HOME, like the daemon does).
$repoyetiHome = if ($env:REPOYETI_HOME) { $env:REPOYETI_HOME } else { Join-Path $env:USERPROFILE ".repoyeti" }

$TrayConfig = @{
  ScriptDir           = $scriptDir
  Root                = $root
  DisplayName         = "RepoYeti"
  ServiceName         = "repoyeti"
  IconFile            = "RepoYeti.ico"
  Port                = $Port
  UrlHost             = "127.0.0.1"
  InfoFile            = Join-Path $repoyetiHome "runtime.json"
  DaemonLogPath       = Join-Path $repoyetiHome "logs\daemon.log"

  # --port is a CLI flag, not an env var — pin no port env var and substitute {PORT} directly.
  StartCommand        = "bun run src\index.ts start --port {PORT}"
  PortEnvVar          = $null
  EntryFile           = "src\index.ts"

  # First-run bootstrap: install deps (root + web) and build the PWA the daemon serves, each
  # gated on its own file-existence check so re-runs are cheap.
  FirstRun            = {
    param($appRoot)
    if (-not (Test-Path (Join-Path $appRoot "node_modules"))) {
      & cmd.exe /c "bun install" | Out-Null
    }
    if (-not (Test-Path (Join-Path $appRoot "web\node_modules"))) {
      & cmd.exe /c "cd /d web && bun install" | Out-Null
    }
    if (-not (Test-Path (Join-Path $appRoot "web\dist\index.html"))) {
      & cmd.exe /c "bun run --cwd web build:fast" | Out-Null
    }
  }

  RebuildCommand      = "bun run --cwd web build:fast"
  RebuildLogName      = "RepoYeti-Rebuild.log"
  IsDevTree           = $true   # always show "Rebuild & Restart" (no distribution split for this app)

  SentinelFile         = Join-Path $repoyetiHome "shutdown.request"
  ShutdownTokenEnvVar  = $null   # force-kill flavor — no HTTP shutdown token
  ShutdownHeaderPrefix = $null
  OnStrayDaemon        = "attach"

  SelfTestMarker      = "REPOYETI_TRAY_SELFTEST"
  MenuOpenLabel       = "Open RepoYeti"
  MutexName           = "RepoYetiTrayHost"

  # No scan root configured is RepoYeti's most likely "started but never served" cause —
  # surfaced via a domain-specific MessageBox with the exact remediation command.
  NoScanRootHint      = "RepoYeti started but isn't serving.`n`n" +
                        "The most likely cause is that no scan root is configured. " +
                        "Open a terminal in this folder and run:`n`n" +
                        "    bun run src\index.ts add-root <path-to-your-git-projects>`n`n" +
                        "then click RepoYeti again. (Other causes: a failed web build, or no free port.)"

  # RepoYeti's cold start can take up to a minute on a large scan root — well above the
  # engine's 12-15s family default.
  StartupWaitSec      = 60
  WorkerWaitSec       = 60
}

. (Join-Path $scriptDir "Tray-Host.ps1")

if ($SelfTest) {
  Invoke-TrayHostSelfTest $TrayConfig
} else {
  Start-TrayHost $TrayConfig
}
