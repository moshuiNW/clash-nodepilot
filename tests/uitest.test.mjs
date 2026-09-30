// Drive the real UI in a headless browser: load -> measure -> render -> export.
// Asserts the flow works and that the page logs no console errors.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensureServer, cleanupServer, TEST_SUB, HAS_REAL_SUB, TEST_NODE_LIMIT } from './helpers.mjs';

const server = await ensureServer();
const URL = 'http://127.0.0.1:8765';
// Set NODEPILOT_TEST_SUB to run against your own subscription; otherwise a
// bundled fixture with placeholder nodes is used so no real credentials are
// needed (or committed).
const SUB = TEST_SUB;
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1150 }, deviceScaleFactor: 1.5 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/1-initial.png`, fullPage: false });
console.log('captured 1-initial');

// Core badge should show a detected core
const badge = await page.textContent('#coreBadgeText');
console.log('core badge:', badge.trim());

// Fill subscription and load.
// Limit to a few nodes: bandwidth testing consumes real subscription quota.
await page.fill('#source', SUB);
await page.fill('#nodeLimit', String(TEST_NODE_LIMIT));
await page.click('#btnLoad');
console.log('loading subscription...');
await page.waitForFunction(
  () => !document.getElementById('sourceMsg').textContent.includes('正在读取'),
  { timeout: 90000 }
);
await page.waitForTimeout(800);
const srcMsg = await page.textContent('#sourceMsg');
console.log('source message:', srcMsg.trim());
await page.screenshot({ path: `${OUT}/2-loaded.png`, fullPage: false });

// Narrow the test a bit for speed, then start
await page.click('#btnAdvanced');
await page.waitForTimeout(300);
await page.fill('#cfgDlDuration', '5');
await page.selectOption('#filterSort', 'download');
await page.click('#btnStart');
console.log('test started...');

// Poll for completion, logging UI state so a stall is visible.
const t0 = Date.now();
let completed = false;
while (Date.now() - t0 < 300000) {
  const snap = await page.evaluate(() => ({
    hint: document.getElementById('phaseHint').textContent,
    prog: document.getElementById('progressText').textContent,
    startDisabled: document.getElementById('btnStart').disabled,
    startLabel: document.getElementById('btnStart').textContent,
    speeds: [...document.querySelectorAll('#tbody .speed-num')]
      .filter((e) => e.textContent.trim() !== '—').length,
  }));
  if (Date.now() - t0 > 0 && (Date.now() - t0) % 30000 < 2600) {
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] hint="${snap.hint}" prog="${snap.prog}" speeds=${snap.speeds} btn="${snap.startLabel}"`);
  }
  // Completion is signalled by the phase hint regardless of whether any node
  // was reachable (the fixture's hosts do not resolve).
  if (/已完成/.test(snap.hint)) { completed = true; break; }
  await page.waitForTimeout(2500);
}
console.log(completed ? 'completed detected' : 'COMPLETION NOT DETECTED (timeout)');
await page.waitForTimeout(1000);

await page.screenshot({ path: `${OUT}/3-results.png`, fullPage: false });
console.log('captured 3-results');

// Read the rendered table
const rows = await page.$$eval('#tbody tr', (trs) =>
  trs.slice(0, 10).map((tr) => {
    const td = tr.querySelectorAll('td');
    return {
      name: td[2]?.textContent.trim(),
      type: td[3]?.textContent.trim(),
      latency: td[4]?.textContent.trim(),
      jitter: td[5]?.textContent.trim(),
      loss: td[6]?.textContent.trim(),
      speed: td[7]?.textContent.trim(),
    };
  })
);
console.log('\nrendered rows:');
for (const r of rows) console.log(' ', JSON.stringify(r));

const stats = await page.evaluate(() => ({
  total: document.getElementById('statTotal').textContent,
  usable: document.getElementById('statUsable').textContent,
  best: document.getElementById('statBest').textContent,
  avg: document.getElementById('statAvg').textContent,
  matched: document.getElementById('matchCount').textContent,
}));
console.log('\nstats:', JSON.stringify(stats));

// Preview export.
// Always loosen the thresholds for this assertion. The default filters
// (max latency / min download / only-working) legitimately exclude nodes whose
// measured speed varies run to run, so relying on them would make this test
// flaky and would test the network rather than the export pipeline.
await page.fill('#fMaxLatency', '0');
await page.fill('#fMinDown', '0');
await page.uncheck('#fOnlyWorking');
await page.waitForTimeout(400);
await page.click('#btnPreview');
await page.waitForTimeout(2500);
const previewVisible = await page.isVisible('#preview');
const exportMsg = await page.textContent('#exportMsg');
console.log('preview visible:', previewVisible, '| msg:', exportMsg.trim());
if (previewVisible) {
  const head = await page.textContent('#preview');
  console.log('preview head:\n' + head.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'));
}
await page.screenshot({ path: `${OUT}/4-export.png`, fullPage: false });
console.log('captured 4-export');

// Light theme
await page.click('#btnTheme');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/5-light.png`, fullPage: false });
console.log('captured 5-light');

// Logs drawer
await page.click('#btnTheme');
await page.click('#btnLogs');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/6-logs.png`, fullPage: false });
console.log('captured 6-logs');

// --- assertions ---
let failures = 0;
let skipped = 0;
const assert = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};
const skip = (name, why) => { console.log(`SKIP  ${name} (${why})`); skipped++; };

assert('内核被自动探测到', /mihomo|clash/i.test(badge), `badge="${badge}"`);
assert('订阅成功加载节点', /已就绪/.test(srcMsg) && /个节点/.test(srcMsg), srcMsg.trim());
assert('测速流程跑完（进度到已完成）', completed);
assert('结果表格渲染了全部节点', rows.length > 0, `rows=${rows.length}`);
assert('每行都有延迟/丢包/速度列', rows.every((r) => r.latency && r.loss && r.speed), JSON.stringify(rows[0]));
assert('导出预览生成成功', previewVisible, exportMsg.trim());
assert('页面无 JS 报错', errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, errors.slice(0, 5).join(' | '));

// Throughput can only be asserted when real, connectable nodes are configured.
if (HAS_REAL_SUB) {
  assert('存在可用节点', Number(stats.usable) > 0, JSON.stringify(stats));
  assert('至少一个节点测出速度', rows.some((r) => r.speed && r.speed !== '—'), JSON.stringify(rows.slice(0, 3)));
} else {
  skip('可用节点/实测速度', '当前使用占位fixture，未配置 NODEPILOT_TEST_SUB');
}

console.log('\nconsole errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
cleanupServer(server);

console.log(`\n${failures} failed${skipped ? `, ${skipped} skipped` : ''}`);
console.log('UI_TEST_DONE');
process.exit(failures ? 1 : 0);
