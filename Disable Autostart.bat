@echo off
title ACOM-Flex Bridge - Disable autostart
schtasks /delete /f /tn "AcomFlexBridge"
echo Autostart removed. If the bridge is running now, end node.exe in Task Manager or reboot.
pause
