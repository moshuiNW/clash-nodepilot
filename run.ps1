# clash-nodepilot 启动脚本
#
# 用法:
#   .\run.ps1                  启动并自动打开浏览器
#   .\run.ps1 -NoBrowser       仅启动服务
#   .\run.ps1 -Port 9000       指定端口
#   .\run.ps1 -CorePath "D:\path\to\mihomo.exe"   指定内核

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [string]$CorePath = '',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 Node.js，请先安装 Node.js 18+ : https://nodejs.org/'
}

if (-not (Test-Path 'node_modules\js-yaml')) {
    Write-Host '首次运行，正在安装依赖...' -ForegroundColor Yellow
    # Install only the single runtime dependency. A bare `npm install` here
    # would also remove devDependencies (e.g. playwright), breaking the tests;
    # `--no-save` likewise keeps package.json untouched.
    npm install js-yaml --no-save --no-audit --no-fund
}

$env:NODEPILOT_PORT = $Port
if ($CorePath) { $env:NODEPILOT_CORE = $CorePath }

$args = @('src\server.mjs')
if (-not $NoBrowser) { $args += '--open' }

Write-Host "启动 clash-nodepilot (端口 $Port)..." -ForegroundColor Cyan
& node @args
