// Speed-test engine: orchestrates latency / download / upload / unlock phases
// across per-node ports, emitting progress events as results land.
import { EventEmitter } from 'node:events';
import { probeLatency, timedDownload, timedUpload } from './tunnel.mjs';
import { checkService, UNLOCK_SERVICES } from './unlock.mjs';
import { median, stdev, bytesToMBs, sleep } from './util.mjs';

/**
 * Default test endpoints, best-first.
 *
 * Chosen from measured results on this machine (through real HK/JP nodes).
 * Notes that matter:
 *  - dl.google.com 302-redirects; timedDownload follows redirects for this reason.
 *  - speed.cloudflare.com returns 403 for bytes >= ~100MB; 25MiB is the safe cap.
 *  - cachefly.cachefly.net/100mb.test is NOT a 100MB file (25-byte joke body).
 *  - speedtest.tokyo.linode.com and proof.ovh.net were unreachable in testing.
 */
export const DEFAULT_DOWNLOAD_URLS = [
  'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg',
  'https://speed.cloudflare.com/__down?bytes=26214400',
  'https://mirror.nju.edu.cn/ubuntu/ls-lR.gz',
  'https://download.thinkbroadband.com/100MB.zip',
];

export const DEFAULT_LATENCY_URL = 'http://www.gstatic.com/generate_204';

export const DEFAULT_CONFIG = {
  latencyRounds: 4,
  latencyTimeoutMs: 5000,
  // Calibrated on this machine: probing too many nodes at once makes the local
  // core a bottleneck, which fabricates packet loss and inflates latency
  // (measured 6% loss at concurrency 1 vs 19% at 8 for identical nodes).
  // 4 keeps measurements honest while still finishing in reasonable time.
  latencyConcurrency: 4,
  downloadConcurrency: 4,
  downloadDurationMs: 6000,
  downloadUrl: DEFAULT_DOWNLOAD_URLS[0],
  downloadFallback: true,
  uploadEnabled: false,
  uploadDurationMs: 5000,
  // Measured: per-request overhead dominates below ~10MiB, so use at least that.
  uploadBytes: 10 * 1024 * 1024,
  uploadUrl: 'https://speed.cloudflare.com/__up',
  latencyUrl: DEFAULT_LATENCY_URL,
  maxLatencyMs: 0,
  // Unlock (streaming/geo) checks are opt-in: they add one request per service
  // per node, so they noticeably lengthen a run.
  unlockEnabled: false,
  unlockConcurrency: 4,
  unlockServiceIds: null,      // null = all services
  unlockTimeoutMs: 15000,
};

function makeResult(proxy, port) {
  return {
    name: proxy.name,
    type: proxy.type,
    server: proxy.server,
    port,
    origin: proxy.__origin || 'config',
    latency: null,
    jitter: null,
    packetLoss: null,
    downloadBps: null,
    downloadBytes: 0,
    uploadBps: null,
    unlock: null,
    ipInfo: null,
    status: 'pending',
    error: null,
    testedAt: null,
  };
}

/** Run tasks with bounded concurrency, preserving order of completion. */
async function runPool(items, concurrency, worker, signal) {
  const queue = [...items];
  const runners = [];
  const limit = Math.max(1, Math.min(concurrency, queue.length));

  for (let i = 0; i < limit; i++) {
    runners.push(
      (async () => {
        while (queue.length) {
          if (signal?.aborted) return;
          const item = queue.shift();
          if (item === undefined) return;
          try {
            await worker(item);
          } catch {
            /* worker handles its own errors */
          }
        }
      })()
    );
  }
  await Promise.all(runners);
}

export class SpeedTestEngine extends EventEmitter {
  constructor(coreManager, options = {}) {
    super();
    this.core = coreManager;
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.signal = null;
    this.results = new Map();
    this.running = false;
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  snapshot() {
    const results = [...this.results.values()];
    const settled = new Set(['done', 'error', 'aborted']);
    const latencySettled = new Set(['latency-done', 'download', 'upload', 'done', 'error', 'aborted']);

    // Progress is reported per phase: counting only fully-finished nodes made
    // the bar sit at 0 for the whole latency phase, then overshoot later.
    const phase = this.phase || 'idle';
    let phaseDone;
    let phaseTotal;
    if (phase === 'latency') {
      phaseTotal = this.phaseTotal || results.length;
      phaseDone = results.filter((r) => latencySettled.has(r.status)).length;
    } else if (phase === 'unlock') {
      // Nodes are already 'done' when unlock runs, so completion is tracked by
      // whether unlock data has been filled in.
      phaseTotal = this.phaseTotal || results.length;
      phaseDone = results.filter((r) => Array.isArray(r.unlock) && r.unlock.length > 0).length;
    } else if (phase === 'download' || phase === 'upload') {
      phaseTotal = this.phaseTotal || results.length;
      phaseDone = results.filter((r) => settled.has(r.status)).length;
    } else {
      phaseTotal = results.length;
      phaseDone = results.filter((r) => settled.has(r.status)).length;
    }

    return {
      results,
      total: results.length,
      done: results.filter((r) => settled.has(r.status)).length,
      usable: results.filter((r) => r.status === 'done' && r.latency !== null).length,
      phase,
      phaseDone,
      phaseTotal,
      running: this.running,
    };
  }

  /** Record the active phase so snapshot() can report progress within it. */
  setPhase(phase, label, total) {
    this.phase = phase;
    this.phaseTotal = total;
    this.emit('phase', { phase, label, total });
  }

  stop() {
    // Abort through the controller: an AbortSignal has no .abort() method.
    if (this.controller) this.controller.abort();
  }

  /**
   * @param {Array} proxies normalized proxy entries
   * @param {Map<string, number>} portMap node name -> local listener port
   * @param {AbortSignal} [externalSignal]
   */
  async run(proxies, portMap, externalSignal) {
    if (this.running) throw new Error('已有测速任务在进行中');
    this.running = true;

    const controller = new AbortController();
    this.controller = controller;
    this.signal = controller.signal;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const testable = proxies.filter((p) => portMap.has(p.name));
    this.results = new Map();
    for (const p of testable) {
      this.results.set(p.name, makeResult(p, portMap.get(p.name)));
    }

    const started = Date.now();
    this.setPhase('latency', '延迟测试', testable.length);
    this.emitUpdate();

    try {
      await this.phaseLatency(testable, portMap);
      if (!this.signal.aborted) {
        await this.phaseDownload(testable, portMap);
      }
      if (!this.signal.aborted && this.config.uploadEnabled) {
        await this.phaseUpload(testable, portMap);
      }
      if (!this.signal.aborted && this.config.unlockEnabled) {
        await this.phaseUnlock(testable, portMap);
      }
    } finally {
      this.running = false;
      this.controller = null;
      // Settle *every* node that is not already in a terminal state. Nodes can
      // legitimately be left mid-flight: skipped by the latency filter before
      // any download ran, cut short by a stop, or stalled on one URL. Leaving
      // them in a transient status made them look "stuck" forever in the UI and
      // made any "all nodes settled" wait hang.
      const terminal = new Set(['done', 'error', 'aborted']);
      for (const r of this.results.values()) {
        if (terminal.has(r.status)) continue;

        if (this.signal.aborted) {
          r.status = 'aborted';
          if (!r.error) r.error = '已取消';
        } else if (r.latency !== null && r.downloadBps === null) {
          // Latency was measured but bandwidth was never tested (e.g. excluded
          // by maxLatencyMs). That is a valid, finished outcome.
          r.status = 'done';
          r.downloadBps = 0;
          if (!r.error) r.error = '未测下载（超出延迟阈值）';
        } else {
          r.status = 'error';
          if (!r.error) r.error = '未完成';
        }
        if (!r.testedAt) r.testedAt = Date.now();
      }
      this.phase = 'finished';
      this.emit('phase', { phase: 'finished', elapsedMs: Date.now() - started });
      this.emitUpdate();
      this.emit('done', this.snapshot());
    }

    return this.snapshot();
  }

  async phaseLatency(proxies, portMap) {
    const { latencyRounds, latencyTimeoutMs, latencyConcurrency, latencyUrl } = this.config;

    await runPool(
      proxies,
      latencyConcurrency,
      async (proxy) => {
        const r = this.results.get(proxy.name);
        if (!r) return;
        r.status = 'testing';
        this.emitUpdate();

        const port = portMap.get(proxy.name);
        const { samples, failures, rounds } = await probeLatency(port, latencyUrl, {
          rounds: latencyRounds,
          timeoutMs: latencyTimeoutMs,
          signal: this.signal,
        });

        if (this.signal.aborted) {
          r.status = 'aborted';
          this.emitUpdate();
          return;
        }

        if (!samples.length) {
          r.status = 'error';
          r.error = '节点不可用';
          r.latency = null;
          r.jitter = null;
          r.packetLoss = 100;
          r.testedAt = Date.now();
          this.emitUpdate();
          return;
        }

        r.latency = Math.round(median(samples));
        r.jitter = Math.round(stdev(samples));
        r.packetLoss = rounds > 0 ? (failures / rounds) * 100 : 0;
        r.status = 'latency-done';
        r.testedAt = Date.now();
        this.emitUpdate();
      },
      this.signal
    );
  }

  /** Nodes that responded and are worth spending bandwidth on. */
  candidatesForBandwidth(proxies) {
    const { maxLatencyMs } = this.config;
    return proxies
      .filter((p) => {
        const r = this.results.get(p.name);
        if (!r || r.latency === null) return false;
        if (maxLatencyMs > 0 && r.latency > maxLatencyMs) return false;
        return true;
      })
      .sort((a, b) => {
        const la = this.results.get(a.name).latency;
        const lb = this.results.get(b.name).latency;
        return la - lb;
      });
  }

  async phaseDownload(proxies, portMap) {
    const candidates = this.candidatesForBandwidth(proxies);
    this.setPhase('download', '下载测速', candidates.length);
    this.emitUpdate();

    const urls = this.config.downloadFallback
      ? [...new Set([this.config.downloadUrl, ...DEFAULT_DOWNLOAD_URLS])]
      : [this.config.downloadUrl];

    await runPool(
      candidates,
      this.config.downloadConcurrency,
      async (proxy) => {
        const r = this.results.get(proxy.name);
        if (!r) return;
        const port = portMap.get(proxy.name);
        r.status = 'download';
        this.emitUpdate();

        for (const url of urls) {
          if (this.signal.aborted) break;

          const res = await timedDownload(url, {
            port,
            timeoutMs: this.config.downloadDurationMs + 8000,
            maxMs: this.config.downloadDurationMs,
            signal: this.signal,
          });

          if (this.signal.aborted) {
            r.status = 'aborted';
            break;
          }

          if (res.ok && res.bytes > 0) {
            r.downloadBytes = res.bytes;
            // Prefer the transfer-only window so handshake latency does not
            // deflate measured bandwidth.
            const windowMs = res.transferMs > 200 ? res.transferMs : res.totalMs;
            r.downloadBps = res.bytes / (windowMs / 1000);
            r.downloadUrl = url;
            r.status = 'done';
            r.error = null;
            r.testedAt = Date.now();
            this.emitUpdate();
            return;
          }

          if (!this.config.downloadFallback) {
            r.status = 'error';
            r.error = res.error || '下载失败';
            break;
          }
          // else: try the next URL
        }

        if (r.status === 'download') {
          r.status = 'done';
          r.downloadBps = 0;
          r.error = r.error || '下载测速失败';
          r.testedAt = Date.now();
          this.emitUpdate();
        }
      },
      this.signal
    );
  }

  async phaseUpload(proxies, portMap) {
    const candidates = this.candidatesForBandwidth(proxies).filter((p) => {
      const r = this.results.get(p.name);
      return r && r.status === 'done';
    });

    this.setPhase('upload', '上传测速', candidates.length);
    this.emitUpdate();

    await runPool(
      candidates,
      Math.min(this.config.downloadConcurrency, 3),
      async (proxy) => {
        const r = this.results.get(proxy.name);
        if (!r) return;
        const port = portMap.get(proxy.name);
        r.status = 'upload';
        this.emitUpdate();

        const res = await timedUpload(this.config.uploadUrl, {
          port,
          bytes: this.config.uploadBytes,
          timeoutMs: this.config.uploadDurationMs + 10000,
          signal: this.signal,
        });

        if (this.signal.aborted) {
          r.status = 'aborted';
        } else if (res.ok && res.bytes > 0 && res.totalMs > 0) {
          r.uploadBps = res.bytes / (res.totalMs / 1000);
          r.status = 'done';
        } else {
          r.status = 'done';
          r.uploadBps = 0;
        }
        r.testedAt = Date.now();
        this.emitUpdate();
      },
      this.signal
    );
  }

  /**
   * Unlock phase: probe each responsive node for streaming/geo availability.
   * Runs after bandwidth so a failed unlock check never costs a speed figure.
   */
  async phaseUnlock(proxies, portMap) {
    const candidates = proxies.filter((p) => {
      const r = this.results.get(p.name);
      return r && r.latency !== null;
    });

    const services = this.config.unlockServiceIds?.length
      ? UNLOCK_SERVICES.filter((s) => this.config.unlockServiceIds.includes(s.id))
      : UNLOCK_SERVICES;

    this.setPhase('unlock', '解锁检测', candidates.length);
    this.emitUpdate();

    await runPool(
      candidates,
      this.config.unlockConcurrency,
      async (proxy) => {
        const r = this.results.get(proxy.name);
        if (!r) return;
        const port = portMap.get(proxy.name);

        const checks = [];
        for (const svc of services) {
          if (this.signal.aborted) break;
          try {
            checks.push(
              await checkService(svc, port, {
                timeoutMs: this.config.unlockTimeoutMs,
                signal: this.signal,
              })
            );
          } catch (err) {
            checks.push({
              id: svc.id, name: svc.name, status: 'failed',
              region: null, detail: err.message || '检测异常',
            });
          }
        }

        r.unlock = checks;
        this.emitUpdate();
      },
      this.signal
    );
  }
}

/** Apply latency/speed thresholds to produce the export list. */
export function applyFilters(results, filters = {}) {
  const {
    maxLatencyMs = 0,
    minDownloadMBs = 0,
    minUploadMBs = 0,
    maxPacketLoss = 100,
    onlyWorking = true,
    nameRegex = '',
    excludeRegex = '',
    // Unlock filtering: a list of service ids that must all be 'unlocked'.
    requireUnlock = [],
  } = filters;

  let re = null;
  let exRe = null;
  try { if (nameRegex) re = new RegExp(nameRegex, 'i'); } catch { re = null; }
  try { if (excludeRegex) exRe = new RegExp(excludeRegex, 'i'); } catch { exRe = null; }

  const required = Array.isArray(requireUnlock)
    ? requireUnlock.filter(Boolean)
    : String(requireUnlock || '').split(',').map((s) => s.trim()).filter(Boolean);

  return results.filter((r) => {
    if (re && !re.test(r.name)) return false;
    if (exRe && exRe.test(r.name)) return false;

    const usable = r.status === 'done' && r.latency !== null;
    if (onlyWorking && !usable) return false;
    if (maxLatencyMs > 0 && (r.latency === null || r.latency > maxLatencyMs)) return false;
    if (r.packetLoss !== null && r.packetLoss > maxPacketLoss) return false;
    if (minDownloadMBs > 0) {
      const mbs = r.downloadBps ? bytesToMBs(r.downloadBps, 1000) : 0;
      if (mbs < minDownloadMBs) return false;
    }
    if (minUploadMBs > 0) {
      const mbs = r.uploadBps ? bytesToMBs(r.uploadBps, 1000) : 0;
      if (mbs < minUploadMBs) return false;
    }

    // Every required service must be reported unlocked for this node.
    if (required.length) {
      const byId = new Map((r.unlock || []).map((u) => [u.id, u.status]));
      for (const id of required) {
        if (byId.get(id) !== 'unlocked') return false;
      }
    }
    return true;
  });
}

/** Compute the country/flag prefix used when renaming nodes. */
export function renameNode(result, template = '{name} | {speed}') {
  const speed = result.downloadBps ? bytesToMBs(result.downloadBps, 1000) : 0;
  const speedText = speed >= 1 ? `${speed.toFixed(2)}MB/s` : `${(speed * 1024).toFixed(0)}KB/s`;
  const latencyText = result.latency !== null ? `${result.latency}ms` : 'N/A';
  return template
    .replace(/\{name\}/g, result.name)
    .replace(/\{speed\}/g, speedText)
    .replace(/\{latency\}/g, latencyText)
    .replace(/\{type\}/g, result.type || '')
    .replace(/\{index\}/g, String(result.__index ?? ''))
    .trim();
}
