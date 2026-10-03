#!/usr/bin/env bash
# clash-nodepilot 启动脚本 (Linux)
#
# 用法:
#   ./start.sh                启动并自动打开浏览器
#   ./start.sh --no-open      仅启动服务
#   ./start.sh --port 9000    指定端口
#   ./start.sh --core <path>  指定 mihomo 内核
#
# 与 Windows 的 run.ps1 行为对齐：只按需安装运行时依赖 js-yaml，绝不执行
# 裸 `npm install`（那会连带删除 playwright 等 devDependencies，弄坏测试）。
set -euo pipefail

PORT="${NODEPILOT_PORT:-8765}"
CORE_PATH=""
OPEN_BROWSER=1
LOG_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --core) CORE_PATH="${2:-}"; shift 2 ;;
    --no-open|--no-browser) OPEN_BROWSER=0; shift ;;
    --log) LOG_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$(readlink -f "$0")")"

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 Node.js，请先安装 Node.js 18+ : https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误: 需要 Node.js 18+，当前为 $(node -v)" >&2
  exit 1
fi

# --- 运行时依赖（只有 js-yaml）---
if [ ! -d node_modules/js-yaml ]; then
  echo "首次运行，正在安装依赖…"
  if ! npm install js-yaml --no-save --no-audit --no-fund; then
    echo "错误: 依赖安装失败。请检查网络，或手动执行: npm install js-yaml" >&2
    exit 1
  fi
fi

# --- 端口占用检查：明确报错，而不是让 node 抛一堆栈 ---
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${PORT}" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else
    # 最后兜底：真正尝试连接一次（能连上说明有人监听）
    (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1 && return 0 || return 1
  fi
}

if port_busy; then
  echo "错误: 端口 ${PORT} 已被占用。" >&2
  echo "  可能是本工具已在运行：先执行 ./stop.sh" >&2
  echo "  或改用其它端口：NODEPILOT_PORT=9000 ./start.sh  或  ./start.sh --port 9000" >&2
  exit 1
fi

export NODEPILOT_PORT="$PORT"
if [ -n "$CORE_PATH" ]; then
  export NODEPILOT_CORE="$CORE_PATH"
fi

ARGS=("src/server.mjs")
if [ "$OPEN_BROWSER" -eq 1 ]; then
  ARGS+=("--open")
fi

echo "启动 clash-nodepilot (端口 ${PORT})…"

# 可选：把启动过程同时写入日志，便于事后排查。默认写到工具工作目录。
if [ -z "$LOG_FILE" ]; then
  LOG_FILE="${TMPDIR:-/tmp}/nodepilot/nodepilot.log"
fi
if mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null; then
  exec node "${ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"
else
  exec node "${ARGS[@]}"
fi
