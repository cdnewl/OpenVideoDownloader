// Open Video Downloader — background service worker (MV3, ES module).
// Responsibilities:
//   1. Sniff network traffic for media (m3u8/mpd/mp4/webm/... via webRequest).
//   2. Keep a per-tab media database, persisted in storage.session.
//   3. Serve popup / manager requests, drive the action badge.
//   4. Direct-file downloads (with temporary Referer unlock via DNR).

import {
  classifyUrl,
  classifyContentType,
  extFromContentType,
  mediaKey,
  hostOf,
  applyFilenameTemplate,
  SETTING_DEFAULTS,
} from '../lib/util.js';
import { parseM3U8 } from '../lib/hls.js';

const DB_KEY = 'ovd_db';
const REQ_FILTER = { urls: ['http://*/*', 'https://*/*'] };
const REQ_TYPES = new Set(['media', 'xmlhttprequest', 'other']);

// db shape: { [tabId]: { title, pageUrl, items: { [key]: mediaRecord } } }
let db = {};
const dbReady = (async () => {
  const stored = await chrome.storage.session.get(DB_KEY).catch(() => ({}));
  db = stored[DB_KEY] || {};
})();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ [DB_KEY]: db }).catch(() => {});
  }, 400);
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTING_DEFAULTS).catch(() => ({}));
  return { ...SETTING_DEFAULTS, ...stored };
}

function tabEntry(tabId) {
  let entry = db[tabId];
  if (!entry) entry = db[tabId] = { title: '', pageUrl: '', items: {} };
  return entry;
}

const mediaId = (tabId, key) => `${tabId}|${key}`;

function guessQuality(url, contentType) {
  const wh = /(\d{3,4})x(\d{3,4})/.exec(url);
  if (wh) return `${wh[1]}×${wh[2]}`;
  const p = /(?:^|[^0-9])(\d{3,4})p(?:[^0-9]|$)/i.exec(url);
  if (p) return `${p[1]}p`;
  const res = /[?&](?:res|resolution|quality)=(\d{3,4})/i.exec(url);
  if (res) return `${res[1]}p`;
  return contentType && /^audio\//i.test(contentType) ? 'audio' : '';
}

function isOwnExtensionUrl(u) {
  return typeof u === 'string' && u.startsWith(chrome.runtime.getURL(''));
}

async function addMedia({ tabId, url, documentUrl, referer, contentType, size }) {
  if (tabId == null || tabId < 0) return;
  if (!/^https?:/i.test(url)) return;
  if (isOwnExtensionUrl(documentUrl)) return; // our manager page fetching segments

  const byUrl = classifyUrl(url);
  let type = byUrl ? byUrl.type : null;
  let ext = byUrl ? byUrl.ext : '';
  if (!type) {
    const byCt = classifyContentType(contentType);
    if (byCt) type = byCt.type;
    if (!ext && type) ext = extFromContentType(contentType);
  }
  if (!type) return;

  const key = mediaKey(url, type);

  const cfg = await getSettings();
  if (type === 'segment' && !cfg.includeSegments) return;
  if (type === 'audio' && !cfg.detectAudio) return;
  if ((type === 'video' || type === 'audio') && size && size > 0 && size < cfg.minSizeMB * 1048576) return;

  const entry = tabEntry(tabId);
  const existing = entry.items[key];
  if (existing) {
    if (size && size > 0 && !existing.size && type !== 'hls' && type !== 'dash') {
      existing.size = size;
    }
    existing.url = url; // keep the freshest signed URL (tokens expire)
    persist();
    return;
  }

  // Playlist byte size is meaningless as a "video size" — leave it unknown.
  const isStream = type === 'hls' || type === 'dash';

  entry.items[key] = {
    id: mediaId(tabId, key),
    tabId,
    key,
    url,
    pageUrl: documentUrl && !isOwnExtensionUrl(documentUrl) ? documentUrl : entry.pageUrl || '',
    referer: referer || entry.pageUrl || '',
    type,
    ext,
    contentType: contentType || '',
    size: !isStream && size && size > 0 ? size : null,
    quality: guessQuality(url, contentType),
    source: 'network',
    ts: Date.now(),
  };
  const rec = entry.items[key];

  if (type === 'hls') {
    // If an already-classified master on this tab references this playlist,
    // fold the new entry under it (variant arrives after master).
    for (const other of Object.values(entry.items)) {
      if (other !== rec && other.playlistKind === 'master' && other.variantKeys && other.variantKeys.includes(key)) {
        rec.coveredBy = other.id;
        break;
      }
    }
    classifyPlaylist(rec);
  }
  persist();
  updateBadge(tabId);
  broadcast(tabId);
}

function broadcast(tabId) {
  chrome.runtime.sendMessage({ cmd: 'media.updated', tabId }).catch(() => {});
}

function updateBadge(tabId) {
  const items = Object.values((db[tabId] || {}).items || {});
  const n = items.filter((r) => !r.coveredBy).length;
  chrome.action
    .setBadgeText({ tabId, text: n ? (n > 99 ? '99+' : String(n)) : '' })
    .catch(() => {});
}

// Fetch a playlist text in the SW. Tries a Referer unlock when the CDN
// rejects the plain request. Used only for tiny m3u8/mpd files.
async function swFetchText(url, referer) {
  const init = { credentials: 'include', cache: 'no-store' };
  let res = await fetch(url, init);
  if ((res.status === 401 || res.status === 403) && referer) {
    const { ruleId } = await setRefererRule({ url, referer });
    if (ruleId) {
      try {
        res = await fetch(url, init);
      } finally {
        await clearRefererRule({ ruleId });
      }
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Classify a sniffed m3u8: master playlists mark the variant playlists they
// reference (coveredBy) so the popup lists one entry per video, and media
// playlists get their duration recorded for display.
async function classifyPlaylist(rec) {
  try {
    const text = await swFetchText(rec.url, rec.referer);
    const entry = db[rec.tabId];
    if (!entry || entry.items[rec.key] !== rec) return; // tab navigated / replaced
    const parsed = parseM3U8(text, rec.url);
    if (parsed.isMaster) {
      rec.playlistKind = 'master';
      rec.variantKeys = parsed.variants.map((v) => mediaKey(v.url, 'hls'));
      for (const vk of rec.variantKeys) {
        const covered = entry.items[vk];
        if (covered && covered !== rec) covered.coveredBy = rec.id;
      }
    } else {
      rec.playlistKind = 'media';
      rec.duration = parsed.totalDuration;
      rec.live = parsed.live;
    }
    persist();
    updateBadge(rec.tabId);
    broadcast(rec.tabId);
  } catch {
    // Expired token / unreachable: stays in the list unlabeled.
  }
}

// ---------------------------------------------------------------------------
// Network sniffing
// ---------------------------------------------------------------------------

// requestId -> { tabId, url, documentUrl, referer }
const pendingReqs = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0 || !REQ_TYPES.has(d.type)) return;
    const referer = (d.requestHeaders || []).find((h) => h.name.toLowerCase() === 'referer');
    pendingReqs.set(d.requestId, {
      tabId: d.tabId,
      url: d.url,
      documentUrl: d.documentUrl || d.initiator || '',
      referer: referer ? referer.value : '',
      ts: Date.now(),
    });
    if (pendingReqs.size > 3000) {
      const cutoff = Date.now() - 60000;
      for (const [k, v] of pendingReqs) {
        if (v.ts < cutoff) pendingReqs.delete(k);
        else break;
      }
    }
  },
  REQ_FILTER,
  ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const info = pendingReqs.get(d.requestId);
    pendingReqs.delete(d.requestId);
    if (d.tabId < 0) return;
    const hs = d.responseHeaders || [];
    const ct = hs.find((h) => h.name.toLowerCase() === 'content-type');
    const cl = hs.find((h) => h.name.toLowerCase() === 'content-length');
    addMedia({
      tabId: d.tabId,
      url: d.url,
      documentUrl: (info && info.documentUrl) || d.documentUrl || '',
      referer: info ? info.referer : '',
      contentType: ct ? ct.value : '',
      size: cl ? parseInt(cl.value) || null : null,
    });
  },
  REQ_FILTER,
  ['responseHeaders']
);

const cleanup = (d) => pendingReqs.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(cleanup, REQ_FILTER);
chrome.webRequest.onErrorOccurred.addListener(cleanup, REQ_FILTER);

// Reset the tab's list on top-level navigation; forget closed tabs.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  db[d.tabId] = { title: '', pageUrl: d.url, items: {} };
  persist();
  updateBadge(d.tabId);
  broadcast(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete db[tabId];
  persist();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => {});
});
chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => {});

// ---------------------------------------------------------------------------
// DNR Referer rules
// ---------------------------------------------------------------------------

const refererRules = new Map(); // ruleId -> { host, ts }
const RULE_TTL = 15 * 60 * 1000;

async function nextRuleId() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
  return rules.reduce((m, r) => Math.max(m, r.id), 1000) + 1;
}

async function setRefererRule({ url, referer }) {
  if (!referer || !/^https?:/i.test(referer)) return { ruleId: null };
  const host = hostOf(url);
  if (!host) return { ruleId: null };

  // Prune expired rules opportunistically.
  const now = Date.now();
  for (const [id, r] of refererRules) {
    if (now - r.ts > RULE_TTL) {
      refererRules.delete(id);
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id] }).catch(() => {});
    }
  }

  for (const [, r] of refererRules) {
    if (r.host === host) return { ruleId: null }; // already covered
  }

  let origin = '';
  try {
    origin = new URL(referer).origin;
  } catch {
    return { ruleId: null };
  }

  const id = await nextRuleId();
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id,
        priority: 1,
        condition: { urlFilter: `||${host}`, resourceTypes: ['xmlhttprequest', 'other'] },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: origin },
          ],
        },
      },
    ],
  });
  refererRules.set(id, { host, ts: Date.now() });
  return { ruleId: id };
}

async function clearRefererRule({ ruleId }) {
  if (!ruleId) return { ok: true };
  refererRules.delete(ruleId);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function findMedia(id) {
  const tabId = parseInt(id.split('|')[0], 10);
  const entry = db[tabId];
  if (!entry) return null;
  for (const rec of Object.values(entry.items)) {
    if (rec.id === id) return { rec, entry };
  }
  return null;
}

async function watchDownload(dlId, ruleId) {
  const finish = () => {
    clearTimeout(timer);
    chrome.downloads.onChanged.removeListener(listener);
    if (ruleId) clearRefererRule({ ruleId });
  };
  const timer = setTimeout(finish, 5 * 60 * 1000);
  const listener = (delta) => {
    if (delta.id === dlId && delta.state && delta.state.current && delta.state.current !== 'in_progress') finish();
  };
  chrome.downloads.onChanged.addListener(listener);
}

async function downloadFile(id) {
  const found = findMedia(id);
  if (!found) return { ok: false, error: 'not_found' };
  const { rec, entry } = found;
  const cfg = await getSettings();
  const filename = applyFilenameTemplate(cfg.filenameTemplate, {
    title: entry.title,
    host: hostOf(rec.pageUrl || ''),
    ext: rec.ext || extFromContentType(rec.contentType) || 'mp4',
    url: rec.url,
  });
  const finalName = cfg.downloadSubdir ? `${cfg.downloadSubdir}/${filename}` : filename;

  let ruleId = null;
  try {
    if (rec.referer) {
      const r = await setRefererRule({ url: rec.url, referer: rec.referer });
      ruleId = r.ruleId;
    }
    const dlId = await chrome.downloads.download({
      url: rec.url,
      filename: finalName,
      conflictAction: 'uniquify',
      saveAs: cfg.saveAs,
    });
    watchDownload(dlId, ruleId);
    return { ok: true, dlId };
  } catch (e) {
    if (ruleId) clearRefererRule({ ruleId });
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Content-script findings
// ---------------------------------------------------------------------------

async function handleContentFound(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return { ok: true, added: 0 };
  const cfg = await getSettings();
  const entry = tabEntry(tabId);
  if (msg.title) entry.title = msg.title;
  if (msg.url) entry.pageUrl = msg.url;

  let added = 0;
  for (const it of msg.items || []) {
    if (!it || !/^https?:/i.test(it.url)) continue;
    const cls = classifyUrl(it.url);
    if (!cls || cls.type === 'segment') continue;
    if (cls.type === 'audio' && !cfg.detectAudio) continue;
    const key = mediaKey(it.url, cls.type);
    if (entry.items[key]) continue;
    entry.items[key] = {
      id: mediaId(tabId, key),
      tabId,
      key,
      url: it.url,
      pageUrl: msg.url || '',
      referer: msg.url || '',
      type: cls.type,
      ext: cls.ext,
      contentType: '',
      size: null,
      quality: guessQuality(it.url, ''),
      source: 'page',
      ts: Date.now(),
    };
    added++;
  }
  if (added) {
    persist();
    updateBadge(tabId);
    broadcast(tabId);
  }
  return { ok: true, added };
}

// ---------------------------------------------------------------------------
// Message hub
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await dbReady;
    switch (msg && msg.cmd) {
      case 'content.found':
        return handleContentFound(msg, sender);

      case 'popup.getList': {
        const entry = db[msg.tabId] || { title: '', pageUrl: '', items: {} };
        const items = Object.values(entry.items).sort((a, b) => b.ts - a.ts);
        return { ok: true, items, title: entry.title, pageUrl: entry.pageUrl };
      }

      case 'popup.clear': {
        const entry = db[msg.tabId];
        if (entry) {
          entry.items = {};
          persist();
          updateBadge(msg.tabId);
          broadcast(msg.tabId);
        }
        return { ok: true };
      }

      case 'popup.removeItem': {
        const found = findMedia(msg.id);
        if (found) {
          delete found.entry.items[found.rec.key];
          persist();
          updateBadge(found.rec.tabId);
          broadcast(found.rec.tabId);
        }
        return { ok: true };
      }

      case 'download.file':
        return downloadFile(msg.id);

      case 'manager.getMedia': {
        const found = findMedia(msg.id);
        if (!found) return { ok: false, error: 'not_found' };
        return { ok: true, rec: found.rec, title: found.entry.title };
      }

      case 'settings.get':
        return { ok: true, settings: await getSettings() };

      case 'dnr.setReferer':
        return setRefererRule(msg);

      case 'dnr.clear':
        return clearRefererRule(msg);

      default:
        return { ok: false, error: `unknown command: ${msg && msg.cmd}` };
    }
  })()
    .then((res) => sendResponse(res || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // async sendResponse
});
