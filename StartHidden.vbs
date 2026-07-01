' Runs the bridge invisibly in the background (no console window).
' To stop it: open the dashboard and use Settings -> Restart won't stop it;
' end "node.exe" in Task Manager, or use "Remove Autostart.bat" and reboot.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
' Restart loop lives in a hidden cmd so settings-restart works too.
sh.Run "cmd /c ""cd /d """ & here & """ && :loop & node bridge.js & timeout /t 2 /nobreak >nul & goto loop""", 0, False
