@echo off
:: Run this as Administrator to register a Windows Task Scheduler entry
:: The service will auto-start when you log into Windows each morning

title FleetGuard — Install Windows Task
color 0E
echo.
echo  Registering Windows Scheduled Task...
echo  (Requires Administrator — right-click and "Run as administrator")
echo.

set SERVICE_DIR=%~dp0
set NODE_EXE=node
set TASK_NAME=FleetGuard GVoice SMS

:: Remove old task if exists
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create new task: runs at logon for current user, starts in service dir
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%NODE_EXE%\" \"%SERVICE_DIR%src\index.js\"" ^
  /sc ONLOGON ^
  /delay 0001:00 ^
  /rl HIGHEST ^
  /f

if errorlevel 1 (
  echo.
  echo  [ERROR] Task creation failed.
  echo  Make sure you right-clicked and chose "Run as administrator".
  echo.
) else (
  echo.
  echo  [OK] Task "%TASK_NAME%" registered.
  echo  The service will start automatically 1 minute after you log in.
  echo.
  echo  To remove auto-start: run this command in an admin terminal:
  echo    schtasks /delete /tn "FleetGuard GVoice SMS" /f
  echo.
)
pause
