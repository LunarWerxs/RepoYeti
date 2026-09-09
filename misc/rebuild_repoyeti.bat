@echo off
REM Rebuilds the RepoYeti web UI (web\dist) that the daemon serves.
REM Standalone replacement for the tray's dev-only "Rebuild & Restart". Double-click to run.
cd /d "%~dp0.."
echo Building RepoYeti web UI (web\dist)...
call bun run --cwd web build:fast
if errorlevel 1 (
  echo Build FAILED - see the output above.
  REM Keep the window open on failure: this file is double-clicked, and a console that closes on
  REM its own takes the only diagnostics with it.
  pause
  exit /b 1
)

echo Done. Restart RepoYeti ^(tray: Restart^) to serve the new build.
exit /b 0
