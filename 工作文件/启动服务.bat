@echo off
rem Double-click to start the local server for LAN sync.
rem Keep this window open while syncing.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js first, then run this again.
  pause
  exit /b 1
)

node server.js

echo.
echo Server stopped.
pause
