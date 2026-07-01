@echo off
title ACOM-Flex Bridge
cd /d "%~dp0"
start "" http://localhost:8990
:loop
node bridge.js
echo.
echo Bridge stopped (restart from settings, or crash) - restarting in 2s...
echo Close this window to stop the bridge completely.
timeout /t 2 /nobreak >nul
goto loop
