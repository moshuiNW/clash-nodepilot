// Shared helpers: math, timing, formatting, port probing.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation; used as the jitter metric. */
export function stdev(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Bytes (not bits) per second -> MB/s using binary megabytes. */
export const bytesToMBs = (bytes, ms) =>
  ms > 0 ? bytes / 1048576 / (ms / 1000) : 0;

export function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSec;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** Monotonic elapsed-time helper (immune to system clock changes). */
export function elapsedSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

export const hrtimeNs = () => process.hrtime.bigint();

export function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function sanitizeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
}
