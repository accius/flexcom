@echo off
title ACOM-Flex Bridge - Enable autostart
cd /d "%~dp0"
schtasks /create /f /sc onlogon /tn "AcomFlexBridge" /tr "wscript.exe \"%~dp0StartHidden.vbs\"" /rl limited
if errorlevel 1 (
    echo Failed - try right-click "Run as administrator".
) else (
    echo Done. The bridge now starts silently in the background at every login.
    echo Dashboard: http://localhost:8990
)
pause
