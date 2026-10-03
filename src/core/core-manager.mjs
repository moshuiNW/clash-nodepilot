// Manage a mihomo core process: generate config, launch, expose per-node ports.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import yaml from 'js-yaml';
import { sleep } from './util.mjs';
import { writePidFile, clearPidFile } from './proc.mjs';

const isWin = process.platform === 'win32';

/** Grab a free TCP port by binding to port 0. */
export function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Reserve N distinct free ports. */
export async function getFreePorts(count) {
  const ports = new Set();
  const servers = [];
  for (let i = 0; i < count; i++) {
    const srv = net.createServer();
    await new Promise((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', res);
    });
    ports.add(srv.address().port);
    servers.push(srv);
  }
  await Promise.all(
    servers.map((s) => new Promise((r) => s.close(r)))
  );
  return [...ports];
}

async function isPortOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

export class CoreManager {
  constructor(opts = {}) {
    this.binPath = opts.binPath;
    this.baseDir = opts.baseDir || path.join(os.tmpdir(), 'nodepilot');
    this.workDir = path.join(this.baseDir, 'core');
    this.proc = null;
    this.logLines = [];
    this.maxLogLines = 400;
    this.apiPort = null;
    this.mixedPort = null;
    this.started = false;
    /** Pid of the most recently spawned core, for ownership-checked cleanup. */
    this.lastCorePid = undefined;
  }

  log(line) {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logLines.push(stamped);
    if (this.logLines.length > this.maxLogLines) this.logLines.shift();
  }

  getLogs() {
    return [...this.logLines];
  }

  /**
   * Start the core with listeners bound one-port-per-node.
   * @param {Array} proxies normalized proxy objects
   * @param {object} options
   * @returns {Promise<{portMap: Map<string, number>, apiPort: number, mixedPort: number}>}
   */
  async start(proxies, options = {}) {
    if (this.started) await this.stop();

    const { log = () => {} } = options;
    await fs.mkdir(this.workDir, { recursive: true });

    // Strip internal bookkeeping fields before handing proxies to mihomo.
    const cleanProxies = proxies.map((p) => {
      const c = { ...p };
      delete c.__origin;
      return c;
    });

    this.mixedPort = await getFreePort();
    this.apiPort = await getFreePort();
    const listenerPorts = await getFreePorts(cleanProxies.length);

    const portMap = new Map();
    const listeners = cleanProxies.map((proxy, i) => {
      const port = listenerPorts[i];
      portMap.set(proxy.name, port);
      return {
        name: `np-${i}`,
        type: 'mixed',
        port,
        listen: '127.0.0.1',
        udp: false,
        proxy: proxy.name,
      };
    });

    const config = {
      'mixed-port': this.mixedPort,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: false,
      'unified-delay': true,
      'tcp-concurrent': true,
      'external-controller': `127.0.0.1:${this.apiPort}`,
      'external-ui': '',
      profile: { 'store-selected': false, 'store-fake-ip': false },
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
        'use-hosts': false,
      },
      proxies: cleanProxies,
      listeners,
      // Everything not caught by a rule goes direct; listeners override anyway.
      rules: ['MATCH,DIRECT'],
    };

    const configPath = path.join(this.workDir, 'config.yaml');
    await fs.writeFile(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');

    // Clear stale files from a previous run so we can detect freshness.
    for (const f of ['core.log']) {
      try { await fs.rm(path.join(this.workDir, f)); } catch { /* ignore */ }
    }

    const logPath = path.join(this.workDir, 'core.log');
    const logStream = fsSync.createWriteStream(logPath, { flags: 'a' });

    this.proc = spawn(this.binPath, ['-d', this.workDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Record the core pid next to this tool's work dir. The stop path verifies
    // the pid still points at *this* work dir before signalling, so a recycled
    // pid can never lead to killing an unrelated process (e.g. the user's own
    // Clash Verge core).
    if (this.proc.pid) {
      this.lastCorePid = this.proc.pid;
      writePidFile(this.baseDir, { corePid: this.proc.pid, workDir: this.workDir });
    }

    const onChunk = (buf) => {
      const text = buf.toString();
      logStream.write(text);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.log(line.trim());
      }
    };
    this.proc.stdout.on('data', onChunk);
    this.proc.stderr.on('data', onChunk);

    this.proc.on('exit', (code, signal) => {
      this.started = false;
      this.log(`core exited code=${code} signal=${signal}`);
    });

    this.started = true;

    // Wait for the API port to accept connections.
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await isPortOpen(this.apiPort)) {
        ready = true;
        break;
      }
      if (this.proc.exitCode !== null) {
        throw new Error(
          `mihomo 启动即退出 (code=${this.proc.exitCode})。日志:\n${this.getLogs().slice(-12).join('\n')}`
        );
      }
      await sleep(200);
    }
    if (!ready) {
      throw new Error(`mihomo API 端口未就绪 (${this.apiPort})。日志:\n${this.getLogs().slice(-12).join('\n')}`);
    }

    // Validate that every listener port is actually bound.
    const bound = new Set();
    const bindDeadline = Date.now() + 8000;
    while (Date.now() < bindDeadline) {
      for (const [name, port] of portMap) {
        if (!bound.has(name) && (await isPortOpen(port))) bound.add(name);
      }
      if (bound.size === portMap.size) break;
      await sleep(150);
    }

    const missing = [...portMap.keys()].filter((n) => !bound.has(n));
    if (missing.length) {
      this.log(`警告: ${missing.length} 个监听端口未就绪`);
      for (const name of missing) portMap.delete(name);
    }

    log(`内核已启动: API ${this.apiPort}, 可用节点端口 ${portMap.size}/${cleanProxies.length}`);

    return { portMap, apiPort: this.apiPort, mixedPort: this.mixedPort, logPath };
  }

  /** Query the core REST API. */
  async api(pathname, opts = {}) {
    const { method = 'GET', timeoutMs = 10000, body } = opts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${this.apiPort}${pathname}`, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
      }
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Measure latency via the core API. Returns {delay, error}.
   * Uses mihomo's own dialer so the measurement reflects real handshake cost.
   */
  async measureDelay(proxyName, testUrl, timeoutMs) {
    const qs = new URLSearchParams({
      timeout: String(timeoutMs),
      url: testUrl,
    });
    try {
      const data = await this.api(
        `/proxies/${encodeURIComponent(proxyName)}/delay?${qs}`,
        { timeoutMs: timeoutMs + 3000 }
      );
      if (data && Number.isFinite(data.delay)) return { delay: data.delay, error: null };
      return { delay: null, error: (data && data.message) || 'no delay' };
    } catch (err) {
      return { delay: null, error: err.message };
    }
  }

  /** Reload configuration in place (used when adding/removing listeners). */
  async reload(configPath) {
    return this.api('/configs?force=true', {
      method: 'PUT',
      body: { path: configPath },
    });
  }

  async stop() {
    if (!this.proc) {
      clearPidFile(this.baseDir, { corePid: this.lastCorePid });
      return;
    }
    const proc = this.proc;
    const pid = proc.pid;
    this.proc = null;
    try {
      if (isWin) {
        await new Promise((resolve) => {
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      } else {
        proc.kill('SIGTERM');
        await sleep(600);
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
    } catch {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.started = false;
    // Clear only our own fields: another instance may be recorded in the same
    // file, and its record must survive this one shutting down.
    clearPidFile(this.baseDir, { corePid: pid });
    this.lastCorePid = undefined;
  }
}
