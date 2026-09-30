// Verify chip CSS class matches the underlying unlock status exactly.
import { chromium } from 'playwright';
import { ensureServer, cleanupServer, get, post, TEST_SUB, HAS_REAL_SUB, TEST_NODE_LIMIT, TEST_BANDWIDTH_CONFIG } from './helpers.mjs';

// Comparing rendered chips against real unlock data requires nodes that can
// actually reach the services.
if (!HAS_REAL_SUB) {
  console.log('SKIP  解锁标签一致性测试：未配置 NODEPILOT_TEST_SUB（需要真实可用节点）');
  console.log('VERDICT: SKIP');
  console.log('CHIP_VERIFY_DONE');
  process.exit(0);
}

const server = await ensureServer();

// Ensure there is data with unlock results to verify against.
let api = (await get('/results')).data.results || [];
if (!api.some((r) => Array.isArray(r.unlock) && r.unlock.length)) {
  const st = (await get('/status')).data;
  if (!st.nodeCount) {
    // Sample only a few nodes: bandwidth testing costs real subscription quota.
    await post('/load', { source: TEST_SUB, userAgent: 'clash-verge/1.3.8', limit: TEST_NODE_LIMIT });
  }
  await post('/test/start', {
    config: {
      ...TEST_BANDWIDTH_CONFIG,
      maxLatencyMs: 900,
      unlockEnabled: true,
      unlockConcurrency: 3,
      unlockServiceIds: ['chatgpt', 'netflix', 'bilibili-hk', 'spotify'],
    },
  });
  const deadline = Date.now() + 420000;
  while (Date.now() < deadline) {
    const snap = (await get('/results')).data;
    api = snap.results || [];
    const withUnlock = api.filter((r) => Array.isArray(r.unlock) && r.unlock.length).length;
    if (snap.phase === 'finished' && withUnlock > 0) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
await page.goto('http://127.0.0.1:8765', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

api = (await get('/results')).data.results || [];
const dom = await page.evaluate(() =>
  [...document.querySelectorAll('#tbody tr')].map((tr) => ({
    name: tr.querySelector('.name')?.textContent.trim(),
    chips: [...tr.querySelectorAll('.uchip')].map((c) => ({
      label: c.textContent,
      title: c.title,
      cls: c.className.replace('uchip ', ''),
    })),
  }))
);

let checked = 0;
let mismatches = [];
for (const row of dom) {
  const apiRow = api.find((r) => r.name === row.name);
  if (!apiRow || !Array.isArray(apiRow.unlock)) continue;
  for (const chip of row.chips) {
    // title begins with "<service name>: <verdict>"
    const verdict = /:\s*(已解锁|被封锁|检测失败|未知)/.exec(chip.title)?.[1];
    const expected = verdict === '已解锁' ? 'u-ok'
      : verdict === '被封锁' ? 'u-no'
        : 'u-unknown';
    checked++;
    if (chip.cls !== expected) {
      mismatches.push(`${row.name} ${chip.label}: cls=${chip.cls} expected=${expected} title="${chip.title}"`);
    }
  }
}

console.log(`chips checked against API data: ${checked}`);
console.log(`mismatches: ${mismatches.length}`);
for (const m of mismatches.slice(0, 10)) console.log('  ' + m);

// A vacuous pass (nothing checked) is not a pass.
if (checked === 0) {
  console.log('INCONCLUSIVE: no chips were rendered to compare.');
}

// Also confirm no chip claims "unlocked" when the API says blocked
let falsePositive = 0;
for (const row of dom) {
  const apiRow = api.find((r) => r.name === row.name);
  if (!apiRow?.unlock) continue;
  for (const chip of row.chips) {
    if (!chip.classList) continue;
    const blocked = /被封锁|检测失败/.test(chip.title);
    if (blocked && chip.cls === 'u-ok') falsePositive++;
  }
}
console.log(`false "unlocked" chips: ${falsePositive}`);

await browser.close();
cleanupServer(server);
console.log(mismatches.length === 0 && falsePositive === 0 && checked > 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
console.log('CHIP_VERIFY_DONE');
