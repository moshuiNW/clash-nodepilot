@echo off
chcp 65001 >nul
title clash-nodepilot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "node_modules\js-yaml" (
  echo   首次运行，正在安装依赖...
  rem Only the single runtime dependency. A bare "npm install" here would also
  rem remove devDependencies (e.g. playwright) and break the test suite;
  rem --no-save keeps package.json untouched as well.
  call npm install js-yaml --no-save --no-audit --no-fund
  if errorlevel 1 goto nodeps
)

node src\server.mjs --open
goto end

:nonode
echo.
echo   [错误] 未找到 Node.js。
echo   请先安装 Node.js 18 或更高版本: https://nodejs.org/
echo.
pause
exit /b 1

:nodeps
echo   [错误] 依赖安装失败，请检查网络。
pause
exit /b 1

:end
