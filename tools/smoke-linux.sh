#!/usr/bin/env bash
# clash-nodepilot Linux 冒烟测试
#
# 目的：在真实订阅上验证「拉取 → 分配端口 → 内核就绪 → 延时测量 → 极短下载」
# 这条链路可用，并以尽可能小的流量代价完成。
#
# 用法:
#   NODEPILOT_SMOKE_SUB="<订阅链接或本地配置路径>" ./tools/smoke-linux.sh
#   NODEPILOT_SMOKE_SUB=... NODEPILOT_SMOKE_NODES=2 ./tools/smoke-linux.sh
#
# 未设置 NODEPILOT_SMOKE_SUB 时直接跳过（以退出码 0 结束），因此可以安全地
# 放进 CI —— CI 上不会有人提供真实订阅。
#
# 流量说明：默认只测 3 个节点的延迟（每次探测一个 204 空响应，约几百字节），
# 再对其中 1 个节点做 2 秒下载。下载是唯一的实质流量，默认约几 MB 以内。
# 设置 NODEPILOT_SMOKE_DOWNLOAD=0 可完全跳过下载测试。
#
# 安全：订阅链接只从环境变量读取，绝不会被写入任何文件、日志或提交。
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."

SUB="${NODEPILOT_SMOKE_SUB:-}"
NODES="${NODEPILOT_SMOKE_NODES:-3}"
DOWNLOAD="${NODEPILOT_SMOKE_DOWNLOAD:-1}"
PORT="${NODEPILOT_SMOKE_PORT:-8877}"
BASE="http://127.0.0.1:${PORT}/api"

if [ -z "$SUB" ]; then
  echo "跳过冒烟测试：未设置 NODEPILOT_SMOKE_SUB"
  echo "  用法: NODEPILOT_SMOKE_SUB=\"<订阅链接>\" $0"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 Node.js" >&2
  exit 1
fi

FAIL=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1"; FAIL=1; }

cleanup() {
  curl -s -m 3 -X POST "$BASE/shutdown" >/dev/null 2>&1 || true
  sleep 1
  if [ -n "${SRV_PID:-}" ] && kill -0 "$SRV_PID" 2>/dev/null; then
    kill "$SRV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== clash-nodepilot Linux 冒烟 =="
echo "  节点上限: $NODES   下载测试: $DOWNLOAD   端口: $PORT"

# --- 启动一个干净实例 ---
if curl -s -m 2 "$BASE/status" >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，先停止旧实例"
  NODEPILOT_PORT="$PORT" ./stop.sh --force >/dev/null 2>&1 || true
  sleep 1
fi

NODEPILOT_PORT="$PORT" node src/server.mjs >/tmp/nodepilot-smoke-server.log 2>&1 &
SRV_PID=$!

UP=0
for _ in $(seq 1 30); do
  if curl -s -m 2 "$BASE/status" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.5
done
[ "$UP" = 1 ] && ok "服务已启动" || { bad "服务未能启动"; cat /tmp/nodepilot-smoke-server.log; exit 1; }

# --- 内核探测 ---
CORE_JSON="$(curl -s -m 5 "$BASE/status")"
CORE_PATH="$(node -e "try{console.log((JSON.parse(process.argv[1]).coreInfo||{}).path||'')}catch(e){console.log('')}" "$CORE_JSON")"
if [ -n "$CORE_PATH" ]; then
  ok "内核已探测: $CORE_PATH"
else
  bad "未探测到 mihomo 内核"
  exit 1
fi

# --- 载入订阅（只取前 N 个节点，避免解析/建端口做无用功）---
LOAD="$(curl -s -m 120 -X POST "$BASE/load" \
  -H 'Content-Type: application/json' \
  --data-binary "$(node -e 'console.log(JSON.stringify({source:process.argv[1],limit:Number(process.argv[2]),userAgent:"clash-verge/1.3.8"}))' "$SUB" "$NODES")")"

PARSED="$(node -e "try{const d=JSON.parse(process.argv[1]);console.log(d.nodeCount??'ERR:'+(d.error||''))}catch(e){console.log('ERR:解析响应失败')}" "$LOAD")"

case "$PARSED" in
  ERR:*) bad "订阅载入失败: ${PARSED#ERR:}" ;;
  *)     ok "订阅解析并分配端口: ${PARSED} 个节点" ;;
esac
[ "$FAIL" = 0 ] || { echo "冒烟失败"; exit 1; }

# --- 第一阶段：只测延时，不产生下载流量 ---
#
# 引擎的下载阶段会对「所有测到延时的节点」做带宽测试，没有单独的开关可以
# 跳过它。这里借用 maxLatencyMs 的真实语义：把它设为 1ms，于是候选集为空，
# 下载一轮不会发生，只留下延时数据（每个节点一次 204 探测，流量可忽略）。
echo "  阶段 1/2: 延时测量（不产生下载流量）"
start_test() {
  curl -s -m 10 -X POST "$BASE/test/start" -H 'Content-Type: application/json' \
    --data-binary "{\"config\":$1}" >/dev/null 2>&1 || true
}

wait_settled() {
  local settled=0 snap=""
  for _ in $(seq 1 120); do
    snap="$(curl -s -m 5 "$BASE/results")"
    settled="$(node -e "try{const s=JSON.parse(process.argv[1]);const r=s.results||[];console.log(r.length&&r.every(x=>['done','error','aborted'].includes(x.status))?1:0)}catch(e){console.log(0)}" "$snap")"
    [ "$settled" = 1 ] && { printf '%s' "$snap"; return 0; }
    sleep 1
  done
  printf '%s' "$snap"
  return 1
}

start_test '{"latencyRounds":1,"latencyTimeoutMs":4000,"latencyConcurrency":2,"maxLatencyMs":1,"uploadEnabled":false,"unlockEnabled":false}'
if SNAP="$(wait_settled)"; then ok "阶段 1 完成（延时）"; else bad "阶段 1 未在预期时间内完成"; fi

MIN_LAT="$(node -e "try{const s=JSON.parse(process.argv[1]);const l=(s.results||[]).map(r=>r.latency).filter(v=>Number.isFinite(v));console.log(l.length?Math.min(...l):'')}catch(e){console.log('')}" "$SNAP")"

if [ "$DOWNLOAD" = 1 ] && [ -n "$MIN_LAT" ]; then
  # 第二阶段：把 maxLatencyMs 设为实测最短延时，候选集就只剩最快的那一个节点。
  echo "  阶段 2/2: 对最快的 1 个节点做 2 秒下载（最短延时 ${MIN_LAT}ms）"
  start_test "{\"latencyRounds\":1,\"latencyTimeoutMs\":4000,\"latencyConcurrency\":2,\"maxLatencyMs\":${MIN_LAT},\"downloadConcurrency\":1,\"downloadDurationMs\":2000,\"downloadFallback\":false,\"uploadEnabled\":false,\"unlockEnabled\":false}"
  if SNAP="$(wait_settled)"; then ok "阶段 2 完成（下载）"; else bad "阶段 2 未在预期时间内完成"; fi
elif [ "$DOWNLOAD" = 1 ]; then
  echo "  ⚠️ 没有任何节点测到延时，跳过下载阶段"
fi

# --- 聚合结论（绝不打印节点名 / 域名 / 订阅特征）---
node -e '
try {
  const s = JSON.parse(process.argv[1]);
  const rs = s.results || [];
  const lat = rs.map(r => r.latency).filter(v => Number.isFinite(v));
  const dl = rs.map(r => r.downloadBps).filter(v => Number.isFinite(v) && v > 0);
  const minLat = lat.length ? Math.min(...lat) : null;
  console.log(`  聚合: 节点 ${rs.length} 个，延时可用 ${lat.length} 个` +
    (minLat !== null ? `，最短延时 ${minLat}ms` : "") +
    `，有下载数据 ${dl.length} 个` +
    (dl.length ? `，最高实测下载 ${(Math.max(...dl)/1048576).toFixed(2)} MB/s` : ""));
} catch (e) { console.log("  聚合: 无法解析结果"); }
' "$SNAP"

echo
if [ "$FAIL" = 0 ]; then echo "冒烟通过 ✅"; else echo "冒烟失败 ❌"; fi
exit "$FAIL"
