// Verify the unlock feature through the real UI: toggle, run, render chips,
// and filter by unlock status.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensureServer, cleanupServer, TEST_SUB, HAS_REAL_SUB, TEST_NODE_LIMIT } from './helpers.mjs';

// Unlock checks need really connectable nodes; the placeholder fixture cannot
// reach any service, so skip rather than report a misleading failure.
if (!HAS_REAL_SUB) {
  console.log('SKIP  解锁检测 UI 测试：未配置 NODEPILOT_TEST_SUB（需要真实可用节点）');
  console.log('      示例：$env:NODEPILOT_TEST_SUB = "D:\\path\\to\\config.yaml"; npm run test:ui');
  console.log('0 failed');
  console.log('UI_UNLOCK_TEST_DONE');
  process.exit(0);
}

const server = await ensureServer();
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5 });

// Collect genuine JS errors separately from browser network notices. A 4xx
// response is expected here: the export endpoint deliberately refuses to write
// an empty config, and the browser logs that as a console error.
const jsErrors = [];
const networkNotices = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource/i.test(t)) networkNotices.push(t);
  else jsErrors.push(t);
});
page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:8765', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

let failures = 0;
const assert = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};

// Load nodes. Only a few: bandwidth testing consumes real subscription quota.
await page.fill('#source', TEST_SUB);
await page.fill('#nodeLimit', String(TEST_NODE_LIMIT));
await page.click('#btnLoad');
await page.waitForFunction(
  () => !document.getElementById('sourceMsg').textContent.includes('正在读取'),
  { timeout: 90000 }
);
await page.waitForTimeout(600);

// Enable unlock and confirm the service list populated
await page.click('#btnAdvanced');
await page.waitForTimeout(300);
await page.check('#cfgUnlockEnabled');
await page.waitForTimeout(400);

const serviceCount = await page.$$eval('#unlockServices input[type=checkbox]', (els) => els.length);
assert('解锁服务列表已加载', serviceCount >= 8, `found ${serviceCount}`);

const filterOptions = await page.$$eval('#filterUnlock option', (els) => els.length);
assert('结果页解锁筛选已填充', filterOptions >= 8, `found ${filterOptions}`);

// Keep the run short: only a couple of services, few nodes
await page.$$eval('#unlockServices input[type=checkbox]', (els) => {
  els.forEach((e) => { e.checked = ['chatgpt', 'netflix', 'bilibili-hk'].includes(e.value); });
});
await page.fill('#cfgLatencyRounds', '1');
await page.fill('#cfgDlDuration', '3');
await page.fill('#cfgMaxLatency', '700');

await page.click('#btnStart');
console.log('test started (with unlock)...');

const t0 = Date.now();
let completed = false;
while (Date.now() - t0 < 420000) {
  const s = await page.evaluate(() => ({
    hint: document.getElementById('phaseHint').textContent,
    phase: document.getElementById('phaseHint').textContent,
    chips: document.querySelectorAll('.uchip').length,
  }));
  if ((Date.now() - t0) % 30000 < 2600) {
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] hint="${s.hint}" chips=${s.chips}`);
  }
  if (s.chips > 0 && /已完成/.test(s.hint)) { completed = true; break; }
  await page.waitForTimeout(2500);
}
assert('解锁检测完成', completed, 'did not detect completion');
await page.waitForTimeout(800);

// Inspect rendered chips
const chipStats = await page.evaluate(() => {
  const out = { ok: 0, no: 0, unknown: 0, samples: [] };
  document.querySelectorAll('.uchip').forEach((c) => {
    if (c.classList.contains('u-ok')) out.ok++;
    else if (c.classList.contains('u-no')) out.no++;
    else out.unknown++;
  });
  const firstRow = document.querySelector('#tbody tr');
  if (firstRow) {
    out.samples = [...firstRow.querySelectorAll('.uchip')].map((c) => `${c.textContent}:${c.title}`);
  }
  return out;
});
console.log(`\nchips: unlocked=${chipStats.ok} blocked=${chipStats.no} other=${chipStats.unknown}`);
for (const s of chipStats.samples) console.log('  ' + s);
assert('表格渲染了解锁标记', chipStats.ok + chipStats.no > 0);

await page.screenshot({ path: `${OUT}/unlock-results.png`, fullPage: false });

// Filter by "only chatgpt-unlocked"
const beforeRows = await page.$$eval('#tbody tr', (r) => r.length);
await page.selectOption('#filterUnlock', 'chatgpt');
await page.waitForTimeout(600);
const afterRows = await page.$$eval('#tbody tr', (r) => r.length);
console.log(`\nrows before filter=${beforeRows} after chatgpt filter=${afterRows}`);
assert('按解锁筛选生效', afterRows <= beforeRows && afterRows >= 0, `${beforeRows} -> ${afterRows}`);

// All remaining rows should show GPT unlocked
const allGptOk = await page.$$eval('#tbody tr', (trs) =>
  trs.every((tr) => [...tr.querySelectorAll('.uchip')].some((c) => c.textContent === 'GPT' && c.classList.contains('u-ok')))
);
assert('筛选结果确实都解锁了 ChatGPT', allGptOk);

await page.selectOption('#filterUnlock', '');
await page.waitForTimeout(400);

// Export filtered by required unlock.
// Make the speed thresholds permissive on purpose: this assertion is about the
// unlock filter, and leaving the default min-download in place would make the
// result depend on incidental network speed rather than on unlock status.
await page.fill('#fMaxLatency', '0');
await page.fill('#fMinDown', '0');
await page.selectOption('#fUnlockRequired', ['chatgpt']);
await page.waitForTimeout(400);

// How many nodes does the API say have ChatGPT unlocked?
const gptUnlocked = await page.evaluate(async () => {
  const r = await fetch('/api/results');
  const d = await r.json();
  return (d.results || []).filter((x) =>
    (x.unlock || []).some((u) => u.id === 'chatgpt' && u.status === 'unlocked')
  ).length;
});

await page.click('#btnPreview');
await page.waitForTimeout(2500);
const exportMsg = await page.textContent('#exportMsg');
console.log(`export msg: ${exportMsg.trim()}  (chatgpt-unlocked nodes=${gptUnlocked})`);

const m = /预览\s*(\d+)\s*个节点/.exec(exportMsg);
assert('按解锁导出预览成功', !!m, exportMsg.trim());
if (m) {
  assert(
    '导出数量与解锁节点数一致',
    Number(m[1]) === gptUnlocked,
    `导出 ${m[1]} vs 接口统计 ${gptUnlocked}`
  );
}

await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.screenshot({ path: `${OUT}/unlock-export.png`, fullPage: false });

assert('页面无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 5).join(' | '));
if (networkNotices.length) {
  console.log(`      (${networkNotices.length} network notice(s), expected for rejected exports)`);
}

await browser.close();
cleanupServer(server);
console.log(`\n${failures} failed`);
console.log('UI_UNLOCK_TEST_DONE');
process.exit(failures ? 1 : 0);
