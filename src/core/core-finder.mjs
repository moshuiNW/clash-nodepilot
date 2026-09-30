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
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
      path.join(home, '.local', 'bin'),
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

function runVersion(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['-v'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      const text = `${stdout || ''}${stderr || ''}`.trim();
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

    const version = await runVersion(candidate);
    tried.push({ path: candidate, version });
    if (version) {
      return { path: candidate, version };
    }
  }

  return { path: null, version: null, tried };
}

/** Verify a specific binary path works. */
export async function verifyCore(binPath) {
  const version = await runVersion(binPath);
  return version ? { path: binPath, version } : null;
}
