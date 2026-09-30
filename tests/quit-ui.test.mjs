// Verify the in-page quit button: confirm dialog, shutdown, farewell screen,
// and that the backend actually exits.
import { chromium } from 'playwright';
import { ensureServer, cleanupServer } from './helpers.mjs';

const server = await ensureServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};

await page.goto('http://127.0.0.1:8765', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// The quit button should exist and be visible.
const quitVisible = await page.isVisible('#btnQuit');
check('界面有退出按钮', quitVisible);

// Clicking it shows a confirmation rather than quitting immediately.
await page.click('#btnQuit');
await page.waitForTimeout(400);
const maskShown = await page.isVisible('#quitMask');
check('点击后先弹出确认框', maskShown);

// Cancel must not quit.
await page.click('#btnQuitCancel');
await page.waitForTimeout(400);
const maskHidden = !(await page.isVisible('#quitMask'));
check('取消可关闭确认框', maskHidden);

const stillAlive = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/status');
    return r.ok;
  } catch { return false; }
});
check('取消后服务仍在运行', stillAlive);

// Confirm -> farewell screen and the backend goes away.
await page.click('#btnQuit');
await page.waitForTimeout(300);
await page.click('#btnQuitConfirm');
await page.waitForTimeout(3500);

const farewell = await page.evaluate(() => document.body.textContent || '');
check('显示已结束运行提示', /已结束运行/.test(farewell), farewell.slice(0, 80));

// Backend must be gone.
let backendDown = false;
try {
  await page.evaluate(async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 2500);
    await fetch('/api/status', { signal: c.signal });
  });
  backendDown = false;
} catch {
  backendDown = true;
}
check('确认后后端已停止', backendDown);

await browser.close();
cleanupServer(server);

console.log(`\n${failures} failed`);
console.log('QUIT_UI_TEST_DONE');
process.exit(failures ? 1 : 0);
