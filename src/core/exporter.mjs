// Build an exportable Clash/Mihomo config from test results.
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { bytesToMBs, sanitizeFilename } from './util.mjs';

/** Flag emoji from a two-letter country code. */
export function flagFromCountryCode(code) {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

/**
 * Split a Clash rule on top-level commas.
 *
 * Logical rules embed commas inside parentheses, e.g.
 * `AND,((DOMAIN,a.com),(NETWORK,tcp)),PROXY`, so a naive split corrupts them.
 */
export function splitRule(rule) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of rule) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Rule types whose policy field is the second token (no payload argument). */
const NO_PAYLOAD_RULE_TYPES = new Set(['MATCH', 'FINAL']);

/**
 * Point a rule at a policy that exists in the exported config.
 *
 * Rules can end with options (`no-resolve`, `src`, ...) rather than the policy,
 * so the policy position is derived from the rule type instead of from the last
 * comma. Leaving a dangling policy makes mihomo reject the whole file with
 * "proxy [X] not found".
 */
export function retargetRule(rule, knownTargets, fallbackGroup) {
  if (typeof rule !== 'string') return rule;

  const parts = splitRule(rule);
  if (parts.length < 2) return rule;

  const type = parts[0].trim().toUpperCase();
  const policyIndex = NO_PAYLOAD_RULE_TYPES.has(type) ? 1 : 2;
  if (parts.length <= policyIndex) return rule;

  const policy = parts[policyIndex].trim();
  if (!policy || knownTargets.has(policy)) return rule;

  parts[policyIndex] = fallbackGroup;
  return parts.join(',');
}
/**
 * Rough country inference from a node name, used only for display and renaming.
 * Deliberately conservative: it never invents a flag it cannot justify.
 */
const NAME_HINTS = [
  [/香港|HK|Hong ?Kong/i, 'HK'], [/台湾|台灣|TW|Taiwan/i, 'TW'],
  [/日本|JP|Japan|东京|東京|大阪/i, 'JP'], [/新加坡|SG|Singapore|狮城/i, 'SG'],
  [/韩国|韓國|KR|Korea|首尔/i, 'KR'], [/美国|US|United ?States|洛杉矶|圣何塞|西雅图/i, 'US'],
  [/英国|UK|GB|Britain|London/i, 'GB'], [/德国|DE|Germany|法兰克福/i, 'DE'],
  [/法国|FR|France/i, 'FR'], [/印度尼西亚|印尼|ID|Indonesia/i, 'ID'],
  [/马来西亚|MY|Malaysia/i, 'MY'], [/越南|VN|Vietnam/i, 'VN'],
  [/泰国|TH|Thailand/i, 'TH'], [/菲律宾|PH|Philippines/i, 'PH'],
  [/印度|IN|India/i, 'IN'], [/俄罗斯|RU|Russia/i, 'RU'],
  [/加拿大|CA|Canada/i, 'CA'], [/澳大利亚|澳洲|AU|Australia/i, 'AU'],
  [/荷兰|NL|Netherlands/i, 'NL'], [/土耳其|TR|Turkey/i, 'TR'],
  [/阿根廷|AR|Argentina/i, 'AR'], [/巴西|BR|Brazil/i, 'BR'],
  [/瑞士|CH|Switzerland/i, 'CH'], [/瑞典|SE|Sweden/i, 'SE'],
  [/爱尔兰|IE|Ireland/i, 'IE'], [/意大利|IT|Italy/i, 'IT'],
  [/西班牙|ES|Spain/i, 'ES'], [/波兰|PL|Poland/i, 'PL'],
  [/乌克兰|UA|Ukraine/i, 'UA'], [/阿联酋|迪拜|AE|Emirates/i, 'AE'],
];

export function inferCountryCode(name, existing) {
  if (existing && /^[A-Za-z]{2}$/.test(existing)) return existing.toUpperCase();
  for (const [re, code] of NAME_HINTS) {
    if (re.test(name)) return code;
  }
  return null;
}

/**
 * Rename results by region and measured speed.
 * Format: "🇭🇰 HK 01 | 25.96MB/s"
 */
export function buildRenamedResults(results, opts = {}) {
  const { rename = false, template = null } = opts;

  const counters = new Map();
  return results.map((r, i) => {
    const base = { ...r, __index: i + 1 };
    if (!rename) return base;

    const code = inferCountryCode(r.name, r.countryCode);
    const flag = flagFromCountryCode(code) || '';
    const key = code || 'XX';
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    const index = String(n).padStart(3, '0');

    const speedMBs = r.downloadBps ? bytesToMBs(r.downloadBps, 1000) : 0;
    const speedText = speedMBs >= 1
      ? `${speedMBs.toFixed(2)}MB/s`
      : `${(speedMBs * 1024).toFixed(0)}KB/s`;

    let name;
    if (template) {
      name = template
        .replace(/\{\{?\.?Flag\}?\}/g, flag)
        .replace(/\{\{?\.?CountryCode\}?\}/g, code || '')
        .replace(/\{\{?\.?Index\}?\}/g, index)
        .replace(/\{\{?\.?Speed\}?\}/g, speedText)
        .replace(/\{\{?\.?LatencyMs\}?\}/g, r.latency !== null ? String(r.latency) : 'N/A')
        .replace(/\{\{?\.?Name\}?\}/g, r.name);
    } else {
      const label = code ? `${flag} ${code}` : flag || '🌐';
      name = `${label} ${index} | ⬇️ ${speedText}`.trim();
    }
    return { ...base, renamed: name };
  });
}

/**
 * Serialize results into a Clash config.
 * @param {Array} results filtered results
 * @param {object} opts
 * @returns {string} YAML text
 */
export function buildExportConfig(results, opts = {}) {
  const {
    proxies,            // original proxy definitions keyed by name
    groupName = '🚀 节点选择',
    rename = false,
    template = null,
    includeAutoGroups = true,
    originalDoc = null,
    keepOriginalRules = true,
  } = opts;

  const renamed = buildRenamedResults(results, { rename, template });

  const outProxies = [];
  const names = [];

  for (const r of renamed) {
    const original = proxies?.get?.(r.name);
    if (!original) continue;
    const entry = { ...original };
    delete entry.__origin;
    const finalName = r.renamed || r.name;
    entry.name = finalName;
    outProxies.push(entry);
    names.push(finalName);
  }

  const groups = [];
  if (names.length) {
    groups.push({ name: groupName, type: 'select', proxies: names });
    if (includeAutoGroups && names.length > 1) {
      groups.push({
        name: '♻️ 自动选择',
        type: 'url-test',
        proxies: names,
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
      });
      groups.push({
        name: '🔄 故障转移',
        type: 'fallback',
        proxies: names,
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
      });
    }
  }

  const config = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    'unified-delay': true,
    'tcp-concurrent': true,
    proxies: outProxies,
    'proxy-groups': groups,
  };

  // Preserve preamble settings from the source config when available.
  if (originalDoc && typeof originalDoc === 'object') {
    for (const key of ['dns', 'tun', 'sniffer', 'profile', 'experimental']) {
      if (originalDoc[key] !== undefined) config[key] = originalDoc[key];
    }
  }

  if (keepOriginalRules && Array.isArray(originalDoc?.rules)) {
    // Rules may target proxy groups defined by the *original* config (or by the
    // original node names). Since the export only ships the groups we just
    // created, any rule pointing at a name that no longer exists would make
    // mihomo reject the entire file ("proxy [X] not found"). Retarget every
    // such rule at the main select group instead.
    const knownTargets = new Set([
      ...groups.map((g) => g.name),
      ...names,
      'DIRECT',
      'REJECT',
      'REJECT-DROP',
      'PASS',
      'COMPATIBLE',
    ]);

    config.rules = originalDoc.rules.map((rule) =>
      retargetRule(rule, knownTargets, groupName)
    );
    if (!config.rules.some((r) => typeof r === 'string' && /^MATCH,/i.test(r.trim()))) {
      config.rules.push(`MATCH,${groupName}`);
    }
  } else {
    config.rules = [`MATCH,${groupName}`];
  }

  const header = [
    '# 由 clash-nodepilot 生成',
    `# 生成时间: ${new Date().toLocaleString('zh-CN')}`,
    `# 节点数: ${outProxies.length}`,
    '',
  ].join('\n');

  return header + yaml.dump(config, { lineWidth: -1, noRefs: true });
}

/**
 * Write export to disk safely: an existing good file is only replaced once the
 * new content is fully built. This is the fix for the original tool's habit of
 * overwriting a good result.yaml with an empty file after a failed fetch.
 */
export async function writeExport(filePath, content, { allowEmpty = false } = {}) {
  if (!content || !content.trim()) {
    throw new Error('导出内容为空，已取消写入以保护已有文件');
  }
  if (!allowEmpty && !/^\s*proxies:/m.test(content)) {
    throw new Error('导出内容缺少 proxies 段，已取消写入');
  }

  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, resolved);
  return resolved;
}

export function defaultExportName(prefix = 'nodepilot') {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '_',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return sanitizeFilename(`${prefix}_${stamp}.yaml`);
}
