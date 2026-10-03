#!/usr/bin/env bash
# clash-nodepilot 停止脚本 (Linux)
#
# 用法:
#   ./stop.sh            优先走 HTTP 接口关闭；不行再兜底
#   ./stop.sh --force    跳过 HTTP，直接按 PID / 工作目录定位并结束
#
# 安全承诺：只结束本工具自己的进程。你的 Clash Verge / mihomo 内核不会被
# 触及——内核的定位依据是本工具独有的工作目录（PID 文件里记录），不是你
# 的订阅或系统里任何别的代理进程。
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 Node.js" >&2
  exit 1
fi

exec node src/core/stop.mjs "$@"
