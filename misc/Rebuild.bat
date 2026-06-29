@echo off
REM Rebuilds the RepoYeti web UI (web\dist) that the daemon serves.
REM Standalone replacement for the tray's dev-only "Rebuild & Restart" — keep this
REM after you remove that menu item for public distribution. Double-click to run.
cd /d "%~dp0.."
echo Building RepoYeti web UI (web\dist)...
call bun run --cwd web build:fast
echo.
if errorlevel 1 (
  echo Build FAILED — see the output above.
) else (
  echo Done. Restart RepoYeti ^(tray: Restart^) to serve the new build.
)
pause
