// Shared test helper: ensures a nodepilot server is running with loaded nodes
// and completed measurements, starting everything if necessary.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const BASE = process.env.NODEPILOT_TEST_URL || 'http://127.0.0.1:8765/api';

/**
 * A config used by the tests.
 *
 * No real subscription URL or node credential is ever committed. Resolution
 * order:
 *   1. NODEPILOT_TEST_SUB  - point this at your own subscription/config
 *   2. tests/fixtures/sample-subscription.yaml - placeholder nodes (parses fine,
 *      but cannot connect, so bandwidth assertions are skipped)
 *
 * Tests that need real throughput skip themselves with a clear message when
 * only the fixture is available, rather than reporting a false failure.
 */
export const FIXTURE_SUB = path.join(__dirname, 'fixtures', 'sample-subscription.yaml');

export const TEST_SUB = (() => {
  const fromEnv = process.env.NODEPILOT_TEST_SUB;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fromEnv) return fromEnv; // allow a URL
  return FIXTURE_SUB;
})();

/** True when tests are running against a real, connectable subscription. */
export const HAS_REAL_SUB = TEST_SUB !== FIXTURE_SUB;

/** Backwards-compatible alias. */
export const LOCAL_SUB = TEST_SUB;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(timeoutMs = 1500) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`${BASE}/status`, { signal: c.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the server as a detached child; returns the child or null. */
export async function ensureServer({ waitMs = 25000 } = {}) {
  if (await reachable()) return null;

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await reachable()) return child;
    await sleep(500);
  }
  child.kill();
  throw new Error(`测试服务器未能在 ${waitMs}ms 内启动 (${BASE})`);
}

export async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}

export async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/**
 * Make sure the server has a measured result set. Loads a subscription and
 * runs a fast test when needed. Returns the results array.
 */
/**
 * How many nodes tests are allowed to measure.
 *
 * Bandwidth testing consumes real subscription quota (roughly
 * downloadDurationMs * measured speed per node). Tests therefore sample only a
 * handful of nodes by default. Override with NODEPILOT_TEST_LIMIT.
 */
export const TEST_NODE_LIMIT = Number(process.env.NODEPILOT_TEST_LIMIT) || 3;

/**
 * A deliberately short bandwidth config so a test run costs as little quota as
 * possible while still proving the pipeline works.
 */
export const TEST_BANDWIDTH_CONFIG = {
  latencyRounds: 1,
  latencyTimeoutMs: 4000,
  latencyConcurrency: 3,
  downloadConcurrency: 2,
  downloadDurationMs: 2500,
  maxLatencyMs: 3000,
  downloadFallback: false,
};

/**
 * Make sure the server has a settled result set to operate on.
 *
 * Loads the test subscription and runs a quick pass when needed. Returned
 * results may all be failures when running against the placeholder fixture;
 * that is fine for tests about export/file-write behaviour, which do not need
 * working nodes. Tests that require real throughput must check HAS_REAL_SUB.
 */
export async function ensureMeasuredResults({ timeoutMs = 300000, requireData = false } = {}) {
  const status = (await get('/status')).data;
  if (!status.nodeCount) {
    const load = await post('/load', {
      source: TEST_SUB,
      userAgent: 'clash-verge/1.3.8',
      limit: TEST_NODE_LIMIT,
    });
    if (load.status !== 200) {
      throw new Error(`加载测试订阅失败: ${JSON.stringify(load.data).slice(0, 200)}`);
    }
  }

  const have = (await get('/results')).data.results || [];
  const settledNow = have.length && have.every((r) => ['done', 'error', 'aborted'].includes(r.status));
  if (settledNow && (!requireData || have.some((r) => r.downloadBps > 0))) return have;

  // Another test may already be running; 409 is fine, just wait for it.
  await post('/test/start', { config: TEST_BANDWIDTH_CONFIG });

  const deadline = Date.now() + timeoutMs;
  let sawProgress = false;

  while (Date.now() < deadline) {
    const snap = (await get('/results')).data;
    const rows = snap.results || [];
    const settled = rows.filter((r) => ['done', 'error', 'aborted'].includes(r.status)).length;

    if (rows.some((r) => r.downloadBps > 0)) sawProgress = true;
    if (rows.length && settled >= rows.length) {
      if (!requireData || sawProgress) return rows;
      throw new Error(
        `测速结束但没有任何节点产生下载数据。状态: ${JSON.stringify(
          rows.slice(0, 3).map((r) => ({ name: r.name, status: r.status, error: r.error }))
        )}`
      );
    }
    await sleep(2500);
  }
  throw new Error(`测速未在 ${timeoutMs}ms 内完成`);
}

export function cleanupServer(child) {
  if (child && !child.killed) {
    try { child.kill(); } catch { /* ignore */ }
  }
}
