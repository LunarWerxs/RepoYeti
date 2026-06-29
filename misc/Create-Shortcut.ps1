# Creates / refreshes the "RepoYeti" shortcut in the project root, pointing at
# misc\RepoYeti.vbs and carrying the icon. Re-run after moving/renaming the folder
# (.lnk files store ABSOLUTE paths) or after regenerating the icon.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition   # ...\misc
$root = Split-Path -Parent $scriptDir
$lnk = Join-Path $root "RepoYeti.lnk"

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
# Run the .vbs through wscript explicitly: no console, no file-association surprises.
$sc.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$sc.Arguments  = '"' + (Join-Path $scriptDir "RepoYeti.vbs") + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = (Join-Path $scriptDir "RepoYeti.ico") + ",0"
$sc.Description = "Launch RepoYeti (system tray)"
$sc.Save()
Write-Host "Created shortcut: $lnk"
