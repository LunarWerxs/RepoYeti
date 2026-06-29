' Launches RepoYeti into the system tray (no console window).
' Use the "RepoYeti" shortcut in the project root, or double-click this file.

' -- Web UI port -------------------------------------------------
Const PORT = 7171                              ' the port (matches config.ts DEFAULTS)
' ----------------------------------------------------------------

Dim sh, fso, scriptDir, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\misc
root = fso.GetParentFolderName(scriptDir)                     ' project root
sh.CurrentDirectory = root
' 0 = hidden window (no console flash), False = don't wait.
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\RepoYeti-Tray.ps1"" -Port " & PORT, 0, False
