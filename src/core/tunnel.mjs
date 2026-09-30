// Zero-dependency HTTP CONNECT tunneling agent.
// Each instance targets one mihomo listener port, which mihomo binds to exactly
// one proxy node. This is what makes per-node parallel measurement possible
// without reimplementing any proxy protocol.
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';

/**
 * Build a tunnel agent on top of the correct Node base class.
 *
 * Node validates that the agent's protocol matches the request URL, so an
 * http:// request must use an http.Agent and an https:// request an
 * https.Agent. Using one class for both makes every http:// probe fail with
 * "Protocol http: not supported. Expected https:".
 */
function makeTunnelAgent(BaseAgent, secure) {
  return class TunnelAgentBase extends BaseAgent {
    constructor(proxyPort, opts = {}) {
      super({ keepAlive: opts.keepAlive === true, maxSockets: opts.maxSockets ?? 8 });
      this.proxyHost = opts.proxyHost ?? '127.0.0.1';
      this.proxyPort = proxyPort;
      this.secure = secure;
      this.connectTimeout = opts.connectTimeout ?? 8000;
      this.verifyTls = opts.verifyTls === true;
    }

    createConnection(options, callback) {
      const targetHost = options.host;
      const targetPort = Number(options.port) || (this.secure ? 443 : 80);
      let settled = false;
      let timer = null;

      const socket = net.connect({ host: this.proxyHost, port: this.proxyPort });

      const done = (err, sock) => {
        if (timer) clearTimeout(timer);
        callback(err, sock);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        done(err);
      };

      timer = setTimeout(() => fail(new Error('CONNECT timeout')), this.connectTimeout);
      socket.once('error', fail);
      socket.setNoDelay(true);

      socket.once('connect', () => {
        // Pause so the CONNECT response can be parsed without losing payload
        // bytes that may arrive in the same TCP segment.
        socket.pause();
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            `Proxy-Connection: keep-alive\r\n\r\n`
        );

        let head = Buffer.alloc(0);

        const onReadable = () => {
          let chunk;
          while ((chunk = socket.read()) !== null) {
            head = Buffer.concat([head, chunk]);
            const idx = head.indexOf('\r\n\r\n');
            if (idx === -1) {
              if (head.length > 65536) return fail(new Error('CONNECT header too large'));
              continue;
            }

            socket.removeListener('readable', onReadable);
            socket.removeListener('error', fail);

            const eol = head.indexOf('\r\n');
            const statusLine = head.subarray(0, eol).toString('latin1');
            const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
            const code = m ? Number(m[1]) : 0;
            if (code !== 200) {
              return fail(new Error(`CONNECT rejected (${code})`));
            }

            const rest = head.subarray(idx + 4);
            if (rest.length) socket.unshift(rest);

            if (!this.secure) {
              if (settled) return;
              settled = true;
              return done(null, socket);
            }

            const tlsSocket = tls.connect(
              {
                socket,
                servername: options.servername || targetHost,
                rejectUnauthorized: this.verifyTls,
                ALPNProtocols: ['http/1.1'],
              },
              () => {
                if (settled) return;
                settled = true;
                done(null, tlsSocket);
              }
            );
            tlsSocket.once('error', fail);
            return;
          }
        };

        socket.on('readable', onReadable);
      });
    }
  };
}

/** Agent for https:// targets through a mihomo listener. */
export const TunnelAgent = makeTunnelAgent(https.Agent, true);

/** Agent for http:// targets through a mihomo listener. */
export const PlainTunnelAgent = makeTunnelAgent(http.Agent, false);

export function agentFor(port, url, opts = {}) {
  const isHttps = /^https:/i.test(url);
  return isHttps ? new TunnelAgent(port, opts) : new PlainTunnelAgent(port, opts);
}

/**
 * A single instrumented GET that reports time-to-first-byte, total bytes and
 * the byte timeline. Resolves (never rejects) with an error field on failure.
 */
export function timedDownload(url, opts = {}) {
  const {
    port,
    timeoutMs = 15000,
    maxBytes = Infinity,
    maxMs = Infinity,
    signal,
    onProgress = null,
    headers = {},
    verifyTls = false,
  } = opts;

  return new Promise((resolve) => {
    const isHttps = /^https:/i.test(url);
    const lib = isHttps ? https : http;
    const result = {
      ok: false,
      status: 0,
      bytes: 0,
      ttfbMs: null,
      totalMs: 0,
      error: null,
      aborted: false,
      timeline: [],
      // Time and bytes counted from the first payload byte onward. Throughput
      // should exclude connection setup so slow handshakes do not deflate it.
      transferMs: 0,
      transferBytes: 0,
    };

    const startNs = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - startNs) / 1e6;

    let req = null;
    let res = null;
    let finished = false;
    let lastProgressAt = 0;
    let firstByteAt = null;

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const finish = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      result.totalMs = elapsed();
      if (err && !result.error) result.error = err.message || String(err);
      try { req && req.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const onAbort = () => { result.aborted = true; finish(null); };
    if (signal) {
      if (signal.aborted) return finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const hardTimer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    try {
      const agent = agentFor(port, url, { connectTimeout: Math.min(timeoutMs, 10000), verifyTls });
      req = lib.get(url, { agent, headers: { 'User-Agent': 'clash-nodepilot/1.0', ...headers } }, (response) => {
        res = response;

        // Follow redirects manually so the tunnel stays per-node.
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
          const next = new URL(response.headers.location, url).toString();
          response.resume();
          try { req.destroy(); } catch { /* ignore */ }
          finished = true;
          cleanup();
          // Recurse into the redirect target, preserving instrumentation.
          timedDownload(next, { ...opts, headers, signal }).then(resolve);
          return;
        }

        result.status = response.statusCode;

        // TTFB is the moment response headers arrive. Measuring it in the
        // 'data' handler would break for bodyless responses such as the 204
        // returned by generate_204 endpoints.
        if (result.ttfbMs === null) {
          result.ttfbMs = elapsed();
          firstByteAt = result.ttfbMs;
        }

        if (response.statusCode >= 400) {
          response.resume();
          return finish(new Error(`HTTP ${response.statusCode}`));
        }

        response.on('data', (chunk) => {
          if (result.ttfbMs === null) {
            result.ttfbMs = elapsed();
            firstByteAt = result.ttfbMs;
          }
          result.bytes += chunk.length;
          result.transferBytes = result.bytes;
          result.transferMs = elapsed() - firstByteAt;

          const t = elapsed();
          result.timeline.push([t, result.bytes]);
          if (result.timeline.length > 600) result.timeline.shift();

          if (onProgress && t - lastProgressAt > 120) {
            lastProgressAt = t;
            onProgress(result.bytes, t);
          }

          // Bound the transfer window (not wall time) so a slow handshake does
          // not eat into every node's measurement period.
          if (result.bytes >= maxBytes || result.transferMs >= maxMs) {
            result.ok = true;
            try { req.destroy(); } catch { /* ignore */ }
            finish(null);
          }
        });

        response.on('end', () => {
          result.ok = result.status > 0 && result.status < 400;
          finish(null);
        });
        response.on('error', (e) => finish(e));
      });

      req.on('error', (e) => finish(e));
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * Latency probe: time to first byte of a small GET, repeated to derive jitter
 * and packet loss.
 *
 * A warmup request is issued and discarded: the very first connection pays for
 * DNS resolution, TCP/TLS handshake and node-side session setup, which would
 * otherwise dominate jitter (and look like packet loss when it times out).
 */
export async function probeLatency(port, url, opts = {}) {
  const { rounds = 4, timeoutMs = 5000, gapMs = 60, signal, warmup = true } = opts;
  const samples = [];
  let failures = 0;

  const once = () =>
    timedDownload(url, {
      port,
      timeoutMs,
      maxBytes: 2048,
      maxMs: timeoutMs,
      signal,
      headers: { Range: 'bytes=0-1023' },
    });

  if (warmup && !signal?.aborted) {
    const w = await once();
    // A warmup failure is itself meaningful only if the node never recovers,
    // so it is not counted; the measured rounds below decide usability.
    if (w.aborted) return { samples, failures: 0, rounds: 0 };
    await new Promise((res) => setTimeout(res, gapMs));
  }

  for (let i = 0; i < rounds; i++) {
    if (signal?.aborted) break;
    let r = await once();

    // One extra attempt before calling it loss: a single transient blip (or a
    // scheduling hiccup in the local core) should not be reported as packet
    // loss when the node is plainly working.
    if (!r.aborted && !(r.ttfbMs !== null && r.status > 0 && r.status < 400)) {
      await new Promise((res) => setTimeout(res, gapMs * 2));
      const retry = await once();
      if (!retry.aborted && retry.ttfbMs !== null && retry.status > 0 && retry.status < 400) {
        r = retry;
      }
    }

    if (r.aborted) break;
    if (r.ttfbMs !== null && r.status > 0 && r.status < 400) {
      samples.push(Math.max(1, Math.round(r.ttfbMs)));
    } else {
      failures++;
    }
    if (i < rounds - 1) await new Promise((res) => setTimeout(res, gapMs));
  }

  return { samples, failures, rounds };
}

/** Upload via POST; measures throughput of the request body. */
export function timedUpload(url, opts = {}) {
  const { port, bytes = 5 * 1024 * 1024, timeoutMs = 20000, signal, verifyTls = false } = opts;

  return new Promise((resolve) => {
    const isHttps = /^https:/i.test(url);
    const lib = isHttps ? https : http;
    const result = { ok: false, status: 0, bytes: 0, totalMs: 0, error: null, aborted: false };

    const startNs = process.hrtime.bigint();
    let finished = false;
    let req = null;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      result.totalMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      if (err && !result.error) result.error = err.message || String(err);
      try { req && req.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const onAbort = () => { result.aborted = true; finish(null); };
    if (signal) {
      if (signal.aborted) return finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const hardTimer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    try {
      const agent = agentFor(port, url, { connectTimeout: Math.min(timeoutMs, 10000), verifyTls });
      const urlObj = new URL(url);
      const body = Buffer.alloc(Math.min(bytes, 1024 * 1024), 0x61);
      const repeats = Math.ceil(bytes / body.length);

      req = lib.request(
        {
          agent,
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'User-Agent': 'clash-nodepilot/1.0',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(body.length * repeats),
          },
        },
        (res) => {
          result.status = res.statusCode;
          res.resume();
          res.on('end', () => {
            result.ok = res.statusCode > 0 && res.statusCode < 400;
            finish(null);
          });
          res.on('error', (e) => finish(e));
        }
      );

      req.on('error', (e) => finish(e));

      let written = 0;
      const writeMore = () => {
        if (finished || signal?.aborted) return;
        while (written < body.length * repeats) {
          const remaining = body.length * repeats - written;
          const chunk = remaining >= body.length ? body : body.subarray(0, remaining);
          written += chunk.length;
          result.bytes = written;
          if (!req.write(chunk)) {
            req.once('drain', writeMore);
            return;
          }
        }
        req.end();
      };
      writeMore();

      req.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * Fetch a small text response through a per-node listener.
 *
 * Used by unlock checks, which must inspect the response body/headers rather
 * than the status code: every one of these services answers HTTP 200 even when
 * the region is blocked.
 *
 * @returns {Promise<{ok, status, body, headers, finalUrl, error, elapsedMs}>}
 */
export function fetchText(url, opts = {}) {
  const {
    port,
    timeoutMs = 12000,
    maxBytes = 512 * 1024,
    signal,
    headers = {},
    verifyTls = false,
    redirects = 5,
  } = opts;

  return new Promise((resolve) => {
    const startNs = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - startNs) / 1e6;
    const result = {
      ok: false, status: 0, body: '', headers: {}, finalUrl: url,
      error: null, elapsedMs: 0, truncated: false,
    };

    let finished = false;
    let req = null;

    const cleanup = () => {
      clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (err && !result.error) result.error = err.message || String(err);
      result.elapsedMs = elapsed();
      try { req && req.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const onAbort = () => finish(new Error('aborted'));
    if (signal) {
      if (signal.aborted) { result.error = 'aborted'; return resolve(result); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const hardTimer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    const go = (target, hop) => {
      const isHttps = /^https:/i.test(target);
      const lib = isHttps ? https : http;
      let urlObj;
      try { urlObj = new URL(target); } catch { return finish(new Error('bad url')); }

      try {
        const agent = agentFor(port, target, {
          connectTimeout: Math.min(timeoutMs, 10000),
          verifyTls,
        });
        req = lib.get(
          target,
          {
            agent,
            // Some sites (e.g. gemini.google.com) send response headers well
            // over Node's 16KB default, which fails with "Header overflow".
            maxHeaderSize: 128 * 1024,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) clash-nodepilot/1.0',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'identity',
              ...headers,
            },
          },
          (res) => {
            const code = res.statusCode || 0;
            const loc = res.headers.location;

            if ([301, 302, 303, 307, 308].includes(code) && loc && hop < redirects) {
              res.resume();
              const next = new URL(loc, target).toString();
              result.finalUrl = next;
              req.destroy();
              finished = false; // allow the follow-up request to finish
              return go(next, hop + 1);
            }

            result.status = code;
            result.headers = res.headers;
            const chunks = [];
            let size = 0;

            res.on('data', (c) => {
              if (size < maxBytes) {
                chunks.push(c);
                size += c.length;
              } else {
                result.truncated = true;
              }
            });
            res.on('end', () => {
              result.body = Buffer.concat(chunks).toString('utf8');
              result.ok = code > 0 && code < 400;
              finish(null);
            });
            res.on('error', (e) => finish(e));
          }
        );
        req.on('error', (e) => finish(e));
      } catch (err) {
        finish(err);
      }
    };

    go(url, 0);
  });
}
