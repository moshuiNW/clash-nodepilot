// Fetch and normalize Clash/Mihomo configuration from a URL or local file.
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

const DEFAULT_UA = 'clash-verge/1.3.8';
const MAX_BYTES = 32 * 1024 * 1024;

/** Proxy types that can actually be dialed and measured. */
const MEASURABLE_TYPES = new Set([
  'ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic',
  'snell', 'http', 'socks5', 'anytls', 'mieru', 'ssh', 'wireguard', 'wg',
  'shadowquic', 'sudoku', 'trusttunnel', 'masque', 'openvpn', 'tailscale',
]);

/** Group/structural types that are not dialable nodes. */
const GROUP_TYPES = new Set([
  'select', 'url-test', 'fallback', 'load-balance', 'relay', 'direct', 'reject',
  'reject-drop', 'compatible', 'pass', 'rematch',
]);

export class SubscriptionError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SubscriptionError';
    this.detail = detail;
  }
}

function lookLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

/** Decide whether a string is a local path or a remote URL. */
export function classifySource(input) {
  return lookLikeUrl(input) ? 'url' : 'file';
}

async function readLocalFile(filePath) {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new SubscriptionError(`配置文件不存在: ${resolved}`);
  }
  if (!stat.isFile()) throw new SubscriptionError(`不是文件: ${resolved}`);
  const text = await fs.readFile(resolved, 'utf8');
  return { text, resolvedPath: resolved, bytes: stat.size };
}

/**
 * Download with retries. The original tool wrote an empty result when this
 * failed; here a failure throws so callers never clobber a good export.
 */
export async function fetchText(url, opts = {}) {
  const {
    userAgent = DEFAULT_UA,
    retries = 3,
    timeoutMs = 20000,
    onAttempt = () => {},
  } = opts;

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    onAttempt(attempt, retries);

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
        redirect: 'follow',
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        throw new Error(`响应过大: ${buf.length} bytes`);
      }
      if (buf.length === 0) throw new Error('响应为空');

      clearTimeout(timer);
      return { text: buf.toString('utf8'), bytes: buf.length, finalUrl: res.url };
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === 'AbortError' ? new Error(`请求超时 (${timeoutMs}ms)`) : err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }

  throw new SubscriptionError(`拉取订阅失败: ${lastError?.message || '未知错误'}`, lastError);
}

/** Parse YAML defensively, giving a useful message on failure. */
export function parseYaml(text, label = 'config') {
  let doc;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new SubscriptionError(`解析 ${label} YAML 失败: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new SubscriptionError(`${label} 不是有效的 YAML 配置`);
  }
  return doc;
}

/** A node must have a name and a dialable type. */
function isMeasurableProxy(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.name || typeof entry.name !== 'string') return false;
  const type = String(entry.type || '').toLowerCase();
  if (!type) return false;
  if (GROUP_TYPES.has(type)) return false;
  if (MEASURABLE_TYPES.has(type)) return true;
  // Unknown but non-group type: keep it, mihomo will reject it if invalid.
  return entry.server !== undefined;
}

/** Strip fields that are provider-only or would confuse a direct proxy entry. */
function normalizeProxy(raw) {
  const p = { ...raw };
  delete p.id;
  delete p['display-name'];
  return p;
}

/**
 * Extract proxy entries from a parsed config, following proxy-providers.
 * Providers may be inline (`payload`) or remote (`url`).
 */
export async function collectProxies(doc, opts = {}) {
  const {
    userAgent = DEFAULT_UA,
    fetchImpl = fetchText,
    includeProviders = true,
    log = () => {},
  } = opts;

  const proxies = [];
  const seenNames = new Set();
  const warnings = [];

  const push = (entry, origin) => {
    if (!isMeasurableProxy(entry)) return;
    const name = String(entry.name);
    if (seenNames.has(name)) {
      // mihomo requires unique names; suffix duplicates rather than dropping.
      let n = 2;
      let candidate = `${name} #${n}`;
      while (seenNames.has(candidate)) {
        n++;
        candidate = `${name} #${n}`;
      }
      warnings.push(`重名节点 "${name}" 已重命名为 "${candidate}"`);
      entry = { ...entry, name: candidate };
    }
    seenNames.add(String(entry.name));
    proxies.push({ ...normalizeProxy(entry), __origin: origin });
  };

  if (Array.isArray(doc?.proxies)) {
    for (const entry of doc.proxies) push(entry, 'config');
  }

  const providers = doc?.['proxy-providers'];
  if (includeProviders && providers && typeof providers === 'object') {
    for (const [providerName, provider] of Object.entries(providers)) {
      if (!provider || typeof provider !== 'object') continue;

      if (Array.isArray(provider.payload)) {
        let count = 0;
        for (const entry of provider.payload) {
          const before = proxies.length;
          push(entry, `provider:${providerName}`);
          if (proxies.length > before) count++;
        }
        log(`Provider "${providerName}" 内联节点 ${count} 个`);
        continue;
      }

      const url = provider.url;
      if (typeof url === 'string' && lookLikeUrl(url)) {
        try {
          const headers = provider.header && typeof provider.header === 'object'
            ? Object.fromEntries(
                Object.entries(provider.header).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])
              )
            : {};
          const ua = headers['User-Agent'] || headers['user-agent'] || userAgent;
          const { text } = await fetchImpl(url, { userAgent: ua, retries: 3 });
          const providerDoc = parseYaml(text, `provider "${providerName}"`);
          const list = Array.isArray(providerDoc) ? providerDoc : providerDoc.proxies;
          if (Array.isArray(list)) {
            let count = 0;
            for (const entry of list) {
              const before = proxies.length;
              push(entry, `provider:${providerName}`);
              if (proxies.length > before) count++;
            }
            log(`Provider "${providerName}" 拉取到 ${count} 个节点`);
          } else {
            warnings.push(`Provider "${providerName}" 中没有 proxies 列表`);
          }
        } catch (err) {
          warnings.push(`Provider "${providerName}" 拉取失败: ${err.message}`);
        }
      }
    }
  }

  return { proxies, warnings };
}

/**
 * Full pipeline: source -> normalized proxy list.
 * @returns {Promise<{proxies: Array, warnings: string[], source: string, bytes: number}>}
 */
export async function loadProxies(source, opts = {}) {
  const {
    userAgent = DEFAULT_UA,
    fetchImpl = fetchText,
    log = () => {},
    includeProviders = true,
    onAttempt = () => {},
  } = opts;

  const kind = classifySource(source);
  let text;
  let bytes;
  let resolvedPath = null;
  let finalUrl = null;

  if (kind === 'url') {
    const res = await fetchImpl(source, { userAgent, retries: 3, onAttempt });
    text = res.text;
    bytes = res.bytes;
    finalUrl = res.finalUrl;
  } else {
    const res = await readLocalFile(source);
    text = res.text;
    bytes = res.bytes;
    resolvedPath = res.resolvedPath;
  }

  const doc = parseYaml(text, kind === 'url' ? '订阅' : path.basename(source || 'config'));
  const { proxies, warnings } = await collectProxies(doc, {
    userAgent,
    fetchImpl,
    includeProviders,
    log,
  });

  if (!proxies.length) {
    throw new SubscriptionError(
      '配置中未找到可测速的节点。请确认订阅返回的是 Clash/Mihomo 格式（含 proxies 或 proxy-providers）。'
    );
  }

  return {
    proxies,
    warnings,
    source,
    kind,
    bytes,
    resolvedPath,
    finalUrl,
    rawDoc: doc,
  };
}
