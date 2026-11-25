@echo off
rem 双击启动带自签证书的本地服务。
rem 线上 https 页面要自动配对，必须用这个（http 会被浏览器按混合内容拦掉）。
rem 窗口保持开着，同步结束再关。
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 没找到 Node.js，先安装 Node.js 再运行。
  pause
  exit /b 1
)

node server.js --https

echo.
echo 服务已停止。
pause
