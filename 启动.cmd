@echo off
chcp 65001 >nul
title clash-nodepilot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未找到 Node.js。
  echo   请先安装 Node.js 18 或更高版本: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\js-yaml" (
  echo   首次运行，正在安装依赖...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo   [错误] 依赖安装失败，请检查网络。
    pause
    exit /b 1
  )
)

node src\server.mjs --open
if errorlevel 1 pause
