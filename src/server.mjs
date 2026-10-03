// Local HTTP server: static UI + JSON API + SSE progress stream.
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { findCore, verifyCore, verifyCoreDetailed } from './core/core-finder.mjs';
import { CoreManager } from './core/core-manager.mjs';
import { writePidFile, removePidFile, defaultBaseDir } from './core/proc.mjs';
import { loadProxies, SubscriptionError } from './core/subscription.mjs';
import { SpeedTestEngine, DEFAULT_CONFIG, applyFilters } from './core/engine.mjs';
import { UNLOCK_SERVICES } from './core/unlock.mjs';
import { buildExportConfig, writeExport, defaultExportName } from './core/exporter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const state = {
  core: null,
  coreInfo: null,
  coreError: null,
  proxies: [],
  portMap: new Map(),
  rawDoc: null,
  source: null,
  engine: null,
  lastResults: [],
  config: { ...DEFAULT_CONFIG },
  busy: false,
  logs: [],
};

function pushLog(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 500) state.logs.shift();
  broadcast('log', { line });
}

// ---------- SSE ----------
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ---------- helpers ----------
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('请求体不是合法 JSON'); }
}

function summarizeResults() {
  const engine = state.engine;
  // Mirror the SSE snapshot shape so pollers see the same fields as streamers.
  if (engine) return engine.snapshot();
  const results = state.lastResults;
  return { results, total: results.length, done: 0, usable: 0, phase: 'idle', running: false };
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fsSync.createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method.toUpperCase();

  // --- environment / core status ---
  if (p === '/status' && method === 'GET') {
    return json(res, 200, {
      coreInfo: state.coreInfo,
      coreError: state.coreError,
      corePath: state.core?.binPath || null,
      coreRunning: !!state.core?.started,
      busy: state.busy,
      nodeCount: state.proxies.length,
      source: state.source,
      config: state.config,
      platform: `${os.platform()} ${os.arch()}`,
      nodeVersion: process.version,
      logs: state.logs.slice(-80),
      coreLogs: state.core ? state.core.getLogs().slice(-40) : [],
    });
  }

  if (p === '/core/detect' && method === 'POST') {
    try {
      const body = await readBody(req);
      const explicit = body.path ? String(body.path) : undefined;

      if (explicit) {
        const ok = await verifyCoreDetailed(explicit);
        if (!ok.path) {
          return json(res, 400, {
            error: ok.hint || `该文件无法执行或不是 mihomo 核心: ${explicit}`,
            code: ok.code || null,
          });
        }
        state.coreInfo = { path: ok.path, version: ok.version };
        state.core = new CoreManager({ binPath: ok.path });
        state.coreError = null;
        pushLog(`已指定内核: ${ok.path}`);
        return json(res, 200, { coreInfo: { path: ok.path, version: ok.version } });
      }

      const found = await findCore();
      if (!found.path) {
        state.coreError = '未找到 mihomo/clash 核心';
        // Surface the most informative reason among the candidates tried: a
        // file that exists but cannot execute is far more actionable than a
        // plain "not found".
        const best = (found.tried || []).find((t) => t.hint);
        return json(res, 404, {
          error: best?.hint
            ? `找到内核文件但无法使用。\n${best.hint}`
            : `未找到可用的 mihomo 核心。请指定路径，或将内核二进制放到工具目录。`,
          tried: (found.tried || []).slice(0, 15),
        });
      }
      state.coreInfo = { path: found.path, version: found.version };
      state.core = new CoreManager({ binPath: found.path });
      state.coreError = null;
      pushLog(`已探测到内核: ${found.path}`);
      return json(res, 200, { coreInfo: state.coreInfo });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // --- load subscription ---
  if (p === '/load' && method === 'POST') {
    if (state.busy) return json(res, 409, { error: '正在执行其他任务，请稍候' });
    const body = await readBody(req);
    const source = String(body.source || '').trim();
    if (!source) return json(res, 400, { error: '请填写订阅地址或配置文件路径' });

    if (!state.core?.binPath) {
      return json(res, 400, { error: '尚未探测到 mihomo 核心，请先在上方指定或探测' });
    }

    state.busy = true;
    broadcast('busy', { busy: true });
    try {
      pushLog(`正在读取配置: ${source}`);
      const ua = String(body.userAgent || '').trim() || undefined;

      const loaded = await loadProxies(source, {
        userAgent: ua,
        log: (m) => pushLog(m),
        onAttempt: (a, t) => broadcast('fetch', { attempt: a, total: t }),
      });

      // Optional cap on how many nodes are loaded/measured. Bandwidth testing
      // consumes real quota, so this lets a caller sample a few nodes cheaply.
      const limit = Number(body.limit);
      let proxies = loaded.proxies;
      if (Number.isFinite(limit) && limit > 0 && proxies.length > limit) {
        proxies = proxies.slice(0, limit);
        pushLog(`按上限截取前 ${limit} 个节点（共 ${loaded.proxies.length} 个）`);
      }

      pushLog(`解析到 ${proxies.length} 个节点`);
      for (const w of loaded.warnings) pushLog(`注意: ${w}`);

      state.proxies = proxies;
      state.rawDoc = loaded.rawDoc;
      state.source = source;

      // (Re)start the core with one listener per node.
      if (state.core.started) await state.core.stop();
      const started = await state.core.start(proxies, { log: pushLog });
      state.portMap = started.portMap;

      state.engine = new SpeedTestEngine(state.core, state.config);
      state.engine.on('update', (snap) => broadcast('progress', snap));
      state.engine.on('phase', (ph) => broadcast('phase', ph));

      return json(res, 200, {
        nodeCount: proxies.length,
        totalAvailable: loaded.proxies.length,
        readyCount: state.portMap.size,
        warnings: loaded.warnings,
        bytes: loaded.bytes,
        proxies: loaded.proxies.map((x) => ({ name: x.name, type: x.type, server: x.server })),
      });
    } catch (err) {
      const detail = err instanceof SubscriptionError ? err.message : err.message;
      pushLog(`失败: ${detail}`);
      return json(res, 400, { error: detail });
    } finally {
      state.busy = false;
      broadcast('busy', { busy: false });
    }
  }

  // --- start test ---
  if (p === '/test/start' && method === 'POST') {
    if (state.busy) return json(res, 409, { error: '任务进行中' });
    if (!state.engine || !state.portMap.size) {
      return json(res, 400, { error: '请先加载订阅并等待内核就绪' });
    }
    if (state.engine.running) return json(res, 409, { error: '测速已在进行中' });

    const body = await readBody(req);
    const cfg = { ...state.config, ...(body.config || {}) };
    state.config = cfg;
    state.engine.config = cfg;

    state.busy = true;
    broadcast('busy', { busy: true });
    pushLog(`开始测速: ${state.portMap.size} 个节点`);

    // Run without awaiting so the response returns immediately.
    state.engine
      .run(state.proxies, state.portMap, undefined)
      .then((snap) => {
        state.lastResults = snap.results;
        pushLog(`测速完成: ${snap.results.filter((r) => r.status === 'done').length}/${snap.total} 可用`);
      })
      .catch((err) => pushLog(`测速异常: ${err.message}`))
      .finally(() => {
        state.busy = false;
        broadcast('busy', { busy: false });
      });

    return json(res, 200, { started: true, total: state.portMap.size });
  }

  if (p === '/test/stop' && method === 'POST') {
    if (state.engine?.running) {
      state.engine.stop();
      pushLog('已请求停止测速');
      return json(res, 200, { stopped: true });
    }
    return json(res, 200, { stopped: false });
  }

  // --- shutdown: close the UI and stop the core process ---
  // Closing the browser tab alone leaves the node process and the mihomo core
  // running, so expose an explicit way to shut everything down.
  if (p === '/shutdown' && method === 'POST') {
    pushLog('收到关闭请求，正在退出…');
    broadcast('shutdown', { reason: 'user' });
    json(res, 200, { shuttingDown: true });
    // Let the response flush before tearing down the listener.
    setTimeout(() => { void shutdownGracefully('api'); }, 250);
    return undefined;
  }

  // --- stop just the core (force path for stop.sh when /shutdown is unusable) ---
  if (p === '/stop-core' && method === 'POST') {
    try {
      if (state.core) await state.core.stop();
      state.portMap = new Map();
      pushLog('已通过接口停止内核');
      return json(res, 200, { stopped: true });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (p === '/results' && method === 'GET') {
    const snap = summarizeResults();
    const filters = Object.fromEntries(url.searchParams.entries());
    const numeric = {};
    for (const k of ['maxLatencyMs', 'minDownloadMBs', 'minUploadMBs', 'maxPacketLoss']) {
      if (filters[k] !== undefined) numeric[k] = Number(filters[k]) || 0;
    }
    for (const k of ['onlyWorking', 'nameRegex', 'excludeRegex']) {
      if (filters[k] !== undefined) numeric[k] = filters[k];
    }
    if (filters.requireUnlock !== undefined) {
      numeric.requireUnlock = String(filters.requireUnlock).split(',').filter(Boolean);
    }
    const filtered = applyFilters(snap.results, numeric);
    return json(res, 200, { ...snap, filtered, filters: numeric });
  }

  // --- unlock services catalogue ---
  if (p === '/unlock/services' && method === 'GET') {
    return json(res, 200, {
      services: UNLOCK_SERVICES.map((s) => ({ id: s.id, name: s.name })),
    });
  }

  // --- export ---
  if (p === '/export/preview' && method === 'POST') {
    try {
      const body = await readBody(req);
      const snap = summarizeResults();
      const filters = body.filters || {};
      const selected = Array.isArray(body.selected) && body.selected.length
        ? snap.results.filter((r) => body.selected.includes(r.name))
        : applyFilters(snap.results, filters);

      if (!selected.length) {
        return json(res, 400, { error: '没有符合筛选条件的节点，未生成配置' });
      }

      const proxyMap = new Map(state.proxies.map((x) => [x.name, x]));
      const content = buildExportConfig(selected, {
        proxies: proxyMap,
        groupName: body.groupName || '🚀 节点选择',
        rename: !!body.rename,
        template: body.template || null,
        includeAutoGroups: body.includeAutoGroups !== false,
        originalDoc: state.rawDoc,
        keepOriginalRules: body.keepOriginalRules !== false,
      });
      return json(res, 200, { content, count: selected.length });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (p === '/export/save' && method === 'POST') {
    try {
      const body = await readBody(req);
      const snap = summarizeResults();
      const filters = body.filters || {};
      const selected = Array.isArray(body.selected) && body.selected.length
        ? snap.results.filter((r) => body.selected.includes(r.name))
        : applyFilters(snap.results, filters);

      if (!selected.length) {
        return json(res, 400, { error: '没有符合筛选条件的节点，已取消写入（保护已有文件）' });
      }

      const proxyMap = new Map(state.proxies.map((x) => [x.name, x]));
      const content = buildExportConfig(selected, {
        proxies: proxyMap,
        groupName: body.groupName || '🚀 节点选择',
        rename: !!body.rename,
        template: body.template || null,
        includeAutoGroups: body.includeAutoGroups !== false,
        originalDoc: state.rawDoc,
        keepOriginalRules: body.keepOriginalRules !== false,
      });

      const dir = body.dir ? path.resolve(String(body.dir)) : process.cwd();
      const fileName = body.fileName
        ? `${String(body.fileName).replace(/\.ya?ml$/i, '')}.yaml`
        : defaultExportName();
      const saved = await writeExport(path.join(dir, fileName), content);
      pushLog(`已导出 ${selected.length} 个节点 -> ${saved}`);
      return json(res, 200, { path: saved, count: selected.length });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (p === '/export/download' && method === 'POST') {
    try {
      const body = await readBody(req);
      const snap = summarizeResults();
      const selected = Array.isArray(body.selected) && body.selected.length
        ? snap.results.filter((r) => body.selected.includes(r.name))
        : applyFilters(snap.results, body.filters || {});

      if (!selected.length) return json(res, 400, { error: '没有可导出的节点' });

      const proxyMap = new Map(state.proxies.map((x) => [x.name, x]));
      const content = buildExportConfig(selected, {
        proxies: proxyMap,
        groupName: body.groupName || '🚀 节点选择',
        rename: !!body.rename,
        template: body.template || null,
        includeAutoGroups: body.includeAutoGroups !== false,
        originalDoc: state.rawDoc,
        keepOriginalRules: body.keepOriginalRules !== false,
      });

      const fileName = body.fileName
        ? `${String(body.fileName).replace(/\.ya?ml$/i, '')}.yaml`
        : defaultExportName();
      const buf = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/x-yaml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'Content-Length': buf.length,
      });
      res.end(buf);
      return undefined;
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (p === '/core/stop' && method === 'POST') {
    if (state.core) await state.core.stop();
    pushLog('内核已停止');
    return json(res, 200, { stopped: true });
  }

  if (p === '/logs' && method === 'GET') {
    return json(res, 200, {
      logs: state.logs.slice(-200),
      coreLogs: state.core ? state.core.getLogs().slice(-100) : [],
    });
  }

  return json(res, 404, { error: `未知接口: ${p}` });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  // SSE stream
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);

    const snap = summarizeResults();
    res.write(`event: progress\ndata: ${JSON.stringify(snap)}\n\n`);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);

    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err.message });
      else try { res.end(); } catch { /* ignore */ }
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

/**
 * Open the UI in the user's browser.
 *
 * `cmd /c start` only works when a browser is registered as the URL handler.
 * On machines where the default-browser association points at a stub (or a
 * portable browser is installed to a custom path), it silently does nothing.
 * So common browser locations and the registry App Paths are tried first, and
 * the shell handler is the last resort.
 */
function browserCandidates() {
  if (process.platform !== 'win32') return [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const out = [];

  // Registry App Paths covers portable/custom install locations.
  try {
    for (const key of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe']) {
      for (const hive of ['HKLM', 'HKCU']) {
        try {
          const v = execFileSync(
            'reg',
            ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${key}`, '/ve'],
            { encoding: 'utf8', windowsHide: true, timeout: 4000 }
          );
          const m = /REG_SZ\s+(.+\.exe)/i.exec(v);
          if (m && m[1].trim()) out.push(m[1].trim().replace(/^"|"$/g, ''));
        } catch { /* key absent */ }
      }
    }
  } catch { /* ignore */ }

  out.push(
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    local && `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
    'D:\\System_Tools\\Chrome\\App\\chrome.exe'
  );

  return out.filter(Boolean);
}

/**
 * Resolve an executable the way a shell would: an absolute/relative path if it
 * contains a separator, otherwise a PATH lookup. Returns the path or null.
 */
function whichSync(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/') || cmd.includes('\\')) {
    try { return fsSync.accessSync(cmd, fsSync.constants.X_OK) === undefined ? cmd : null; } catch { return null; }
  }
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE').split(';')
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext.toLowerCase());
      try {
        fsSync.accessSync(full, fsSync.constants.X_OK);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      for (const exe of browserCandidates()) {
        try {
          if (!fsSync.existsSync(exe)) continue;
          spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          return true;
        } catch { /* try the next one */ }
      }
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }

    // Linux/BSD.
    //
    // `spawn` reports ENOENT asynchronously, so an earlier version that simply
    // fired xdg-open and returned true claimed success even on a headless box
    // or a container with no xdg-utils. Check first, then report honestly.
    const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (!hasDisplay) return false;

    // $BROWSER takes precedence when it names a runnable program. (xdg-open
    // honours $BROWSER itself, but checking here lets a broken value fall
    // through to xdg-open instead of failing silently.)
    const browserEnv = (process.env.BROWSER || '').trim();
    if (browserEnv) {
      const [cmd, ...args] = browserEnv.split(/\s+/);
      if (cmd && whichSync(cmd)) {
        spawn(cmd, [...args, url], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
    }

    const opener = whichSync('xdg-open');
    if (!opener) return false;
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function startServer(opts = {}) {
  const port = Number(opts.port || process.env.NODEPILOT_PORT || 8765);
  const host = opts.host || '127.0.0.1';

  // Auto-detect the core at startup so the UI has something to show.
  try {
    const found = await findCore(opts.corePath);
    if (found.path) {
      state.coreInfo = { path: found.path, version: found.version };
      state.core = new CoreManager({ binPath: found.path });
    } else {
      state.coreError = '未找到 mihomo 核心，请在界面中指定路径';
    }
  } catch (err) {
    state.coreError = err.message;
  }

  // Write the PID file *inside* the listen callback, before resolving.
  //
  // The server starts accepting connections as soon as listen succeeds, so
  // writing this after an `await` left a window where a client could already
  // get an HTTP response while the PID file did not exist yet. Tests read the
  // file right after polling /api/status and intermittently saw null on loaded
  // CI runners, where the event loop delay widens that window; on a fast local
  // machine it never showed up. Recording it before any request can be served
  // removes the race entirely.
  let recorded = null;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const boundPort = server.address().port;
      const boundUrl = `http://${host}:${boundPort}`;

      // Record how to find this instance again after the browser tab is closed,
      // so stop.sh can shut it down cooperatively instead of scanning for
      // processes. Failing to write it is not fatal to serving requests.
      try {
        writePidFile(defaultBaseDir(), {
          serverPid: process.pid,
          port: boundPort,
          host,
          url: boundUrl,
          platform: process.platform,
        });
      } catch { /* non-fatal */ }

      recorded = { port: boundPort, url: boundUrl };
      resolve();
    });
  });

  return { url: recorded.url, port: recorded.port, server };
}

/**
 * Stop the speed test, kill the mihomo core and close the HTTP server.
 * Safe to call more than once.
 */
let shuttingDown = false;
async function shutdownGracefully(reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n正在关闭 (${reason})...`);
  try { state.engine?.stop(); } catch { /* ignore */ }

  // Always kill the core: it is a child process that would otherwise linger.
  try {
    if (state.core) await state.core.stop();
    console.log('  已停止 mihomo 内核');
  } catch (err) {
    console.log(`  停止内核时出错: ${err.message}`);
  }

  await new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1200);
  });

  removePidFile(defaultBaseDir());
  console.log('  已退出');
  process.exit(0);
}

// Run directly: `node src/server.mjs`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const wantOpen = process.argv.includes('--open');
  startServer()
    .then(({ url }) => {
      console.log('');
      console.log('  ⚡ clash-nodepilot 已启动');
      console.log(`  ➜  ${url}`);
      console.log('');
      console.log('  结束运行：点界面右上角「⏻ 关闭」，或在此终端按 Ctrl+C');
      console.log('');
      if (wantOpen && !openBrowser(url)) {
        // Say so instead of leaving the user waiting for a window that never
        // appears (headless shell, missing xdg-utils, no DISPLAY).
        console.log('  ⚠️ 未能自动打开浏览器，请手动访问上面的地址');
        console.log('');
      }
    })
    .catch((err) => {
      console.error('启动失败:', err.message);
      process.exit(1);
    });

  process.on('SIGINT', () => void shutdownGracefully('Ctrl+C'));
  process.on('SIGTERM', () => void shutdownGracefully('SIGTERM'));

  // If the parent shell dies unexpectedly, do not leave the core orphaned.
  process.on('uncaughtException', (err) => {
    console.error('未捕获异常:', err);
    void shutdownGracefully('uncaughtException');
  });
}
