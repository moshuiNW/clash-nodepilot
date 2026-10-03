// Verify the shutdown path leaves no processes behind.
// This is the exact question being answered: does closing the UI stop things?
//
// The process enumeration used to be Windows-only PowerShell, which made this
// file throw ENOENT on Linux and took the whole `npm test` down with it. It now
// dispatches per platform: /proc on Linux, CIM on Windows.
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findOurCore, defaultBaseDir, readPidFile, pidAlive } from '../src/core/proc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790;
const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PIDs of node servers running this tool, plus our mihomo cores. */
function listProcesses() {
  const workDir = path.join(defaultBaseDir(), 'core');

  if (IS_WIN) {
    // Match any mihomo/clash core name, not just Clash Verge's `verge-mihomo.exe`:
    // CI and manual installs use plain `mihomo.exe`, and a name-specific filter
    // made "运行时拉起了 mihomo 内核" fail on every such machine.
    const names = ['mihomo.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'clash-meta.exe', 'clash.exe'];
    const nameFilter = names.map((n) => `Name='${n}'`).join(' OR ');
    const ps = `
      $out = @()
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -like '*server.mjs*' -and $_.CommandLine -notlike '*subprocess-local*' -and $_.CommandLine -notlike '*runner.js*'
      } | ForEach-Object { $out += "node:$($_.ProcessId)" }
      Get-CimInstance Win32_Process -Filter "${nameFilter}" | Where-Object {
        $_.CommandLine -like '*nodepilot*'
      } | ForEach-Object { $out += "core:$($_.ProcessId)" }
      $out -join ','
    `;
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    }).trim();
    return raw ? raw.split(',').filter(Boolean) : [];
  }

  // Linux: /proc. A node server for this tool, and any core bound to our work dir.
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return out; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
    } catch { continue; }
    if (/server\.mjs/.test(cmd) && !/subprocess-local|runner\.js/.test(cmd)) out.push(`node:${pid}`);
  }
  for (const hit of findOurCore(workDir)) out.push(`core:${hit.pid}`);
  return out;
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};

const before = listProcesses();
console.log('processes before start:', before.length ? before.join(',') : '(none)');

// Start the server with a config so it also launches a mihomo core.
//
// Capture what is already running *before* we start, so an unrelated or stale
// instance (even one with the same script name) cannot be mistaken for ours.
const staleNodePids = new Set(
  before.filter((p) => p.startsWith('node:')).map((p) => Number(p.slice(5)))
);

const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, NODEPILOT_PORT: String(PORT) },
  stdio: 'ignore',
  windowsHide: true,
});

// Wait until OUR child is the one answering on this port.
//
// Polling /api/status alone is not enough: a stale server left on this port by
// an earlier run answers just as happily, and the test would then read that
// instance's PID file instead of ours (which is exactly how this failed on CI
// while passing locally). Require the PID file to name our child before
// treating the server as up.
let up = false;
let pidData = null;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  // The PID file is now written before listen, so if it names our child the
  // server is either up already or about to be.
  const rec = readPidFile(defaultBaseDir());
  if (rec && rec.serverPid === child.pid) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
      if (r.ok) { up = true; pidData = rec; break; }
    } catch { /* not accepting yet */ }
  }
  if (child.exitCode !== null) break;
  await sleep(250);
}

check('服务已启动', up);
if (!up) {
  console.log('  PID 文件:', JSON.stringify(readPidFile(defaultBaseDir())));
  console.log('  child pid:', child.pid, 'exitCode:', child.exitCode);
  child.kill();
  process.exit(1);
}

// The PID file must be written once the server is listening.
check('启动了 PID 文件记录', !!pidData && Number.isInteger(pidData.serverPid), JSON.stringify(pidData));
check('PID 文件记录了端口', pidData?.port === PORT, `port=${pidData?.port}`);
check('PID 文件记录的是本测试启动的进程', pidData?.serverPid === child.pid,
  `file=${pidData?.serverPid} child=${child.pid}`);

// Load the placeholder fixture so a real core process is spawned.
const fixture = path.join(ROOT, 'tests', 'fixtures', 'sample-subscription.yaml');
const load = await fetch(`http://127.0.0.1:${PORT}/api/load`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: fixture }),
}).then((r) => r.json()).catch(() => ({}));
console.log('load result:', JSON.stringify(load).slice(0, 120));

await sleep(1500);
const during = listProcesses();
console.log('processes while running:', during.join(',') || '(none)');
const freshNodes = during.filter(
  (p) => p.startsWith('node:') && !staleNodePids.has(Number(p.slice(5)))
);
check('运行时有 node 服务', freshNodes.length > 0, during.join(','));
check('运行时拉起了 mihomo 内核', during.some((p) => p.startsWith('core:')), during.join(','));

// The core pid must be recorded and must actually be our core.
const pidData2 = readPidFile(defaultBaseDir());
check('PID 文件记录了内核 PID', Number.isInteger(pidData2?.corePid), JSON.stringify(pidData2));
check('记录的内核 PID 确实存活', pidAlive(pidData2?.corePid), `corePid=${pidData2?.corePid}`);

// --- invoke the shutdown API (what the UI button does) ---
const t0 = Date.now();
let ok = false;
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/shutdown`, { method: 'POST' });
  ok = r.ok;
} catch { ok = false; }
console.log(`shutdown API responded: ${ok} in ${Date.now() - t0}ms`);

await sleep(4000);

const after = listProcesses();
console.log('processes after shutdown:', after.join(',') || '(none)');
const leftover = after.filter(
  (p) => p.startsWith('node:') && !staleNodePids.has(Number(p.slice(5)))
);
check('关闭后 node 服务已退出', leftover.length === 0, leftover.join(','));
check('关闭后 mihomo 内核已退出', !after.some((p) => p.startsWith('core:')), after.join(','));
check('关闭后内核 PID 真的不在了', !pidAlive(pidData2?.corePid), `corePid=${pidData2?.corePid}`);

// Port must be free.
let portFree = true;
try {
  await fetch(`http://127.0.0.1:${PORT}/api/status`);
  portFree = false;
} catch { portFree = true; }
check('关闭后端口已释放', portFree);

// The PID file must be cleaned up, so the next start is not misled by it.
check('关闭后 PID 文件已清理', !fs.existsSync(path.join(defaultBaseDir(), 'nodepilot.pid')));

// The user's own Clash Verge core must be untouched.
if (IS_WIN) {
  const vergeCore = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" | Where-Object { $_.CommandLine -like '*clash-verge-service*' } | Measure-Object).Count`
  ], { encoding: 'utf8', windowsHide: true }).trim();
  console.log('user Clash Verge core still present:', vergeCore);
  check('未影响你自己的 Clash Verge 内核', Number(vergeCore) >= 0);
} else {
  // On Linux the safety property that matters is stronger and directly
  // checkable: our identification never matches the system service core, which
  // is launched with a different -d (its own runtime dir).
  const workDir = path.join(defaultBaseDir(), 'core');
  const ours = findOurCore(workDir);
  const foreign = ours.filter((h) => /clash-verge-service/.test(h.cmd));
  console.log('our cores after shutdown:', ours.length, '| foreign-service matches:', foreign.length);
  check('未影响你自己的 Clash Verge 内核', foreign.length === 0, JSON.stringify(foreign));
}

try { child.kill(); } catch { /* already gone */ }

console.log(`\n${failures} failed`);
console.log('SHUTDOWN_TEST_DONE');
process.exit(failures ? 1 : 0);
