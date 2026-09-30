// Validate that an exported config is accepted by the real mihomo core.
// Empty/blank placeholder rules must be ignored, and the exit code must be 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCore } from '../src/core/core-finder.mjs';

const core = await findCore();
if (!core.path) {
  console.log('SKIP: 未找到 mihomo 内核，跳过真实内核校验');
  process.exit(0);
}
console.log('core:', core.path);

const src = path.resolve('tests/_exporttest/good.yaml');
if (!fs.existsSync(src)) {
  console.log('SKIP: 没有导出的配置（请先运行 safety.test.mjs）');
  process.exit(0);
}

// Use a scratch dir so we never touch the real core's state.
const dir = path.join(os.tmpdir(), 'nodepilot-validate');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, 'config.yaml'));

// `-t` performs a config syntax/validity test and exits.
const r = spawnSync(core.path, ['-d', dir, '-t'], { encoding: 'utf8', timeout: 60000 });
const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
const significant = output
  .split('\n')
  .filter((l) => l.trim() && !/level=info/.test(l))
  .slice(0, 12)
  .join('\n');
if (significant) console.log('output:', significant);

const ok = r.status === 0;
console.log(ok ? '\nPASS: 导出的配置可被 mihomo 正常加载' : `\nFAIL: 导出的配置被 mihomo 拒绝 (exit ${r.status})`);
console.log('VALIDATE_DONE');
process.exit(ok ? 0 : 1);
