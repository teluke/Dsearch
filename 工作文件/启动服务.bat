@echo off
rem Double-click to start the local http server for LAN sync.
rem Keep this window open while syncing.
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\Nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\Nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
  )
)
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node.js, then run this again.
  pause
  exit /b 1
)

echo Starting server with: %NODE_EXE%
"%NODE_EXE%" server.js

echo.
echo Server stopped.
pause
