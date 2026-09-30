// clash-nodepilot — frontend controller
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(`/api${path}`, opts);

const state = {
  results: [],
  filtered: [],
  selected: new Set(),
  sortKey: 'download',
  sortDir: 'desc',
  testing: false,
  phase: 'idle',
  phaseLabel: '',
  phaseDone: 0,
  phaseTotal: 0,
  startedAt: null,
  coreReady: false,
  busy: false,
  nodeCount: 0,
  uploadEnabled: false,
};

// ---------------- formatting ----------------
/** Short labels for unlock chips (keeps the column narrow). */
const UNLOCK_SHORT = {
  chatgpt: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
  youtube: 'YT',
  netflix: 'NF',
  disney: 'D+',
  spotify: 'Spotify',
  tiktok: 'TikTok',
  primevideo: 'Prime',
  'openai-api': 'OpenAI',
  'bilibili-hk': 'B站港澳台',
};

function fmtSpeed(bps) {
  if (!bps || !Number.isFinite(bps) || bps <= 0) return '—';
  const mb = bps / 1048576;
  if (mb >= 1) return `${mb.toFixed(2)} MB/s`;
  const kb = bps / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtMs(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${Math.round(v)} ms`;
}

function fmtLoss(v) {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(1)}%`;
}

function speedClass(bps) {
  if (!bps) return 'val-dim';
  const mb = bps / 1048576;
  if (mb >= 10) return 'val-ok';
  if (mb >= 3) return 'val-warn';
  return 'val-bad';
}

function latencyClass(ms) {
  if (ms === null || ms === undefined) return 'val-dim';
  if (ms <= 200) return 'val-ok';
  if (ms <= 500) return 'val-warn';
  return 'val-bad';
}

function lossClass(v) {
  if (v === null || v === undefined) return 'val-dim';
  if (v <= 0) return 'val-ok';
  if (v < 30) return 'val-warn';
  return 'val-bad';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

// ---------------- core status ----------------
async function refreshStatus() {
  try {
    const res = await api('/status');
    const s = await res.json();
    const badge = $('coreBadge');
    const text = $('coreBadgeText');

    if (s.coreInfo) {
      state.coreReady = true;
      badge.className = 'badge ok';
      const ver = (s.coreInfo.version || '').split('\n')[0].replace(/\s+/g, ' ');
      text.textContent = s.corePath ? s.corePath.split(/[\\/]/).pop() : '内核就绪';
      badge.title = `${s.coreInfo.path}\n${ver}`;
    } else {
      state.coreReady = false;
      badge.className = 'badge bad';
      text.textContent = '未找到内核';
      badge.title = s.coreError || '未找到 mihomo 内核，请指定路径';
    }
    updateButtons();
  } catch {
    const badge = $('coreBadge');
    badge.className = 'badge bad';
    $('coreBadgeText').textContent = '无法连接';
  }
}

// ---------------- load subscription ----------------
async function loadSource() {
  const source = $('source').value.trim();
  const msg = $('sourceMsg');
  if (!source) {
    msg.className = 'msg error';
    msg.textContent = '请输入订阅地址或配置文件路径';
    return;
  }

  msg.className = 'msg info';
  msg.innerHTML = '<span class="tb-spinner"></span> 正在读取配置并启动内核…';
  $('btnLoad').disabled = true;

  try {
    const res = await api('/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        userAgent: $('userAgent').value.trim(),
        limit: Number($('nodeLimit').value) || 0,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      msg.className = 'msg error';
      msg.textContent = data.error || '读取失败';
      toast(data.error || '读取失败', 'error');
      return;
    }

    msg.className = 'msg ok';
    msg.textContent = `已就绪：${data.nodeCount} 个节点（可测速端口 ${data.readyCount} 个）`;
    toast(`已加载 ${data.nodeCount} 个节点`, 'ok');
    $('resultHint').textContent = `共 ${data.nodeCount} 个节点，等待测速`;
    state.nodeCount = data.readyCount || data.nodeCount;
    if (data.warnings?.length) {
      console.warn('warnings:', data.warnings);
    }
    state.selected.clear();
    state.results = [];
    render();
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = `请求失败: ${err.message}`;
  } finally {
    $('btnLoad').disabled = false;
    updateButtons();
  }
}

// ---------------- test control ----------------
function collectConfig() {
  const num = (id, dflt) => {
    const v = Number($(id).value);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const selectedServices = [...document.querySelectorAll('#unlockServices input:checked')]
    .map((cb) => cb.value);
  return {
    latencyRounds: num('cfgLatencyRounds', 4),
    latencyConcurrency: num('cfgLatencyConc', 4),
    latencyTimeoutMs: num('cfgLatencyTimeout', 5000),
    downloadConcurrency: num('cfgDlConc', 4),
    downloadDurationMs: num('cfgDlDuration', 6) * 1000,
    maxLatencyMs: Number($('cfgMaxLatency').value) || 0,
    downloadUrl: $('cfgDlUrl').value.trim() || undefined,
    downloadFallback: $('cfgDlFallback').checked,
    uploadEnabled: $('cfgUploadEnabled').checked,
    uploadUrl: $('cfgUploadUrl').value.trim() || undefined,
    uploadBytes: num('cfgUploadBytes', 10) * 1048576,
    uploadDurationMs: num('cfgUploadDuration', 5) * 1000,
    unlockEnabled: $('cfgUnlockEnabled').checked,
    unlockServiceIds: selectedServices.length ? selectedServices : null,
  };
}

async function startTest() {
  try {
    const cfg = collectConfig();
    state.testing = true;
    state.startedAt = Date.now();
    state.phase = 'idle';
    state.phaseDone = 0;
    state.phaseTotal = 0;
    state.uploadEnabled = !!cfg.uploadEnabled;
    updateButtons();

    const res = await api('/test/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || '无法开始测速', 'error');
      state.testing = false;
      updateButtons();
    } else {
      toast(`开始测速 ${data.total} 个节点`);
    }
  } catch (err) {
    toast(`请求失败: ${err.message}`, 'error');
    state.testing = false;
    updateButtons();
  }
}

async function stopTest() {
  await api('/test/stop', { method: 'POST' });
  toast('已请求停止…');
}

// ---------------- filtering / sorting ----------------
function readFilters() {
  const requiredUnlock = [...($('fUnlockRequired')?.selectedOptions || [])].map((o) => o.value);
  return {
    maxLatencyMs: Number($('fMaxLatency').value) || 0,
    minDownloadMBs: Number($('fMinDown').value) || 0,
    maxPacketLoss: $('fMaxLoss').value === '' ? 100 : Number($('fMaxLoss').value),
    nameRegex: $('fInclude').value.trim(),
    excludeRegex: $('fExclude').value.trim(),
    onlyWorking: $('fOnlyWorking').checked,
    requireUnlock: requiredUnlock,
  };
}

function isUsable(r) {
  return r.status === 'done' && r.latency !== null;
}

/** True when the node reported the given service as unlocked. */
function isUnlocked(result, serviceId) {
  if (!serviceId || !Array.isArray(result.unlock)) return false;
  return result.unlock.some((u) => u.id === serviceId && u.status === 'unlocked');
}

/** Compact unlock badges for the results table. */
function renderUnlockCell(r) {
  if (!Array.isArray(r.unlock) || !r.unlock.length) {
    return '<span class="val-dim">—</span>';
  }
  const chips = r.unlock.map((u) => {
    const short = UNLOCK_SHORT[u.id] || u.id;
    const cls = u.status === 'unlocked' ? 'u-ok'
      : u.status === 'blocked' ? 'u-no'
        : 'u-unknown';
    const title = `${u.name}: ${u.status === 'unlocked' ? '已解锁' : u.status === 'blocked' ? '被封锁' : u.status === 'failed' ? '检测失败' : '未知'}${u.region ? ` · 出口 ${u.region}` : ''}${u.detail ? ` · ${u.detail}` : ''}`;
    return `<span class="uchip ${cls}" title="${escapeHtml(title)}">${escapeHtml(short)}</span>`;
  }).join('');
  return `<div class="uchips">${chips}</div>`;
}

function applyLocalView() {
  const f = readFilters();
  const search = $('search').value.trim().toLowerCase();
  const status = $('filterStatus').value;

  let re = null;
  let exRe = null;
  try { if (f.nameRegex) re = new RegExp(f.nameRegex, 'i'); } catch { re = null; }
  try { if (f.excludeRegex) exRe = new RegExp(f.excludeRegex, 'i'); } catch { exRe = null; }

  const unlockFilter = $('filterUnlock')?.value || '';

  let rows = state.results.filter((r) => {
    if (search && !String(r.name).toLowerCase().includes(search)) return false;
    if (status === 'usable' && !isUsable(r)) return false;
    if (status === 'failed' && isUsable(r)) return false;
    if (unlockFilter && !isUnlocked(r, unlockFilter)) return false;
    return true;
  });

  // Match count reflects the export filters, independent of the search box.
  const required = [...($('fUnlockRequired')?.selectedOptions || [])].map((o) => o.value);
  const matched = rows.filter((r) => {
    if (re && !re.test(r.name)) return false;
    if (exRe && exRe.test(r.name)) return false;
    if (f.onlyWorking && !isUsable(r)) return false;
    if (f.maxLatencyMs > 0 && (r.latency === null || r.latency > f.maxLatencyMs)) return false;
    if (r.packetLoss !== null && f.maxPacketLoss < 100 && r.packetLoss > f.maxPacketLoss) return false;
    if (f.minDownloadMBs > 0) {
      const mb = r.downloadBps ? r.downloadBps / 1048576 : 0;
      if (mb < f.minDownloadMBs) return false;
    }
    for (const id of required) {
      if (!isUnlocked(r, id)) return false;
    }
    return true;
  });

  $('matchCount').textContent = `符合条件：${matched.length} 个`;

  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  rows.sort((a, b) => {
    let av;
    let bv;
    switch (key) {
      case 'latency': av = a.latency ?? Infinity; bv = b.latency ?? Infinity; break;
      case 'jitter': av = a.jitter ?? Infinity; bv = b.jitter ?? Infinity; break;
      case 'loss': av = a.packetLoss ?? Infinity; bv = b.packetLoss ?? Infinity; break;
      case 'download': av = a.downloadBps ?? -1; bv = b.downloadBps ?? -1; break;
      case 'name': return String(a.name).localeCompare(String(b.name), 'zh') * dir;
      case 'type': return String(a.type).localeCompare(String(b.type)) * dir;
      default: av = 0; bv = 0;
    }
    if (av === bv) return String(a.name).localeCompare(String(b.name), 'zh');
    return (av - bv) * dir;
  });

  state.filtered = rows;
  return matched;
}

// ---------------- rendering ----------------
function render() {
  const matched = applyLocalView();
  const tbody = $('tbody');
  const rows = state.filtered;

  $('emptyState').classList.toggle('hidden', rows.length > 0);

  const maxSpeed = Math.max(...state.results.map((r) => r.downloadBps || 0), 1);

  tbody.innerHTML = rows.map((r, i) => {
    const usable = isUsable(r);
    const rankClass = usable && i < 3 && state.sortKey === 'download' && state.sortDir === 'desc'
      ? ` rank-${i + 1}` : '';
    const deadClass = usable ? '' : ' dead';
    const upClass = r.status === 'upload' ? ' uploading' : '';
    const barW = usable && r.downloadBps ? Math.max(2, (r.downloadBps / maxSpeed) * 56) : 0;

    let statusNote = '';
    if (r.status === 'pending') statusNote = '<span class="val-dim">等待中</span>';
    else if (r.status === 'testing') statusNote = '<span class="tb-spinner"></span>';
    else if (r.status === 'download' || r.status === 'upload') statusNote = '<span class="tb-spinner"></span>';
    else if (r.status === 'error' || r.status === 'aborted') statusNote = `<span class="val-dim">${escapeHtml(r.error || '失败')}</span>`;

    const checked = state.selected.has(r.name) ? 'checked' : '';

    return `
      <tr class="${rankClass}${deadClass}${upClass}">
        <td class="idx">${i + 1}</td>
        <td><input type="checkbox" class="row-check" data-name="${escapeHtml(r.name)}" ${checked} ${usable ? '' : 'disabled'} /></td>
        <td class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}${statusNote ? ' ' + statusNote : ''}</td>
        <td><span class="pill">${escapeHtml(r.type || '?')}</span></td>
        <td class="num ${latencyClass(r.latency)}">${fmtMs(r.latency)}</td>
        <td class="num ${r.jitter !== null && r.jitter <= 50 ? 'val-ok' : 'val-dim'}">${r.jitter === null || r.jitter === undefined ? '—' : Math.round(r.jitter) + ' ms'}</td>
        <td class="num ${lossClass(r.packetLoss)}">${fmtLoss(r.packetLoss)}</td>
        <td class="num">
          <div class="speed-cell">
            ${usable && r.downloadBps ? `<span class="speed-bar" style="width:${barW}px"></span>` : ''}
            <span class="speed-num ${speedClass(r.downloadBps)}">${fmtSpeed(r.downloadBps)}</span>
          </div>
        </td>
        <td class="unlock-cell">${renderUnlockCell(r)}</td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.row-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const name = e.target.dataset.name;
      if (e.target.checked) state.selected.add(name);
      else state.selected.delete(name);
    });
  });

  renderStats(matched);
}

function renderStats(matchedCount) {
  const results = state.results;
  $('statTotal').textContent = results.length || '–';

  const usable = results.filter(isUsable);
  $('statUsable').textContent = results.length ? `${usable.length}` : '–';
  $('statUsable').className = `stat-value ${usable.length ? 'ok' : ''}`;

  const withSpeed = usable.filter((r) => r.downloadBps > 0);
  if (withSpeed.length) {
    const best = withSpeed.reduce((a, b) => (a.downloadBps > b.downloadBps ? a : b));
    $('statBest').textContent = fmtSpeed(best.downloadBps);
    $('statBest').className = 'stat-value ok small';
    $('statBest').title = best.name;

    const avg = withSpeed.reduce((s, r) => s + r.downloadBps, 0) / withSpeed.length;
    $('statAvg').textContent = fmtSpeed(avg);
    $('statAvg').className = 'stat-value small';
  } else {
    $('statBest').textContent = results.length ? '—' : '–';
    $('statAvg').textContent = results.length ? '—' : '–';
  }

  const total = state.phaseTotal || results.length;
  const done = state.phaseDone || 0;

  // Report progress within the current phase, and roll phases into one
  // monotonic overall bar so it never sits still or moves backwards.
  const weights = state.uploadEnabled
    ? { latency: [0, 0.15], download: [0.15, 0.75], upload: [0.75, 1] }
    : { latency: [0, 0.3], download: [0.3, 1], upload: [1, 1] };
  const [lo, hi] = weights[state.phase] || [0, 1];
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const overall = state.phase === 'idle'
    ? 0
    : state.phase === 'finished'
      ? 1
      : lo + (hi - lo) * frac;

  $('progressText').textContent = `${done} / ${total || 0}`;
  $('progressBar').style.width = `${(overall * 100).toFixed(1)}%`;

  if (state.startedAt && state.testing && done > 0) {
    const elapsed = Date.now() - state.startedAt;
    const eta = overall > 0.02 ? (elapsed / overall) * (1 - overall) : 0;
    if (Number.isFinite(eta) && eta < 3600000) {
      $('progressEta').textContent =
        `已用 ${Math.round(elapsed / 1000)}s · 约剩余 ${Math.round(eta / 1000)}s`;
    }
  } else if (!state.testing) {
    $('progressEta').textContent = '';
  }

  $('resultHint').textContent = results.length
    ? `${results.length} 个节点，${usable.length} 个可用`
    : '尚无数据';
}

// ---------------- SSE ----------------
/** Idempotent completion transition; safe to call from multiple events. */
function markFinished() {
  const wasTesting = state.testing;
  state.testing = false;
  state.startedAt = null;
  $('phaseHint').textContent = '已完成';
  updateButtons();
  if (wasTesting) toast('测速完成', 'ok');
}

function connectEvents() {
  const es = new EventSource('/api/events');

  es.addEventListener('progress', (e) => {
    const snap = JSON.parse(e.data);
    state.results = snap.results || [];
    if (snap.phase) state.phase = snap.phase;
    if (Number.isFinite(snap.phaseDone)) state.phaseDone = snap.phaseDone;
    if (Number.isFinite(snap.phaseTotal)) state.phaseTotal = snap.phaseTotal;
    if (snap.running !== undefined) {
      const wasTesting = state.testing;
      state.testing = snap.running;
      if (wasTesting && !snap.running) {
        // Derive completion from state rather than relying on catching the
        // transient 'finished' phase event, which is lost across an SSE
        // reconnect and would otherwise leave the UI stuck on "测速中".
        state.startedAt = null;
        markFinished();
      }
    }
    render();
    updateButtons();
  });

  es.addEventListener('phase', (e) => {
    const p = JSON.parse(e.data);
    if (p.phase === 'finished') {
      state.phase = 'finished';
      markFinished();
    } else {
      state.phase = p.phase;
      state.phaseLabel = p.label || '';
      if (Number.isFinite(p.total)) state.phaseTotal = p.total;
      state.phaseDone = 0;
      $('phaseHint').textContent = `${p.label} (${p.total})`;
    }
    updateButtons();
  });

  es.addEventListener('busy', (e) => {
    state.busy = JSON.parse(e.data).busy;
    updateButtons();
  });

  es.addEventListener('log', (e) => {
    const { line } = JSON.parse(e.data);
    appendLog(line);
  });

  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

function appendLog(line) {
  const body = $('logBody');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  body.textContent += `${line}\n`;
  if (body.textContent.length > 200000) body.textContent = body.textContent.slice(-150000);
  if (atBottom) body.scrollTop = body.scrollHeight;
}

async function fetchLogs() {
  const res = await api('/logs');
  const data = await res.json();
  $('logBody').textContent = [
    '--- 应用日志 ---',
    ...(data.logs || []),
    '',
    '--- 内核日志 ---',
    ...(data.coreLogs || []),
  ].join('\n');
  $('logBody').scrollTop = $('logBody').scrollHeight;
}

// ---------------- export ----------------
function exportBody() {
  return {
    filters: readFilters(),
    selected: $('fUseSelected').checked ? [...state.selected] : [],
    groupName: $('fGroupName').value.trim() || '🚀 节点选择',
    rename: $('fRename').checked,
    includeAutoGroups: $('fAutoGroups').checked,
    keepOriginalRules: $('fKeepRules').checked,
  };
}

async function previewExport() {
  const msg = $('exportMsg');
  msg.className = 'msg info';
  msg.textContent = '正在生成预览…';
  try {
    const res = await api('/export/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportBody()),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.className = 'msg error';
      msg.textContent = data.error;
      $('preview').classList.add('hidden');
      return;
    }
    $('preview').textContent = data.content;
    $('preview').classList.remove('hidden');
    msg.className = 'msg ok';
    msg.textContent = `预览 ${data.count} 个节点`;
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
}

async function saveExport() {
  const msg = $('exportMsg');
  msg.className = 'msg info';
  msg.textContent = '正在写入文件…';
  try {
    const res = await api('/export/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportBody()),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.className = 'msg error';
      msg.textContent = data.error;
      toast(data.error, 'error');
      return;
    }
    msg.className = 'msg ok';
    msg.textContent = `已保存 ${data.count} 个节点 → ${data.path}`;
    toast(`已保存 ${data.count} 个节点`, 'ok');
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
}

async function downloadExport() {
  try {
    const res = await api('/export/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportBody()),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || '导出失败', 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nodepilot.yaml';
    a.click();
    URL.revokeObjectURL(url);
    toast('已开始下载', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------- unlock services ----------------
/** Populate the service checkboxes and the unlock filter dropdowns. */
async function loadUnlockServices() {
  try {
    const res = await api('/unlock/services');
    const data = await res.json();
    const services = data.services || [];
    state.unlockServices = services;

    const box = $('unlockServices');
    box.innerHTML = services.map((s) => `
      <label class="check ucheck">
        <input type="checkbox" value="${escapeHtml(s.id)}" checked />
        <span>${escapeHtml(s.name)}</span>
      </label>`).join('');

    const filter = $('filterUnlock');
    filter.innerHTML = '<option value="">解锁：不限</option>' +
      services.map((s) => `<option value="${escapeHtml(s.id)}">仅看已解锁 ${escapeHtml(s.name)}</option>`).join('');

    const required = $('fUnlockRequired');
    required.innerHTML = services.map((s) =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    required.size = Math.min(services.length, 6);
  } catch {
    // The feature simply stays hidden if the catalogue cannot be loaded.
  }
}

// ---------------- UI state ----------------
function updateButtons() {
  // A test can only start once nodes have been loaded into the core; results
  // are empty before the first run, so nodeCount (not results) is the gate.
  const hasNodes = state.nodeCount > 0;
  $('btnStart').disabled = !state.coreReady || state.testing || state.busy || !hasNodes;
  $('btnStop').disabled = !state.testing;
  if (state.testing) {
    $('btnStart').textContent = '⏳ 测速中…';
  } else {
    $('btnStart').textContent = '▶ 开始测速';
  }
}

// ---------------- wiring ----------------
function init() {
  // theme
  const savedTheme = localStorage.getItem('np-theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;
  $('btnTheme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('np-theme', next);
  });

  // persist source
  const savedSource = localStorage.getItem('np-source');
  if (savedSource) $('source').value = savedSource;
  $('source').addEventListener('change', () => {
    localStorage.setItem('np-source', $('source').value.trim());
  });

  $('btnLoad').addEventListener('click', loadSource);
  $('source').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSource(); });
  $('btnClearSource').addEventListener('click', () => {
    $('source').value = '';
    localStorage.removeItem('np-source');
  });
  $('btnPaste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $('source').value = text.trim();
        localStorage.setItem('np-source', text.trim());
        toast('已粘贴');
      }
    } catch {
      toast('浏览器拒绝了剪贴板访问，请手动粘贴', 'error');
    }
  });

  $('btnStart').addEventListener('click', startTest);
  $('btnStop').addEventListener('click', stopTest);
  $('btnAdvanced').addEventListener('click', () => {
    $('advanced').classList.toggle('hidden');
  });
  $('cfgUploadEnabled').addEventListener('change', (e) => {
    $('uploadOpts').hidden = !e.target.checked;
  });
  $('cfgUnlockEnabled').addEventListener('change', (e) => {
    $('unlockOpts').hidden = !e.target.checked;
  });

  // results table
  $('search').addEventListener('input', render);
  $('filterStatus').addEventListener('change', render);
  $('filterUnlock').addEventListener('change', render);
  $('fUnlockRequired').addEventListener('change', render);
  $('filterSort').addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split(':');
    const map = { download: ['download', 'desc'], latency: ['latency', 'asc'], jitter: ['jitter', 'asc'], loss: ['loss', 'asc'], name: ['name', 'asc'] };
    const [k, d] = map[key] || ['download', 'desc'];
    state.sortKey = k;
    state.sortDir = d;
    render();
  });

  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'download' ? 'desc' : 'asc';
      }
      document.querySelectorAll('th.sortable').forEach((t) => t.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      render();
    });
  });

  $('checkAll').addEventListener('change', (e) => {
    const usable = state.filtered.filter(isUsable);
    if (e.target.checked) usable.forEach((r) => state.selected.add(r.name));
    else usable.forEach((r) => state.selected.delete(r.name));
    render();
  });

  // export filters
  for (const id of ['fMaxLatency', 'fMinDown', 'fMaxLoss', 'fInclude', 'fExclude', 'fOnlyWorking']) {
    $(id).addEventListener('input', render);
    $(id).addEventListener('change', render);
  }
  $('btnPreview').addEventListener('click', previewExport);
  $('btnSave').addEventListener('click', saveExport);
  $('btnDownload').addEventListener('click', downloadExport);

  // logs
  $('btnLogs').addEventListener('click', async () => {
    $('logDrawer').classList.remove('hidden');
    await fetchLogs();
  });
  $('btnCloseLogs').addEventListener('click', () => $('logDrawer').classList.add('hidden'));
  $('btnClearLogs').addEventListener('click', () => { $('logBody').textContent = ''; });

  refreshStatus();
  connectEvents();
  loadUnlockServices();
  updateButtons();

  setInterval(() => { if (state.testing) renderStats(); }, 1000);
}

document.addEventListener('DOMContentLoaded', init);
