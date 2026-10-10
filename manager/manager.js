// Manager page: probes each queued stream, lets the user pick a quality,
// downloads/decrypts/assembles, then hands the result to chrome.downloads.
// Runs as a normal extension page so Blob/URL/crypto.subtle are available.

import { downloadHLS, downloadDASH, probe } from '../lib/downloader.js';
import { pickVideoRepresentations, pickAudioRepresentation } from '../lib/dash.js';
import { formatBytes, formatSpeed, formatDuration, hostOf, applyFilenameTemplate } from '../lib/util.js';

const send = (msg) => chrome.runtime.sendMessage(msg);
const i18n = (key, subs, fallback) => chrome.i18n.getMessage(key, subs) || fallback || key;

function i18nPass() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const t = chrome.i18n.getMessage(el.dataset.i18n);
    if (t) el.textContent = t;
  }
}

let settings = { concurrency: 6, saveAs: false, downloadSubdir: '', filenameTemplate: '{title}.{ext}' };

const jobsEl = document.getElementById('jobs');
const emptyEl = document.getElementById('empty');
const jobs = new Map();
let jobSeq = 0;

class Job {
  constructor({ id, name, url, referer, type, title }) {
    this.uid = ++jobSeq;
    this.mediaId = id || null;
    this.name = name;
    this.url = url;
    this.referer = referer || '';
    this.type = type;
    this.title = title || '';
    this.status = 'probing'; // probing | ready | running | saving | done | error | cancelled
    this.progress = { done: 0, total: 0, receivedBytes: 0 };
    this.speed = 0;
    this.error = null;
    this.probeResult = null;
    this.variantUrl = null;
    this.repIndex = 0;
    this.withAudio = false;
    this.controller = null;
    this.el = null;
  }

  async probe() {
    try {
      const res = await probe(this.url, { referer: this.referer });
      this.probeResult = res;
      this.status = 'ready';
      if (res.kind === 'hls-media' && res.live) {
        this.error = { code: 'LIVE_WARN' };
      }
    } catch (e) {
      this.status = 'error';
      this.error = e;
    }
    renderJob(this);
  }

  async start() {
    if (this.status === 'running') return;
    this.controller = new AbortController();
    this.status = 'running';
    this.error = null;
    renderJob(this);

    const onProgress = (p) => {
      this.progress = p;
      renderJob(this);
    };

    try {
      const allowLive = !!this.error && this.error.code === 'LIVE_WARN';
      let result;
      if (this.type === 'hls') {
        result = await downloadHLS({
          url: this.url,
          variantUrl: this.variantUrl,
          referer: this.referer,
          concurrency: settings.concurrency,
          allowLive,
          onProgress,
          signal: this.controller.signal,
        });
      } else if (this.type === 'dash') {
        const reps = this.dashReps();
        const rep = reps[this.repIndex] || reps[0];
        if (!rep) throw new Error('No representation selected');
        result = await downloadDASH({
          representation: rep,
          referer: this.referer,
          concurrency: settings.concurrency,
          onProgress,
          signal: this.controller.signal,
        });
        if (this.withAudio) {
          const audioRep = pickAudioRepresentation(this.probeResult.mpd);
          if (audioRep) {
            await saveBlob(
              await downloadDASH({
                representation: audioRep,
                referer: this.referer,
                concurrency: settings.concurrency,
                signal: this.controller.signal,
              }),
              this.buildFilename(audioExt(audioRep)),
              this
            );
          }
        }
      } else {
        throw new Error(`Unsupported stream type: ${this.type}`);
      }

      this.status = 'saving';
      renderJob(this);
      await saveBlob(result, this.buildFilename(result.ext), this);
      this.status = 'done';
      this.progress = { done: 1, total: 1, receivedBytes: result.receivedBytes || this.progress.receivedBytes };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        this.status = 'cancelled';
      } else {
        this.status = 'error';
        this.error = e;
      }
    }
    renderJob(this);
  }

  cancel() {
    if (this.controller) this.controller.abort();
    if (this.status === 'probing' || this.status === 'ready') {
      this.status = 'cancelled';
      renderJob(this);
    }
  }

  dashReps() {
    if (this.probeResult && this.probeResult.kind === 'dash') {
      return pickVideoRepresentations(this.probeResult.mpd);
    }
    return [];
  }

  buildFilename(ext) {
    const name = applyFilenameTemplate(settings.filenameTemplate, {
      title: this.title || this.name,
      host: hostOf(this.referer || this.url),
      ext,
      url: this.url,
    });
    return settings.downloadSubdir ? `${settings.downloadSubdir}/${name}` : name;
  }
}

function audioExt(rep) {
  return (rep.mimeType || '').startsWith('audio/webm') ? 'weba' : 'm4a';
}

async function saveBlob(result, filename, job) {
  const blobUrl = URL.createObjectURL(result.blob);
  try {
    const dlId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: settings.saveAs,
    });
    // Keep the object URL alive until the download finishes, then revoke.
    const timer = setTimeout(revoke, 10 * 60 * 1000);
    function revoke() {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      URL.revokeObjectURL(blobUrl);
    }
    const listener = (delta) => {
      if (delta.id === dlId && delta.state && delta.state.current && delta.state.current !== 'in_progress') revoke();
    };
    chrome.downloads.onChanged.addListener(listener);
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusBadge(job) {
  const map = {
    probing: ['statusProbing', ''],
    ready: ['statusReady', ''],
    running: ['statusDownloading', ''],
    saving: ['statusSaving', ''],
    done: ['statusDone', 'ok'],
    error: ['statusError', 'err'],
    cancelled: ['statusCancelled', 'warn'],
  };
  const [key, cls] = map[job.status] || ['statusProbing', ''];
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = i18n(key);
  return b;
}

function fmtMbps(bw) {
  return `${(bw / 1e6).toFixed(1)} Mbps`;
}

function variantLabel(v, idx) {
  const bits = [];
  if (v.height) bits.push(`${v.height}p`);
  bits.push(fmtMbps(v.bandwidth));
  if (v.name) bits.push(v.name);
  return bits.join(' · ');
}

function repLabel(r) {
  const bits = [];
  if (r.height) bits.push(`${r.width}×${r.height}`);
  bits.push(fmtMbps(r.bandwidth));
  if (r.codecs) bits.push(r.codecs);
  return bits.join(' · ');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderJob(job) {
  let card = job.el;
  if (!card || !jobsEl.contains(card)) {
    card = buildCard(job);
    job.el = card;
    jobsEl.append(card);
  }
  card.textContent = '';

  // Header row
  const top = el('div', 'job-top');
  top.append(el('div', 'job-name', job.name), statusBadge(job));
  const urlRow = el('div', 'job-url', job.url);

  // Config row (quality picker) — shown when ready and stream has variants
  const config = el('div', 'job-config');
  if (job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') {
    const pr = job.probeResult;
    if (pr && pr.kind === 'hls-master' && pr.variants.length > 0) {
      config.append(el('label', null, i18n('pickQuality')));
      const sel = el('select');
      pr.variants
        .slice()
        .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))
        .forEach((v, i) => {
          const opt = el('option', null, variantLabel(v, i));
          opt.value = v.url;
          sel.append(opt);
        });
      sel.value = job.variantUrl || sel.value;
      sel.addEventListener('change', () => (job.variantUrl = sel.value));
      config.append(sel);
    } else if (pr && pr.kind === 'dash') {
      const reps = job.dashReps();
      if (reps.length) {
        config.append(el('label', null, i18n('pickQuality')));
        const sel = el('select');
        reps.forEach((r, i) => {
          const opt = el('option', null, repLabel(r));
          sel.append(opt);
        });
        sel.value = job.repIndex;
        sel.addEventListener('change', () => (job.repIndex = sel.selectedIndex));
        config.append(sel);
      }
      const audioRep = pickAudioRepresentation(pr.mpd);
      if (audioRep) {
        const check = el('label', 'check');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = job.withAudio;
        cb.addEventListener('change', () => (job.withAudio = cb.checked));
        check.append(cb, document.createTextNode(i18n('includeAudio')));
        config.append(check);
      }
    }
  }

  // Progress bar + stats
  const bar = el('div', 'bar');
  const fill = el('div', `bar-fill${job.status === 'error' ? ' err' : ''}`);
  const { done, total, receivedBytes } = job.progress;
  fill.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : job.status === 'done' ? '100%' : '0%';
  bar.append(fill);

  const stats = el('div', 'job-stats');
  if (total) stats.append(el('span', null, i18n('segmentsLabel', [String(done), String(total)])));
  stats.append(el('span', null, formatBytes(receivedBytes)));
  if (job.status === 'running') {
    const dt = (Date.now() - (job._t0 || (job._t0 = Date.now()))) / 1000;
    stats.append(el('span', null, formatSpeed(receivedBytes / Math.max(dt, 0.001))));
  }
  if (job.probeResult && job.probeResult.kind === 'hls-media') {
    const p = job.probeResult;
    const info = [];
    if (p.duration) info.push(formatDuration(p.duration));
    if (p.encrypted) info.push(i18n('encryptedLabel'));
    if (p.live) info.push(i18n('liveLabel'));
    if (info.length) stats.append(el('span', null, info.join(' · ')));
  }

  // Actions
  const actions = el('div', 'job-actions');
  if (job.status === 'ready' || job.status === 'error' || job.status === 'cancelled') {
    const startBtn = el('button', 'btn primary', job.error && job.error.code === 'LIVE_WARN' ? i18n('downloadAnyway') : i18n('startDownload'));
    startBtn.addEventListener('click', () => job.start());
    actions.append(startBtn);
  }
  if (job.status === 'running' || job.status === 'saving') {
    const cancelBtn = el('button', 'btn subtle', i18n('cancel'));
    cancelBtn.addEventListener('click', () => job.cancel());
    actions.append(cancelBtn);
  }
  if (job.status === 'done') {
    actions.append(el('button', 'btn ghost', i18n('statusDone') + ' ✓'));
  }

  card.append(top, urlRow, config, bar, stats, actions);

  // Error message
  const err = currentError(job);
  if (err) {
    const box = el('div', 'job-error');
    if (err.code === 'LIVE_WARN') {
      box.textContent = i18n('liveWarning');
    } else if (err.code === 'DRM') {
      box.textContent = i18n('errDrm');
    } else if (err.code === 'ENCRYPTION') {
      box.textContent = i18n('errEncryption');
    } else if (err.code === 'LIVE') {
      box.textContent = i18n('errLive');
    } else {
      box.textContent = `${i18n('errFetch')}: ${err.message || err}`;
    }
    card.append(box);
  }
}

function currentError(job) {
  if (job.status === 'error' && job.error) return job.error;
  if (job.error && job.error.code === 'LIVE_WARN' && job.status !== 'done') return job.error;
  return null;
}

function buildCard(job) {
  const card = el('div', 'job');
  card.dataset.uid = String(job.uid);
  return card;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  i18nPass();

  const s = await send({ cmd: 'settings.get' });
  if (s && s.ok) settings = { ...settings, ...s.settings };

  const params = new URLSearchParams(location.search);
  const ids = params.getAll('id');
  const urlEntries = params.getAll('url').map((u) => ({ url: u, name: params.get('name') || '' }));

  const records = [];
  let hasErrorCards = false;
  for (const id of ids) {
    const res = await send({ cmd: 'manager.getMedia', id });
    if (res && res.ok) records.push(res);
    else {
      addJobCardError(i18n('expiredSource'));
      hasErrorCards = true;
    }
  }
  for (const e of urlEntries) {
    records.push({ rec: { id: null, url: e.url, referer: '', type: guessType(e.url), ext: '' }, title: e.name });
  }

  for (const r of records) addJob(r);
  emptyEl.classList.toggle('hidden', jobs.size > 0 || hasErrorCards);

  window.addEventListener('beforeunload', (e) => {
    for (const job of jobs.values()) {
      if (job.status === 'running' || job.status === 'saving') {
        e.preventDefault();
        e.returnValue = '';
        return;
      }
    }
  });
}

function guessType(url) {
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  return 'file';
}

function addJob(r) {
  const job = new Job({
    id: r.rec.id,
    name: r.title || r.rec.url,
    url: r.rec.url,
    referer: r.rec.referer || r.rec.pageUrl || '',
    type: r.rec.type,
    title: r.title || '',
  });
  jobs.set(job.uid, job);
  renderJob(job);
  job.probe();
}

function addJobCardError(message) {
  const card = el('div', 'job');
  card.append(el('div', 'job-top', message), el('div', 'job-error', message));
  jobsEl.append(card);
}

init();
