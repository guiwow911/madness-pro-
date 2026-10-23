@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or later is required. Install Node.js, then run start.bat again.
  pause
  exit /b 1
)
node server.js
pause