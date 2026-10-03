// Locate a usable mihomo/clash-meta core binary on the host.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';

/** Candidate file names, most-preferred first. */
const CANDIDATE_NAMES = [
  `mihomo${EXE}`,
  `verge-mihomo${EXE}`,
  `verge-mihomo-alpha${EXE}`,
  `clash-meta${EXE}`,
  `clash${EXE}`,
  `mihomo-windows-amd64${EXE}`,
];

/**
 * XDG data dir Clash Verge Rev uses on Linux. It holds the running core's
 * control socket (`verge-mihomo.sock`) rather than a second copy of the binary,
 * but the directory is still scanned: a user who unpacks a release into it gets
 * picked up, and a socket can never match a candidate name.
 */
const VERGE_REV_DATA = 'io.github.clash-verge-rev.clash-verge-rev';

/**
 * Turn an execFile failure code into an actionable, platform-accurate hint.
 *
 * The common Linux failure is a manually downloaded release whose executable
 * bit was lost (unzip/gzip does not always preserve it, and `curl -O` never
 * sets it), which surfaces as EACCES. Reporting "not a valid core" for that
 * sends the user in circles; naming the exact fix does not.
 */
export function coreFailureHint(code, binPath) {
  switch (code) {
    case 'EACCES':
      return isWin
        ? `文件存在但无法执行（权限不足）: ${binPath}`
        : `文件存在但没有可执行权限: ${binPath}\n修复: chmod +x ${binPath}`;
    case 'ENOEXEC':
      return `文件不是可执行程序（可能下载的是压缩包，或 CPU 架构不匹配）: ${binPath}`;
    case 'EPARSE':
      return `文件能运行但不像 mihomo 内核（-v 未正常输出版本，可能下错文件或架构不匹配）: ${binPath}`;
    case 'ENOENT':
      return `文件不存在: ${binPath}`;
    case 'ETIMEDOUT':
      return `执行超时，文件可能挂起: ${binPath}`;
    default:
      // 127 is the shell's "command not found" after Linux's execvp fallback to
      // /bin/sh for a shebang-less file; 126 is "found but not executable".
      if (code === 127) return `文件不是有效的 mihomo 内核（执行失败）: ${binPath}`;
      if (code === 126) return `文件无法执行，请检查权限与架构: ${binPath}`;
      if (code) return `内核启动失败（退出码 ${code}）: ${binPath}`;
      return `无法执行: ${binPath}`;
  }
}

/** Directories worth scanning for an existing core. */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [
    process.env.NODEPILOT_CORE_DIR,
    process.cwd(),
    path.join(process.cwd(), 'bin'),
    path.join(process.cwd(), 'core'),
    path.join(process.cwd(), '..'),
  ].filter(Boolean);

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    dirs.push(
      path.join(localAppData, 'Programs'),
      appData,
      path.join(programFiles, 'Clash Verge'),
      path.join(programFilesX86, 'Clash Verge'),
      // Clash Verge Rev installs next to its resources folder.
      path.join(localAppData, 'Programs', 'Clash Verge'),
      path.join(localAppData, 'Programs', 'clash-verge'),
      path.join(home, 'scoop', 'apps'),
      'D:\\User_Tools\\Clash Verge',
      'C:\\User_Tools\\Clash Verge'
    );
  } else {
    // Linux / BSD paths verified against real installs:
    //  - Fedora's `clash-meta` rpm drops /usr/bin/mihomo and /usr/bin/clash-meta
    //  - Arch/AUR `mihomo` does the same; manual installs land in /usr/local/bin
    //  - Clash Verge Rev's .deb/.rpm ships /usr/bin/verge-mihomo
    //  - a `tar -xzf` into the data dir is a common manual install
    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/opt/mihomo',
      '/opt/homebrew/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(xdgData, VERGE_REV_DATA),
      path.join(home, '.config', 'clash-verge')
    );
  }
  return [...new Set(dirs)];
}

/** Recursively look for candidate names, bounded in depth and breadth. */
function scanDir(dir, depth, out, seen) {
  if (depth < 0 || out.length > 40) return;
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && CANDIDATE_NAMES.includes(entry.name)) {
      out.push(full);
    }
  }
  if (depth === 0) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    scanDir(path.join(dir, entry.name), depth - 1, out, seen);
  }
}

function runVersion(binPath, failure) {
  return new Promise((resolve) => {
    execFile(binPath, ['-v'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim();
      if (err) {
        // A non-zero exit means this is not a working core, even if it printed
        // something. This matters on Linux specifically: execvp falls back to
        // /bin/sh for a file with no shebang, so an arbitrary text file marked
        // executable "runs" and echoes a shell error ("line 1: not: command not
        // found") while exiting 127. Treating any output as success let such a
        // file masquerade as a core. A real mihomo exits 0 for `-v`.
        if (failure && (err.code || !text)) failure.code = err.code || 'EPARSE';
        else if (failure && text) failure.code = 'EPARSE';
        return resolve(null);
      }
      resolve(text || null);
    });
  });
}

/**
 * Find a core binary and confirm it actually runs.
 * @param {string} [explicit] user-specified path, takes precedence
 */
export async function findCore(explicit) {
  const tried = [];
  const ordered = [];

  if (explicit) ordered.push(explicit);

  const envCore = process.env.NODEPILOT_CORE;
  if (envCore) ordered.push(envCore);

  // Rank candidates by filename preference so a stable core wins over an alpha
  // build when both live in the same directory.
  const rank = (p) => {
    const base = path.basename(p).toLowerCase();
    const i = CANDIDATE_NAMES.findIndex((n) => n.toLowerCase() === base);
    return i === -1 ? CANDIDATE_NAMES.length : i;
  };

  for (const dir of candidateDirs()) {
    const found = [];
    scanDir(dir, 3, found, new Set());
    found.sort((a, b) => rank(a) - rank(b));
    ordered.push(...found);
  }

  // PATH lookup as a last resort.
  const pathExt = isWin ? (process.env.PATHEXT || '.EXE').split(';') : [''];
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue;
    for (const ext of pathExt) {
      for (const name of CANDIDATE_NAMES) {
        ordered.push(path.join(p, name.endsWith(ext.toLowerCase()) ? name : name + ext.toLowerCase()));
      }
    }
  }

  const seen = new Set();
  for (const candidate of ordered) {
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }

    const failure = {};
    const version = await runVersion(candidate, failure);
    tried.push({
      path: candidate,
      version,
      code: failure.code || null,
      hint: version ? null : coreFailureHint(failure.code, candidate),
    });
    if (version) {
      return { path: candidate, version };
    }
  }

  return { path: null, version: null, tried };
}

/** Verify a specific binary path works. */
export async function verifyCore(binPath) {
  const failure = {};
  const version = await runVersion(binPath, failure);
  return version ? { path: binPath, version } : null;
}

/** Verify a path and, on failure, explain precisely why. */
export async function verifyCoreDetailed(binPath) {
  const failure = {};
  const version = await runVersion(binPath, failure);
  if (version) return { path: binPath, version };
  return { path: null, version: null, code: failure.code || null, hint: coreFailureHint(failure.code, binPath) };
}
