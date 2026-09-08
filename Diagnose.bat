@echo off
title ACOM-Flex Bridge - Diagnostics
cd /d "%~dp0"
echo Collecting diagnostics (takes about 10 seconds)...
echo.
node diag.js
echo.
echo Report also saved as diagnostics.txt in this folder.
pause
