// Cross-platform process inspection and identification.
//
// Why this exists: this tool spawns a mihomo core as a child process, and the
// README promises that stopping the tool never touches the user's own Clash
// Verge core. Identifying "our" core therefore has to be precise, and it has to
// work on both Windows and Linux without a shell.
//
// Three layers, safest first (see stopCore / findOurCore):
//   1. the HTTP /api/shutdown endpoint      - cooperative, cannot hit anything else
//   2. the PID file written at startup      - exact, verified before it is trusted
//   3. a cmdline scan for our own work dir  - last resort when 1 and 2 are gone
import fs from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** Strip internal bookkeeping fields so a path compares as a plain path. */
const norm = (p) => path.resolve(String(p || ''));

/** A PID file records both the pid and the work dir it belongs to. */
export function pidFilePath(baseDir) {
  return path.join(baseDir, 'nodepilot.pid');
}

/**
 * Write (merge into) the PID file. Records the work dir as well, so a reader can
 * reject a stale file that was recycled onto an unrelated process — the same PID
 * being reused is rare but not impossible, and killing the wrong process is not
 * a mistake worth tolerating to save a few lines.
 *
 * @param {string} baseDir
 * @param {object} patch e.g. { serverPid, port } or { corePid, workDir }
 */
export function writePidFile(baseDir, patch) {
  try {
    fsSync.mkdirSync(baseDir, { recursive: true });
    const prev = readPidFile(baseDir) || {};
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    if (!next.startedAt) next.startedAt = next.updatedAt;
    fsSync.writeFileSync(pidFilePath(baseDir), JSON.stringify(next, null, 1), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the PID file, but only for the fields this process actually owns.
 *
 * Two callers share one record: the server owns `serverPid`/`port`/`host`/`url`,
 * and the core owns `corePid`/`workDir`. Two failure modes follow from ignoring
 * that, and both were observed on CI:
 *
 *  - an unconditional `rm` from either side destroys the other's half. A test
 *    helper that started a server on the shared default port removed the record
 *    a *different, still-running* instance had just written, so that instance
 *    appeared to have recorded no core at all;
 *  - two concurrent instances share the path, so the one exiting later can
 *    erase the other's live record entirely.
 *
 * Ownership is checked against the recorded value: a process only ever clears
 * fields whose value is its own pid. Anything not ours is left untouched, and
 * the file is deleted only once no live owner remains recorded.
 *
 * @param {string} baseDir
 * @param {object} opts
 * @param {number} [opts.serverPid] clear server fields, but only if they are ours
 * @param {number} [opts.corePid]   clear core fields, but only if they are ours
 */
export function clearPidFile(baseDir, { serverPid, corePid } = {}) {
  const file = pidFilePath(baseDir);
  try {
    const cur = readPidFile(baseDir);
    if (!cur) return;

    if (serverPid !== undefined && cur.serverPid === serverPid) {
      delete cur.serverPid;
      delete cur.port;
      delete cur.host;
      delete cur.url;
      delete cur.platform;
    }
    if (corePid !== undefined && cur.corePid === corePid) {
      delete cur.corePid;
      delete cur.workDir;
    }

    // Keep the file while any owner is still recorded, otherwise drop it.
    if (cur.serverPid === undefined && cur.corePid === undefined) {
      fsSync.rmSync(file, { force: true });
      return;
    }
    fsSync.writeFileSync(file, JSON.stringify(cur, null, 1), 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * Delete the PID file outright.
 *
 * Only for deliberate, whole-instance teardown paths (an explicit stop that has
 * already ensured nothing else is running). Prefer clearPidFile() in normal
 * shutdown, so a concurrently running instance does not lose its record.
 */
export function removePidFile(baseDir) {
  try {
    fsSync.rmSync(pidFilePath(baseDir), { force: true });
  } catch {
    /* ignore */
  }
}

export function readPidFile(baseDir) {
  try {
    const raw = fsSync.readFileSync(pidFilePath(baseDir), 'utf8');
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    return data;
  } catch {
    return null;
  }
}

/** True when the pid exists and is signalable by us. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user: still "alive", but we
    // must not assume we can kill it.
    return err.code === 'EPERM';
  }
}

/**
 * Command line of a pid, or null when it cannot be determined.
 *
 * Linux reads /proc. Windows asks CIM through PowerShell; that call costs about
 * a second, so code inspecting many pids should use scanProcesses(), which
 * resolves the whole list in one query instead.
 */
export function readCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isLinux) {
    try {
      // /proc/<pid>/cmdline is NUL-separated with a trailing NUL.
      const raw = fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.split('\0').filter(Boolean).join(' ') || null;
    } catch {
      return null;
    }
  }
  if (isWin) {
    try {
      const ps =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";` +
        'if ($p -and $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }';
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
      }).trim();
      return raw || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Split a command line into tokens, honouring double quotes.
 *
 * Needed because Windows paths contain spaces (`C:\Program Files\...`), and the
 * naive `split(' ')` would cut `-d "C:\...\nodepilot\core"` into pieces and miss
 * the match. Quotes are stripped from the resulting token.
 */
export function splitCmdline(cmd) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (const ch of String(cmd || '')) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Does this pid look like the mihomo core *we* started?
 *
 * The discriminator is our work dir. The core is always launched as
 * `mihomo -d <workDir>`, and <workDir> lives under this tool's own base dir, so
 * a user's Clash Verge core (launched with its own -d) can never match. This is
 * the property that keeps "stop the tool" from becoming "stop the user's proxy".
 */
export function isOurCore(pid, workDir) {
  if (!pidAlive(pid)) return false;
  const cmd = readCmdline(pid);
  if (!cmd) return false;
  const want = norm(workDir);
  const argv = splitCmdline(cmd);
  for (let i = 0; i < argv.length; i++) {
    // Match `-d <dir>`, `--dir <dir>` and `-d=<dir>` forms.
    let candidate = null;
    if (argv[i] === '-d' || argv[i] === '--dir' || argv[i] === '-config-dir') {
      candidate = argv[i + 1];
    } else if (argv[i].startsWith('-d=')) {
      candidate = argv[i].slice(3);
    }
    if (candidate && norm(candidate) === want) return true;
  }
  return false;
}

/**
 * Enumerate processes whose command line contains `needle`.
 * Linux: /proc. Windows: CIM (kept for parity with the existing test).
 * @returns {Array<{pid:number, cmd:string}>}
 */
export function scanProcesses(needle) {
  const out = [];
  if (isLinux) {
    let entries;
    try {
      entries = fsSync.readdirSync('/proc');
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      const cmd = readCmdline(pid);
      if (cmd && cmd.includes(needle)) out.push({ pid, cmd });
    }
    return out;
  }

  if (isWin) {
    try {
      // Single CIM query; filtering in JS keeps the PowerShell quoting simple.
      const ps =
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -ne $null } | " +
        'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
      const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      });
      for (const line of raw.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const pid = Number(line.slice(0, tab));
        const cmd = line.slice(tab + 1);
        if (Number.isInteger(pid) && cmd.includes(needle)) out.push({ pid, cmd });
      }
    } catch {
      /* powershell unavailable */
    }
  }
  return out;
}

/**
 * Find the mihomo core this tool started, by work dir.
 * Used as the last-resort kill path when neither HTTP nor the PID file is usable.
 */
export function findOurCore(workDir) {
  const want = norm(workDir);
  const hits = [];
  if (isLinux) {
    for (const { pid, cmd } of scanProcesses(want)) {
      // Require the mihomo binary name too, so an unrelated `grep <workDir>`
      // cannot be mistaken for the core.
      if (/(^|\/|\\)(mihomo|clash|clash-meta|verge-mihomo)(-alpha)?(\s|$)/.test(cmd)) {
        hits.push({ pid, cmd });
      }
    }
  } else if (isWin) {
    for (const { pid, cmd } of scanProcesses(want)) {
      if (/verge-mihomo|mihomo|clash-meta|clash/i.test(cmd)) hits.push({ pid, cmd });
    }
  }
  return hits;
}

/** Terminate a pid, escalating from TERM to KILL on POSIX. */
export async function killPid(pid, { graceMs = 1500, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!pidAlive(pid)) return true;
  if (isWin) {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      return false;
    }
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await wait(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  await wait(200);
  return !pidAlive(pid);
}

/** Default base dir shared by the server and the stop scripts. */
export function defaultBaseDir() {
  return path.join(os.tmpdir(), 'nodepilot');
}
