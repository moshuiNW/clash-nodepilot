// Stop this tool: HTTP first, then a verified PID, then a work-dir scan.
//
// Shared by stop.sh (via `node src/core/stop.mjs`) and the test suite, so the
// exact behaviour the README promises is the behaviour that gets tested.
//
// Safety contract: this must never terminate the user's own Clash Verge core.
// The only processes considered are (a) the server we recorded in the PID file,
// and (b) cores whose command line points at *our* work dir. A user's Verge core
// satisfies neither.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultBaseDir, readPidFile, pidAlive, readCmdline, isOurCore, findOurCore, killPid, removePidFile } from './proc.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpShutdown(baseDir, { timeoutMs = 3000 } = {}) {
  const pid = readPidFile(baseDir);
  const port = pid?.port;
  const host = pid?.host || '127.0.0.1';
  if (!port) return { ok: false, reason: 'PID 文件中没有端口' };

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/api/shutdown`, {
      method: 'POST',
      signal: c.signal,
    });
    return { ok: res.ok, reason: res.ok ? '已发送关闭请求' : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? '请求超时' : err.message };
  } finally {
    clearTimeout(t);
  }
}

async function portFree(baseDir, { timeoutMs = 4000 } = {}) {
  const pid = readPidFile(baseDir);
  const port = pid?.port;
  if (!port) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 800);
    try {
      await fetch(`http://127.0.0.1:${port}/api/status`, { signal: c.signal });
      clearTimeout(t);
      await sleep(150);
    } catch {
      clearTimeout(t);
      return true;
    }
  }
  return false;
}

/**
 * Stop the tool.
 * @param {object} opts
 * @param {boolean} opts.force  skip straight to the PID/scan layers
 * @param {(msg:string)=>void} opts.log
 * @returns {Promise<{stopped:boolean, methods:string[], leftover:string[]}>}
 */
export async function stopAll({ force = false, baseDir = defaultBaseDir(), log = () => {} } = {}) {
  const methods = [];
  const before = readPidFile(baseDir) || {};

  // Layer 1: cooperative HTTP shutdown (also stops the core and clears state).
  if (!force) {
    const r = await httpShutdown(baseDir);
    if (r.ok) {
      methods.push('http');
      log(`已请求关闭: ${r.reason}`);
      if (await portFree(baseDir)) {
        removePidFile(baseDir);
        return { stopped: true, methods, leftover: [] };
      }
      log('HTTP 关闭后端口仍未释放，继续兜底…');
    } else {
      log(`HTTP 关闭不可用（${r.reason}），改用兜底方式`);
    }
  }

  // Layer 2: the recorded server PID, verified before it is trusted.
  if (Number.isInteger(before.serverPid) && pidAlive(before.serverPid)) {
    const cmd = readCmdline(before.serverPid);
    // Only kill it if it really is this tool's server, not a recycled pid.
    if (cmd && /server\.mjs/.test(cmd)) {
      log(`按 PID 停止服务进程 ${before.serverPid}`);
      await killPid(before.serverPid, { sleep });
      methods.push('pid');
    } else {
      log(`PID ${before.serverPid} 已不是本工具进程，忽略`);
    }
  }

  // Layer 3: any core still holding *our* work dir.
  const rawWorkDir = before.workDir || '';
  const coreHits = rawWorkDir ? findOurCore(rawWorkDir) : [];
  for (const hit of coreHits) {
    if (!isOurCore(hit.pid, rawWorkDir)) continue;
    log(`按工作目录停止残留内核 ${hit.pid}`);
    await killPid(hit.pid, { sleep });
    methods.push('scan');
  }

  const freed = await portFree(baseDir);
  const leftover = [];
  if (before.serverPid && pidAlive(before.serverPid)) leftover.push(`server:${before.serverPid}`);
  if (rawWorkDir) for (const hit of findOurCore(rawWorkDir)) leftover.push(`core:${hit.pid}`);

  if (freed && !leftover.length) removePidFile(baseDir);
  return { stopped: freed && !leftover.length, methods, leftover, port: before.port || null };
}

/** CLI entry used by stop.sh. */
export async function stopCli(argv = process.argv.slice(2)) {
  const force = argv.includes('--force');
  const quiet = argv.includes('--quiet');
  const log = (m) => { if (!quiet) console.log(`  ${m}`); };
  const baseDir = defaultBaseDir();

  console.log(force ? '强制停止 clash-nodepilot…' : '停止 clash-nodepilot…');

  const pid = readPidFile(baseDir);
  const looksIdle = !pid || !Number.isInteger(pid.serverPid) || !pidAlive(pid.serverPid);

  // Check "nothing is running" before the success branch: stopAll reports
  // stopped=true when nothing is left to kill, which would otherwise make an
  // idle stop look like a successful shutdown.
  if (looksIdle) {
    const stray = pid?.workDir ? findOurCore(pid.workDir).length : 0;
    if (!stray) {
      console.log('  服务未在运行');
      process.exitCode = 0;
      return { stopped: true, methods: [], leftover: [] };
    }
  }

  const result = await stopAll({ force, baseDir, log });

  if (result.stopped) {
    console.log('  ✅ 已停止，端口已释放');
    // exitCode (not exit) so stdout flushes when the output is a pipe.
    process.exitCode = 0;
    return result;
  }
  console.log('  ⚠️ 仍可能有残留进程:', result.leftover.join(', ') || '(未知)');
  process.exitCode = 1;
  return result;
}

// Run directly: `node src/core/stop.mjs [--force]`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  await stopCli();
}
