@echo off
title FleetGuard GVoice SMS Service
color 0A
echo.
echo  ==========================================
echo   FleetGuard Google Voice SMS Service
echo  ==========================================
echo.
echo  Starting... Google Voice will open in a browser window.
echo  Do NOT close that browser window — the bot needs it.
echo  To stop the service, press Ctrl+C in this window.
echo.

cd /d "%~dp0"
node src/index.js

echo.
echo  Service stopped.
pause
