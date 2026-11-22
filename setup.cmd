@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or newer from https://nodejs.org/ then run this file again.
  pause
  exit /b 1
)
call npm ci --ignore-scripts
if errorlevel 1 goto failed
call npm run browser:install
if errorlevel 1 goto failed
node src/cli.js setup
if errorlevel 1 goto failed
echo Setup complete. Double-click start.cmd to start the bridge.
pause
exit /b 0
:failed
echo Setup did not finish. Read the message above and README.md.
pause
exit /b 1
