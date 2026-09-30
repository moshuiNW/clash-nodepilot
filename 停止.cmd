@echo off
chcp 65001 >nul
title 停止 clash-nodepilot
cd /d "%~dp0"

echo.
echo  停止 clash-nodepilot...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0停止.ps1"
if errorlevel 1 goto failed

echo.
pause
goto :eof

:failed
echo.
echo  如仍无法停止，可尝试结束 node.exe 进程（注意别误关其他程序）。
echo.
pause
