// Unit tests for process identification: the property that stops "stop the
// tool" from becoming "stop the user's proxy".
//
// The end-to-end shutdown test proves the happy path. This one pins the
// discriminating rule directly, including the negative cases that matter:
// a foreign core, a recycled pid, and a pid whose cmdline is unreadable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  pidAlive,
  readCmdline,
  isOurCore,
  findOurCore,
  splitCmdline,
  writePidFile,
  readPidFile,
  removePidFile,
  clearPidFile,
  pidFilePath,
  defaultBaseDir,
} from '../src/core/proc.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name} ${detail}`); failures++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_LINUX = process.platform === 'linux';

// --- pidAlive on our own process and on a nonsensical pid ---
check('pidAlive(自己的 pid)', pidAlive(process.pid));
check('pidAlive(0) 为 false', !pidAlive(0));
check('pidAlive(负数) 为 false', !pidAlive(-1));
check('pidAlive(不存在的 pid) 为 false', !pidAlive(999999));

// --- PID file round-trip ---
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'np-proc-'));
{
  check('readPidFile 在无文件时返回 null', readPidFile(tmpBase) === null);
  writePidFile(tmpBase, { serverPid: process.pid, port: 8765, workDir: '/tmp/x/core' });
  const d = readPidFile(tmpBase);
  check('PID 文件写入后可读回', d?.serverPid === process.pid && d?.port === 8765, JSON.stringify(d));
  check('PID 文件记录 workDir', d?.workDir === '/tmp/x/core', JSON.stringify(d));
  check('PID 文件记录时间戳', typeof d?.startedAt === 'string', JSON.stringify(d));

  // Merge semantics: a second write must not drop earlier keys.
  writePidFile(tmpBase, { corePid: 12345 });
  const d2 = readPidFile(tmpBase);
  check('PID 文件二次写入保留已有字段',
    d2?.serverPid === process.pid && d2?.corePid === 12345, JSON.stringify(d2));

  removePidFile(tmpBase);
  check('removePidFile 之后读不到', readPidFile(tmpBase) === null);
  check('pidFilePath 指向 nodepilot.pid',
    path.basename(pidFilePath(tmpBase)) === 'nodepilot.pid', pidFilePath(tmpBase));
}

// --- Ownership-checked clearing. This pins the bug that made CI fail: a server
//     exiting must not erase the core fields recorded by another live instance. ---
{
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'np-own-'));
  writePidFile(b, { serverPid: 111, port: 8765, host: '127.0.0.1' });
  writePidFile(b, { corePid: 222, workDir: '/w/core' });

  // A *different* server (pid 999) shutting down must not touch our record.
  clearPidFile(b, { serverPid: 999 });
  let d = readPidFile(b);
  check('他人 serverPid 退出不影响记录', d?.serverPid === 111 && d?.corePid === 222, JSON.stringify(d));

  // A *different* core shutting down must likewise be ignored.
  clearPidFile(b, { corePid: 999 });
  d = readPidFile(b);
  check('他人 corePid 退出不影响记录', d?.serverPid === 111 && d?.corePid === 222, JSON.stringify(d));

  // The real owner clearing its own fields leaves the other half intact.
  clearPidFile(b, { serverPid: 111 });
  d = readPidFile(b);
  check('自有 serverPid 退出后保留 core 记录',
    d?.serverPid === undefined && d?.corePid === 222 && d?.port === undefined, JSON.stringify(d));

  // Once no owner is recorded the file is dropped.
  clearPidFile(b, { corePid: 222 });
  check('所有属主清空后删除文件', readPidFile(b) === null);

  // Clearing a missing file is a no-op, not a throw.
  let threw = false;
  try { clearPidFile(b, { serverPid: 1 }); } catch { threw = true; }
  check('对不存在的 PID 文件清理不抛错', !threw);
  fs.rmSync(b, { recursive: true, force: true });
}

// --- 损坏的 PID 文件不应导致崩溃 ---
{
  writePidFile(tmpBase, { serverPid: 1 });
  fs.writeFileSync(pidFilePath(tmpBase), '{ this is not json');
  check('损坏的 PID 文件返回 null 而非抛错', readPidFile(tmpBase) === null);
  fs.writeFileSync(pidFilePath(tmpBase), 'null');
  check('PID 文件为 null 时返回 null', readPidFile(tmpBase) === null);
  removePidFile(tmpBase);
}

if (IS_LINUX) {
  // --- Spawn a long-lived child to stand in for the mihomo core ---
  const coreDir = path.join(tmpBase, 'core');
  const foreignDir = path.join(tmpBase, 'foreign-core');
  fs.mkdirSync(coreDir, { recursive: true });
  fs.mkdirSync(foreignDir, { recursive: true });

  // Stand-in for the core: must be *named* like a core, because findOurCore
  // deliberately requires both the kernel binary name and our work dir (so a
  // stray `grep /tmp/nodepilot/core` can never be mistaken for the core).
  const stub = path.join(tmpBase, 'mihomo');
  fs.writeFileSync(stub, '#!/bin/sh\n# accept -d <dir> then idle\nwhile [ $# -gt 0 ]; do case "$1" in -d|--dir) shift 2 ;; *) shift ;; esac; done\nsleep 60\n');
  fs.chmodSync(stub, 0o755);

  const child = spawn(stub, ['-d', coreDir], { stdio: 'ignore', detached: false });
  const childPid = child.pid;
  await sleep(600);

  check('子进程存活', pidAlive(childPid));
  check('能读取子进程命令行', typeof readCmdline(childPid) === 'string', String(readCmdline(childPid)));

  check('isOurCore: 本工具 workDir 命中', isOurCore(childPid, coreDir) === true);
  check('isOurCore: 其它 workDir 不命中', isOurCore(childPid, foreignDir) === false);
  check('isOurCore: 不存在的 pid 不命中', isOurCore(999999, coreDir) === false);
  check('isOurCore: 自己的 pid 不命中（命令行为空/不含 -d）',
    isOurCore(process.pid, coreDir) === false);

  const hitOurs = findOurCore(coreDir);
  check('findOurCore(本工具 workDir) 命中子进程',
    hitOurs.some((h) => h.pid === childPid), JSON.stringify(hitOurs));
  check('findOurCore(其它 workDir) 不命中',
    !findOurCore(foreignDir).some((h) => h.pid === childPid),
    JSON.stringify(findOurCore(foreignDir)));

  child.kill('SIGKILL');
  await sleep(400);
  check('子进程被杀死后不再存活', !pidAlive(childPid));
  check('isOurCore: 死进程不命中', isOurCore(childPid, coreDir) === false);
}

// --- splitCmdline: platform-independent, and the reason Windows paths with
//     spaces work. These run on both CI legs. ---
{
  check('splitCmdline 普通参数', JSON.stringify(splitCmdline('mihomo -d /a/b')) === JSON.stringify(['mihomo', '-d', '/a/b']),
    JSON.stringify(splitCmdline('mihomo -d /a/b')));
  check('splitCmdline 去掉引号并保留空格',
    JSON.stringify(splitCmdline('mihomo.exe -d "C:\\Program Files\\np\\core"')) ===
      JSON.stringify(['mihomo.exe', '-d', 'C:\\Program Files\\np\\core']),
    JSON.stringify(splitCmdline('mihomo.exe -d "C:\\Program Files\\np\\core"')));
  check('splitCmdline 处理多余空白',
    JSON.stringify(splitCmdline('  a   b  ')) === JSON.stringify(['a', 'b']),
    JSON.stringify(splitCmdline('  a   b  ')));
  check('splitCmdline 空串', JSON.stringify(splitCmdline('')) === JSON.stringify([]));
  check('splitCmdline 单引号不特殊处理（与 Windows 命令行一致）',
    JSON.stringify(splitCmdline("a 'b c'")) === JSON.stringify(['a', "'b", "c'"]),
    JSON.stringify(splitCmdline("a 'b c'")));
}

// --- isOurCore argument parsing is independent of the running platform: feed
//     it cmdline shapes rather than real pids, so the Windows form is covered
//     even when the suite runs on Linux. ---
{
  // `-d <dir>` with a quoted path containing spaces (Windows form).
  const winCmd = 'C:\\Tools\\mihomo.exe -d "C:\\Users\\me\\AppData\\Local\\Temp\\nodepilot\\core"';
  const winDir = 'C:\\Users\\me\\AppData\\Local\\Temp\\nodepilot\\core';
  // isOurCore re-reads the real process, so exercise the parsing helpers the
  // same way isOurCore does.
  const argv = splitCmdline(winCmd);
  const idx = argv.indexOf('-d');
  check('Windows 带空格的 -d 路径能被解析出', idx >= 0 && argv[idx + 1] === winDir,
    JSON.stringify(argv));
}

// --- defaultBaseDir is stable and absolute ---check('defaultBaseDir 为绝对路径', path.isAbsolute(defaultBaseDir()));
check('defaultBaseDir 以 nodepilot 结尾', defaultBaseDir().endsWith('nodepilot'), defaultBaseDir());

fs.rmSync(tmpBase, { recursive: true, force: true });

console.log(`\n${failures} failed`);
console.log('PROC_TEST_DONE');
process.exit(failures ? 1 : 0);
