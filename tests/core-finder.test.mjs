// Unit tests for core discovery on Linux/Windows: candidate paths, and the
// precise reasons a candidate is rejected.
//
// These exist because the Linux path list and the "exists but not executable"
// hint are the parts a user hits first, and neither can be exercised by the
// existing end-to-end tests (which only ever see a working core).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findCore,
  verifyCore,
  verifyCoreDetailed,
  coreFailureHint,
  linuxCandidateDirs,
  CANDIDATE_NAMES,
} from '../src/core/core-finder.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};

const IS_WIN = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-finder-'));
const mk = (name, content, mode) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
};

// --- 1. Non-executable file must report EACCES (and a chmod hint on POSIX) ---
if (!IS_WIN) {
  const noexec = mk('mihomo-noexec', '#!/bin/sh\necho hi\n', 0o644);
  const r = await verifyCoreDetailed(noexec);
  check('不可执行文件被拒绝', r.path === null && r.version === null, JSON.stringify(r));
  check('不可执行文件报 EACCES', r.code === 'EACCES', `code=${r.code}`);
  check('不可执行文件提示 chmod +x', /chmod \+x/.test(r.hint || ''), r.hint);
  check('verifyCore 对不可执行文件返回 null', (await verifyCore(noexec)) === null);
} else {
  // Windows has no executable bit; the concept does not apply there.
  check('Windows 跳过可执行位用例', true);
}

// --- 2. A shebang-less text file "runs" via execvp's /bin/sh fallback on Linux.
//    It must NOT be accepted as a core (regression: output-only check accepted it).
if (!IS_WIN) {
  const garbage = mk('mihomo-garbage', 'not an executable at all\n', 0o755);
  const r = await verifyCoreDetailed(garbage);
  check('无 shebang 的垃圾文件被拒绝', r.path === null, JSON.stringify(r));
  check('垃圾文件给出可读原因', typeof r.hint === 'string' && r.hint.length > 0, r.hint);
}

// --- 3. Missing file reports ENOENT with the path ---
{
  const missing = path.join(tmp, 'definitely-not-here');
  const r = await verifyCoreDetailed(missing);
  check('缺失文件报 ENOENT', r.code === 'ENOENT', `code=${r.code}`);
  check('缺失文件提示包含路径', (r.hint || '').includes('definitely-not-here'), r.hint);
}

// --- 4. A working script with a shebang IS accepted (the detector is not so
//    strict that it rejects a valid wrapper). ---
if (!IS_WIN) {
  const good = mk('mihomo-good', '#!/bin/sh\necho "Mihomo Meta v0.0.0 test"\n', 0o755);
  const r = await verifyCoreDetailed(good);
  check('带 shebang 的可执行脚本被接受', r.path === good, JSON.stringify(r));
}

// --- 5. coreFailureHint covers the documented codes ---
check('coreFailureHint(EACCES) 非空', coreFailureHint('EACCES', '/x').length > 0);
check('coreFailureHint(ENOEXEC) 非空', coreFailureHint('ENOEXEC', '/x').length > 0);
check('coreFailureHint(ENOENT) 含路径', coreFailureHint('ENOENT', '/x/y').includes('/x/y'));
check('coreFailureHint(未知码) 有兜底', coreFailureHint('EWHATEVER', '/x').length > 0);

// --- 6. Candidate names and Linux dirs: the Linux list must contain the paths
//    that real installers use, and must NOT contain non-existent packaging
//    formats (Clash Verge Rev ships no Flatpak/Snap/AppImage).
if (!IS_WIN) {
  const dirs = linuxCandidateDirs();
  check('候选目录含 /usr/bin', dirs.includes('/usr/bin'), dirs.join(','));
  check('候选目录含 /usr/local/bin', dirs.includes('/usr/local/bin'), dirs.join(','));
  check('候选目录含 /usr/bin 的兄弟 /opt/mihomo', dirs.includes('/opt/mihomo'), dirs.join(','));
  check('候选目录含 XDG 数据目录下的 Verge Rev',
    dirs.some((d) => d.includes('io.github.clash-verge-rev.clash-verge-rev')), dirs.join(','));
  check('不包含不存在的 Flatpak 路径',
    !dirs.some((d) => d.includes('/.var/app/')), dirs.join(','));

  const names = CANDIDATE_NAMES.join(',');
  for (const expected of ['mihomo', 'clash-meta', 'clash', 'verge-mihomo', 'verge-mihomo-alpha']) {
    check(`候选名单包含 ${expected}`, names.includes(expected), names);
  }
}

// --- 7. findCore finds the real core on this machine (when one exists). ---
{
  const found = await findCore();
  if (found.path) {
    check('findCore 找到可运行内核', typeof found.version === 'string' && found.version.length > 0,
      JSON.stringify(found));
    check('findCore 返回值包含路径', fs.existsSync(found.path), found.path);
  } else {
    // No core installed is a legitimate environment state, not a failure.
    console.log('SKIP  findCore: 本机未安装 mihomo 内核');
    check('findCore 未找到时给出尝试记录', Array.isArray(found.tried), JSON.stringify(found));
  }
}

// --- 8. An explicit valid path takes precedence over auto-detection, and an
//    explicit invalid one falls back to auto-detection (it is a preference,
//    not an exclusive filter — this is what /core/detect relies on). ---
{
  if (!IS_WIN) {
    const preferred = mk('mihomo-preferred', '#!/bin/sh\necho "Mihomo Meta v9.9.9 preferred"\n', 0o755);
    const r = await findCore(preferred);
    check('显式指定有效路径时优先使用', r.path === preferred, JSON.stringify(r));
    check('显式指定时采用该文件的版本', /v9\.9\.9/.test(r.version || ''), r.version);
  } else {
    check('Windows 跳过显式路径优先用例', true);
  }

  const bogus = await findCore(path.join(tmp, 'nope-explicit'));
  check('显式指定无效路径时回退自动探测（不崩溃）',
    bogus.path === null || fs.existsSync(bogus.path), JSON.stringify(bogus));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures} failed`);
console.log('CORE_FINDER_TEST_DONE');
process.exit(failures ? 1 : 0);
