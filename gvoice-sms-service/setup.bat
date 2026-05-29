@echo off
title FleetGuard GVoice — Setup
color 0A
echo.
echo  ==========================================
echo   FleetGuard Google Voice SMS — Setup
echo  ==========================================
echo.

:: Check Node.js
node -v >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Node.js is not installed.
  echo.
  echo  Download and install from: https://nodejs.org
  echo  Choose the LTS version, run the installer, then run this setup again.
  echo.
  pause
  exit /b 1
)
echo  [OK] Node.js found:
node -v

:: Create .env from example if it doesn't exist
if not exist .env (
  copy .env.example .env >nul
  echo  [OK] .env file created from template
  echo.
  echo  *** ACTION REQUIRED ***
  echo  Open the .env file in Notepad and fill in:
  echo    GV_EMAIL          - your Google Voice Gmail address
  echo    GV_APP_PASSWORD   - your 16-char Google App Password
  echo    GV_SERVICE_SECRET - run this to generate one:
  echo      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  echo.
  echo  After filling .env, run setup.bat again.
  echo.
  start notepad .env
  pause
  exit /b 0
) else (
  echo  [OK] .env file already exists
)

:: Install npm dependencies
echo.
echo  Installing dependencies...
call npm install
if errorlevel 1 (
  echo  [ERROR] npm install failed. Check your internet connection.
  pause
  exit /b 1
)
echo  [OK] Dependencies installed

:: Install Playwright Chromium browser
echo.
echo  Installing Chromium browser for Playwright...
call npx playwright install chromium
if errorlevel 1 (
  echo  [ERROR] Playwright browser install failed.
  pause
  exit /b 1
)
echo  [OK] Chromium installed

echo.
echo  ==========================================
echo   Setup complete!
echo  ==========================================
echo.
echo  To start the service: double-click start.bat
echo.
echo  To auto-start with Windows: run install-task.bat as Administrator
echo.
pause
