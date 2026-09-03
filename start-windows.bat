@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Live Grid Monitor

echo ============================================
echo   Live Grid Monitor  -  多平台直播监控台
echo ============================================
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo.
  echo 请先安装 Node.js 22.5 或更高版本（推荐 LTS）：
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1" %%v in ('node -p "process.versions.node"') do set NODEV=%%v
for /f "tokens=1 delims=." %%m in ("%NODEV%") do set NODEMAJOR=%%m
echo [✓] Node.js %NODEV%
if %NODEMAJOR% LSS 22 (
  echo [!] 版本低于 22.5，数据库将改用 better-sqlite3 原生模块，
  echo     安装时可能需要 Visual Studio 生成工具。
  echo     建议升级到 Node.js 22.5+ 以避免编译问题：https://nodejs.org/
  echo.
)

rem ---------- 2. 安装依赖 ----------
if not exist "node_modules" (
  echo [1/3] 首次运行，正在安装依赖（约 1-3 分钟，含 ffmpeg 二进制下载）...
  call npm install
  if errorlevel 1 goto fail
) else (
  echo [1/3] 依赖已存在，跳过安装
)

rem ---------- 3. 构建前端 ----------
if not exist "web\dist" (
  echo [2/3] 正在构建前端...
  call npm run build
  if errorlevel 1 goto fail
) else (
  echo [2/3] 前端产物已存在，跳过构建
)

rem ---------- 4. 启动 ----------
echo [3/3] 启动服务...
echo.
echo   访问地址： http://localhost:8787
echo   停止服务： 在本窗口按 Ctrl+C
echo.
start "" http://localhost:8787
call npm start

echo.
echo 服务已停止。
pause
exit /b 0

:fail
echo.
echo [失败] 启动过程中出错，请查看上方错误信息。
pause
exit /b 1
