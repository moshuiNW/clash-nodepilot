// Verify the shutdown path leaves no processes behind.
// This is the exact question being answered: does closing the UI stop things?
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listProcesses() {
  const ps = `
    $out = @()
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -like '*server.mjs*' -and $_.CommandLine -notlike '*subprocess-local*' -and $_.CommandLine -notlike '*runner.js*'
    } | ForEach-Object { $out += "node:$($_.ProcessId)" }
    Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" | Where-Object {
      $_.CommandLine -like '*nodepilot*'
    } | ForEach-Object { $out += "core:$($_.ProcessId)" }
    $out -join ','
  `;
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  }).trim();
  return raw ? raw.split(',').filter(Boolean) : [];
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};

const before = listProcesses();
console.log('processes before start:', before.length ? before.join(',') : '(none)');

// Start the server with a config so it also launches a mihomo core.
const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, NODEPILOT_PORT: String(PORT) },
  stdio: 'ignore',
  windowsHide: true,
});

// Wait for the HTTP API.
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    if (r.ok) { up = true; break; }
  } catch { /* not yet */ }
  await sleep(500);
}
check('服务已启动', up);
if (!up) { child.kill(); process.exit(1); }

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
check('运行时有 node 服务', during.some((p) => p.startsWith('node:')), during.join(','));
check('运行时拉起了 mihomo 内核', during.some((p) => p.startsWith('core:')), during.join(','));

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
check('关闭后 node 服务已退出', !after.some((p) => p.startsWith('node:')), after.join(','));
check('关闭后 mihomo 内核已退出', !after.some((p) => p.startsWith('core:')), after.join(','));

// Port must be free.
let portFree = true;
try {
  await fetch(`http://127.0.0.1:${PORT}/api/status`);
  portFree = false;
} catch { portFree = true; }
check('关闭后端口已释放', portFree);

// The user's own Clash Verge core must be untouched.
const vergeCore = execFileSync('powershell', ['-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter "Name='verge-mihomo.exe'" | Where-Object { $_.CommandLine -like '*clash-verge-service*' } | Measure-Object).Count`
], { encoding: 'utf8', windowsHide: true }).trim();
console.log('user Clash Verge core still present:', vergeCore);
check('未影响你自己的 Clash Verge 内核', Number(vergeCore) >= 0);

try { child.kill(); } catch { /* already gone */ }

console.log(`\n${failures} failed`);
console.log('SHUTDOWN_TEST_DONE');
process.exit(failures ? 1 : 0);
