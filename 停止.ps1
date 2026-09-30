# 停止 clash-nodepilot
#
# 关闭网页并不会结束后台进程 —— node 服务与它拉起的 mihomo 内核仍在运行。
# 本脚本用于在不打开网页的情况下把它们停掉。
#
# 用法:
#   .\停止.ps1            优雅关闭（优先走 HTTP 接口，会一并停掉内核）
#   .\停止.ps1 -Force     直接结束进程（HTTP 不通时使用）
#   .\停止.ps1 -Port 8791 指定端口

[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

function Stop-NodepilotProcesses {
    $stopped = 0

    # Our node server. Match the script path so the DSH harness and other node
    # processes are never touched.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -like '*server.mjs*' -and
        $_.CommandLine -notlike '*subprocess-local*' -and
        $_.CommandLine -notlike '*runner.js*'
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  已结束 node 服务 (PID $($_.ProcessId))" -ForegroundColor Yellow
        $stopped++
    }

    # The mihomo core we launched runs from our own temp dir. Only that one is
    # matched; your Clash Verge core must keep running.
    Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" | Where-Object {
        $_.CommandLine -like '*nodepilot*'
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  已结束 mihomo 内核 (PID $($_.ProcessId))" -ForegroundColor Yellow
        $stopped++
    }

    return $stopped
}

Write-Host "停止 clash-nodepilot..." -ForegroundColor Cyan

if (-not $Force) {
    $sent = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -TimeoutSec 5 | Out-Null
        $sent = $true
        Write-Host '  已发送关闭请求' -ForegroundColor Green
    } catch {
        Write-Host '  HTTP 接口无响应，改为直接结束进程' -ForegroundColor Yellow
    }

    if ($sent) {
        Start-Sleep -Seconds 3
    }
}

$n = Stop-NodepilotProcesses

if ($n -eq 0) {
    Write-Host '  没有正在运行的实例' -ForegroundColor Green
} else {
    Write-Host "  已清理 $n 个进程" -ForegroundColor Green
}

# Confirm the port is really free.
Start-Sleep -Milliseconds 500
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq $Port
if ($still) {
    Write-Host "  注意: 端口 $Port 仍被占用" -ForegroundColor Red
} else {
    Write-Host '  端口已释放，可以安全关闭网页' -ForegroundColor Green
}
