// Verify the export safety guarantees that the original tool lacked:
// 1. A failed subscription fetch must NOT write/overwrite any output file.
// 2. An empty filter result must NOT overwrite an existing good file.
// 3. A successful export must produce a valid config.
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, ensureMeasuredResults, cleanupServer, BASE, post as rawPost } from './helpers.mjs';

const OUT_DIR = path.resolve('tests/_exporttest');
fs.mkdirSync(OUT_DIR, { recursive: true });

const GOOD_FILE = path.join(OUT_DIR, 'result.yaml');
const SENTINEL = '# SENTINEL: this good file must survive\nproxies:\n  - name: keepme\n    type: ss\n';
fs.writeFileSync(GOOD_FILE, SENTINEL, 'utf8');

const server = await ensureServer();
const post = rawPost;

// The export tests operate on whatever result set exists; no working node is
// required for the file-write guarantees being verified here.
await ensureMeasuredResults();

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${name}`); pass++; }
  else { console.log(`FAIL  ${name} ${detail}`); fail++; }
};

// --- 1. Unreachable subscription must not clobber ---
const badLoad = await post('/load', {
  source: 'https://this-host-does-not-exist-nodepilot.invalid/sub',
  userAgent: 'clash-verge/1.3.8',
});
check('unreachable subscription returns an error', badLoad.status >= 400, JSON.stringify(badLoad.data).slice(0, 120));
check('sentinel file untouched after failed fetch', fs.readFileSync(GOOD_FILE, 'utf8') === SENTINEL);

// --- 2. Export with impossible filters must not overwrite ---
const emptySave = await post('/export/save', {
  filters: { maxLatencyMs: 1, minDownloadMBs: 9999, onlyWorking: true },
  dir: OUT_DIR,
  fileName: 'result.yaml',
});
check('export with no matching nodes is rejected', emptySave.status >= 400, JSON.stringify(emptySave.data).slice(0, 120));
check('sentinel file untouched after empty export', fs.readFileSync(GOOD_FILE, 'utf8') === SENTINEL);

// --- 3. Valid export writes a real config ---
// onlyWorking is false on purpose: this step verifies the write path and the
// generated structure, which must hold even when no node is reachable.
const okSave = await post('/export/save', {
  filters: { maxLatencyMs: 0, minDownloadMBs: 0, onlyWorking: false },
  rename: true,
  groupName: '🚀 节点选择',
  dir: OUT_DIR,
  fileName: 'good.yaml',
});
check('valid export succeeds', okSave.status === 200, JSON.stringify(okSave.data).slice(0, 160));
if (okSave.status === 200) {
  const written = fs.readFileSync(path.join(OUT_DIR, 'good.yaml'), 'utf8');
  check('export contains proxies section', /proxies:/.test(written));
  check('export contains renamed nodes', /\b(HK|JP|SG|US|DE) \d{3}\b/.test(written), written.slice(0, 200));
  check('export contains proxy-groups', /proxy-groups:/.test(written));
  check('export has rules', /rules:/.test(written));
  const names = (written.match(/^ {4}- name: (.*)$/gm) || []).map((l) => l.trim());
  console.log(`      (${names.length} nodes written, first: ${names[0] || 'none'})`);
}

// --- 4. The sentinel file is still intact at the very end ---
check('sentinel file survived the whole run', fs.readFileSync(GOOD_FILE, 'utf8') === SENTINEL);

// --- 5. A successful export must not be clobbered by a later bad attempt ---
const goodPath = path.join(OUT_DIR, 'good.yaml');
if (okSave.status === 200) {
  const goodContent = fs.readFileSync(goodPath, 'utf8');
  await post('/export/save', {
    filters: { maxLatencyMs: 1, minDownloadMBs: 9999, onlyWorking: true },
    dir: OUT_DIR,
    fileName: 'good.yaml',
  });
  check('good export survives a later empty export', fs.readFileSync(goodPath, 'utf8') === goodContent);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('SAFETY_TEST_DONE');
cleanupServer(server);
process.exit(fail ? 1 : 0);
