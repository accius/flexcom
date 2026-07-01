@echo off
title ACOM-Flex Bridge - Install
echo.
echo  ACOM-Flex Bridge - one-time setup
echo  ---------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  Node.js is not installed.
    echo  Opening the download page - install the LTS version, then run this again.
    start https://nodejs.org/
    pause
    exit /b 1
)

echo  Installing dependencies (this takes a minute)...
cd /d "%~dp0"
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo  Install failed - see errors above.
    pause
    exit /b 1
)

echo.
echo  Done! Double-click "Start Bridge.bat" to run it.
echo  The dashboard will open in your browser - click the gear icon
echo  to pick your COM ports and radio, then Save and Restart.
echo.
pause
