// Unlock (streaming/geo) checks.
//
// Design notes, learned from probing these services through real nodes:
//  - HTTP status alone is useless: ChatGPT, Netflix, Disney+ and TikTok all
//    answer 200 even from blocked regions.
//  - Cloudflare's /cdn-cgi/trace exposes the *actual* egress country as
//    `loc=XX`, which is a reliable signal for Cloudflare-fronted services.
//  - Some sites put the region in the redirect path (Netflix -> /hk-en/...).
//  - Some embed a human-readable block message in the HTML.
// So each check inspects body patterns, headers and the final URL.
import { fetchText } from './tunnel.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Regions where each service is known to be blocked or unusable. */
const CN_REGIONS = new Set(['CN', 'IR', 'KP', 'CU', 'SY']);

export const UNLOCK_SERVICES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/cdn-cgi/trace',
    // OpenAI blocks CN/HK/RU and a few others.
    blockedRegions: new Set(['CN', 'HK', 'RU', 'IR', 'KP', 'CU', 'SY', 'VE', 'BY']),
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/cdn-cgi/trace',
    blockedRegions: new Set(['CN', 'HK', 'RU', 'IR', 'KP', 'CU', 'SY']),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/',
    blockedRegions: new Set(['CN', 'HK', 'RU', 'IR', 'KP', 'CU', 'SY']),
    // Google shows a region error page rather than redirecting.
    bodyBlocked: [
      /isn'?t available in your (country|region)/i,
      /not available in your (country|region)/i,
      /gemini isn'?t currently supported/i,
    ],
  },
  {
    id: 'youtube',
    name: 'YouTube Premium',
    url: 'https://www.youtube.com/premium',
    blockedRegions: new Set([]),
    // Premium availability is what actually matters here.
    bodyBlocked: [
      /not available in your country/i,
      /not available in your region/i,
    ],
    bodyUnlocked: [
      /ad-free|Enjoy YouTube without ads|premium is available/i,
      /"premium"\s*:\s*true/i,
    ],
  },
  {
    id: 'netflix',
    name: 'Netflix',
    url: 'https://www.netflix.com/title/81280792',
    // Netflix global originals are available nearly everywhere; detect a
    // geo-catalogue redirect instead (e.g. /hk-en/).
    regionFromUrl: /netflix\.com\/([a-z]{2})(?:-[a-z]{2})?\//i,
    bodyBlocked: [
      /Netflix is not available in your country/i,
      /not available in your region/i,
    ],
  },
  {
    id: 'disney',
    name: 'Disney+',
    url: 'https://www.disneyplus.com/',
    blockedRegions: new Set(['CN', 'HK', 'RU', 'IR', 'KP', 'CU', 'SY']),
    bodyBlocked: [
      /not available in your (country|region)/i,
      /Disney\+ is not available/i,
    ],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    // This endpoint answers 200 and then redirects to a region-scoped path
    // (/us/, /tw/, /sg-en/, ...). The old "page not found" text check produced
    // false negatives because the redirect target is a normal page.
    url: 'https://www.spotify.com/api/account/v1/region',
    regionFromUrl: /spotify\.com\/([a-z]{2})(?:-[a-z]{2})?\//i,
    blockedRegions: new Set(['CN', 'RU', 'IR', 'KP', 'CU', 'SY']),
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    url: 'https://www.tiktok.com/',
    // data-region on <html> reveals the served region.
    regionFromBody: /data-region=["']([^"']+)["']/i,
    blockedRegions: new Set(['CN', 'HK']),
  },
  {
    id: 'primevideo',
    name: 'Prime Video',
    url: 'https://www.primevideo.com/',
    bodyBlocked: [
      /not available in your (country|region)/i,
      /Prime Video is not available/i,
    ],
  },
  {
    id: 'openai-api',
    name: 'OpenAI API',
    url: 'https://api.openai.com/compliance/cookie_requirements',
    blockedRegions: new Set(['CN', 'HK', 'RU', 'IR', 'KP', 'CU', 'SY']),
  },
  {
    id: 'bilibili-hk',
    name: '哔哩哔哩港澳台',
    // Verified ep_id: 98603 (小林家的龙女仆) returns code 0 from HK/JP/SG and
    // code -10403 from US, i.e. it genuinely reflects the HK/MO/TW catalogue
    // rights. A made-up ep_id returns -404 and would report a false "blocked"
    // for every node, so this id must stay valid.
    url: 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=98603&qn=64&fnval=16',
    bodyUnlocked: [/"code":\s*0\b/],
    bodyBlocked: [/"code":\s*-10403\b/, /"code":\s*-404\b/],
  },
];

/** Extract the egress country from a Cloudflare trace body. */
export function parseTraceLoc(body) {
  const m = /(?:^|\n)loc=([A-Za-z]{2})/.exec(body || '');
  return m ? m[1].toUpperCase() : null;
}

/**
 * Normalize the assorted region strings services return.
 * TikTok uses values like "Singapore-Central", "us-ttp" or "sg"; Cloudflare
 * uses bare ISO codes. Only a confident ISO code is returned.
 */
export function normalizeRegion(raw, service) {
  if (!raw) return null;
  const s = String(raw).trim();

  const iso = s.toUpperCase();
  if (/^[A-Z]{2}$/.test(iso)) {
    // Guard against non-country two-letter tokens.
    if (!knownRegions || knownRegions.has(iso)) return iso;
  }

  // "us-ttp" / "hk-en" style prefixes.
  const prefix = /^([a-z]{2})[-_]/i.exec(s);
  if (prefix) return prefix[1].toUpperCase();

  // "Singapore-Central" style names.
  const name = s.split(/[-_]/)[0].toLowerCase();
  if (COUNTRY_NAMES[name]) return COUNTRY_NAMES[name];

  return null;
}

/** Minimal country-name -> ISO map for region strings we have actually seen. */
const COUNTRY_NAMES = {
  singapore: 'SG', japan: 'JP', 'hongkong': 'HK', 'hong': 'HK',
  korea: 'KR', 'southkorea': 'KR', taiwan: 'TW', china: 'CN',
  'unitedstates': 'US', america: 'US', 'unitedkingdom': 'GB',
  germany: 'DE', france: 'FR', netherlands: 'NL', canada: 'CA',
  australia: 'AU', india: 'IN', russia: 'RU', brazil: 'BR',
  turkey: 'TR', indonesia: 'ID', malaysia: 'MY', thailand: 'TH',
  vietnam: 'VN', philippines: 'PH', italy: 'IT', spain: 'ES',
  sweden: 'SE', switzerland: 'CH', poland: 'PL', ukraine: 'UA',
  ireland: 'IE', 'newzealand': 'NZ', mexico: 'MX', argentina: 'AR',
};

/** ISO codes we treat as valid country codes (avoids matching random tokens). */
const knownRegions = new Set([
  ...Object.values(COUNTRY_NAMES),
  'AE', 'SA', 'IL', 'EG', 'ZA', 'NG', 'KE', 'FI', 'NO', 'DK', 'BE', 'AT',
  'CZ', 'HU', 'RO', 'BG', 'GR', 'PT', 'IE', 'IS', 'LU', 'SK', 'SI', 'HR',
  'RS', 'LT', 'LV', 'EE', 'BY', 'KZ', 'UA', 'MD', 'GE', 'AM', 'AZ', 'UZ',
  'MN', 'NP', 'BD', 'LK', 'PK', 'KH', 'LA', 'MM', 'BN', 'MO', 'TW', 'HK',
  'PR', 'CL', 'CO', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA', 'GT',
  'DO', 'CU', 'JM', 'TT', 'HN', 'SV', 'NI', 'IR', 'IQ', 'JO', 'LB', 'KW',
  'QA', 'BH', 'OM', 'YE', 'SY', 'AF', 'TM', 'TJ', 'KG',
]);

/**
 * Run a single service check through one node.
 * @returns {Promise<{id, name, status: 'unlocked'|'blocked'|'failed'|'unknown', region, detail}>}
 */
export async function checkService(service, port, opts = {}) {
  const { timeoutMs = 15000, signal } = opts;

  const res = await fetchText(service.url, {
    port,
    timeoutMs,
    signal,
    maxBytes: 400 * 1024,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });

  const base = { id: service.id, name: service.name };

  if (signal?.aborted) return { ...base, status: 'unknown', region: null, detail: '已取消' };

  if (res.status === 0 || res.error) {
    return { ...base, status: 'failed', region: null, detail: res.error || '连接失败' };
  }

  const body = res.body || '';
  const rawRegion =
    parseTraceLoc(body) ||
    (service.regionFromUrl ? service.regionFromUrl.exec(res.finalUrl)?.[1] : null) ||
    (service.regionFromBody ? service.regionFromBody.exec(body)?.[1] : null);
  const region = normalizeRegion(rawRegion, service);

  // Explicit "blocked" page wins over everything else.
  for (const re of service.bodyBlocked || []) {
    if (re.test(body)) {
      return { ...base, status: 'blocked', region, detail: '地区限制页面' };
    }
  }

  // Explicit success marker.
  const unlockedHit = (service.bodyUnlocked || []).some((re) => re.test(body));
  const missingHit = (service.bodyMissing || []).some((re) => re.test(body));

  if (missingHit) return { ...base, status: 'blocked', region, detail: '接口不可用' };

  // Region-based decision for Cloudflare-fronted services.
  if (service.blockedRegions && region) {
    const blocked = service.blockedRegions.has(region);
    return {
      ...base,
      status: blocked ? 'blocked' : 'unlocked',
      region,
      detail: blocked ? `出口地区 ${region} 被封禁` : `出口地区 ${region}`,
    };
  }

  if (unlockedHit) return { ...base, status: 'unlocked', region, detail: '内容可访问' };

  // Fall back to a plain reachability verdict.
  if (res.status >= 200 && res.status < 400) {
    return { ...base, status: 'unlocked', region, detail: `HTTP ${res.status}` };
  }
  return { ...base, status: 'blocked', region, detail: `HTTP ${res.status}` };
}

/**
 * Run all enabled services for one node, sequentially to avoid hammering a
 * single node's connection pool.
 */
export async function checkNode(port, services = UNLOCK_SERVICES, opts = {}) {
  const out = [];
  for (const svc of services) {
    if (opts.signal?.aborted) break;
    out.push(await checkService(svc, port, opts));
  }
  return out;
}
