// Download engine: retrying fetches, Referer unlock via DNR (service worker),
// HLS and DASH segment download + AES-128 decryption + assembly.
// Runs inside the manager page (a normal extension page, so Blob/URL/crypto work).

import { classifyUrl } from './util.js';
import { parseM3U8, pickBestVariant, ivForSegment } from './hls.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendRuntime(msg) {
  try {
    return chrome.runtime.sendMessage(msg);
  } catch {
    return Promise.resolve({});
  }
}

/**
 * Some CDNs reject requests whose Referer does not match the embedding page.
 * fetch() cannot set Referer (forbidden header), so when a 401/403 shows up we
 * install a temporary declarativeNetRequest rule (via the service worker) that
 * sets Referer/Origin for that host, then retry.
 */
export class RefererGuard {
  constructor(referer) {
    this.referer = /^https?:/i.test(referer || '') ? referer : null;
    this.unlockedHosts = new Set();
    this.ruleIds = new Set();
  }

  /** Returns true when a rule was just installed and the request is worth retrying. */
  async unlock(url) {
    if (!this.referer) return false;
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return false;
    }
    if (!host || this.unlockedHosts.has(host)) return false;
    const res = await sendRuntime({ cmd: 'dnr.setReferer', url, referer: this.referer });
    if (!res || !res.ruleId) return false;
    this.unlockedHosts.add(host);
    this.ruleIds.add(res.ruleId);
    return true;
  }

  async release() {
    for (const ruleId of this.ruleIds) await sendRuntime({ cmd: 'dnr.clear', ruleId });
    this.ruleIds.clear();
  }
}

/**
 * fetch with retries, exponential backoff, cookie sending, optional Range header
 * and automatic Referer unlocking through `guard`.
 */
export async function fetchRetry(url, { guard = null, signal = null, headers = null, retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; ; attempt++) {
    try {
      // NB: `headers` must be ABSENT when unused — RequestInit rejects null.
      const init = {
        signal,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      };
      if (headers) init.headers = headers;
      const res = await fetch(url, init);
      if ((res.status === 401 || res.status === 403) && guard) {
        if (await guard.unlock(url)) continue; // retried with Referer; don't burn an attempt
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
      if (attempt >= retries) break;
      await sleep(250 * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastErr || new Error('fetch failed');
}

export async function fetchText(url, opts = {}) {
  const res = await fetchRetry(url, opts);
  return res.text();
}

/** Concurrency-limited worker pool that stops on the first error. */
export async function runPool(items, limit, worker) {
  let next = 0;
  let failure = null;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try {
        await worker(items[i], i);
      } catch (e) {
        if (!failure) failure = e;
        break;
      }
    }
  });
  await Promise.all(runners);
  if (failure) throw failure;
}

async function decryptAes128(buf, cryptoKey, iv) {
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buf);
}

/**
 * Probe a media URL without downloading it.
 * Returns {kind:'hls-master', variants} | {kind:'hls-media', ...} | {kind:'dash', mpd} | {kind:'file'}
 */
export async function probe(url, { referer = null, signal = null } = {}) {
  const cls = classifyUrl(url);
  const type = cls ? cls.type : 'file';
  if (type !== 'hls' && type !== 'dash') return { kind: 'file', url };

  const guard = new RefererGuard(referer);
  try {
    const text = await fetchText(url, { guard, signal });
    if (type === 'hls') {
      const parsed = parseM3U8(text, url);
      if (parsed.isMaster) return { kind: 'hls-master', url, variants: parsed.variants };
      return {
        kind: 'hls-media',
        url,
        segmentCount: parsed.segments.length,
        live: parsed.live,
        duration: parsed.totalDuration,
        encrypted: parsed.segments.some((s) => s.key),
        encryptedMethod: (parsed.segments.find((s) => s.key) || {}).key?.method || null,
      };
    }
    const { parseMPD } = await import('./dash.js');
    return { kind: 'dash', url, mpd: parseMPD(text, url) };
  } finally {
    await guard.release();
  }
}

/**
 * Download an HLS stream (following master -> chosen variant) and assemble it
 * into a single Blob. Supports AES-128 keys, fMP4 maps and byte ranges.
 * Returns { blob, ext, mime, segmentCount, receivedBytes }.
 */
export async function downloadHLS({ url, variantUrl = null, referer = null, concurrency = 6, allowLive = false, onProgress, signal }) {
  const guard = new RefererGuard(referer);
  try {
    let playlistUrl = url;
    let parsed = parseM3U8(await fetchText(playlistUrl, { guard, signal }), playlistUrl);
    if (parsed.isMaster) {
      const chosen = variantUrl || pickBestVariant(parsed.variants)?.url;
      if (!chosen) throw new Error('Master playlist has no variants');
      playlistUrl = chosen;
      parsed = parseM3U8(await fetchText(playlistUrl, { guard, signal }), playlistUrl);
    }
    if (parsed.isMaster) throw new Error('Nested master playlists are not supported');

    if (parsed.live && !allowLive) {
      throw Object.assign(new Error('Live stream: only the currently buffered window can be downloaded'), { code: 'LIVE' });
    }
    for (const s of parsed.segments) {
      if (s.key && s.key.method !== 'AES-128') {
        throw Object.assign(new Error(`Unsupported HLS encryption: ${s.key.method}`), { code: 'ENCRYPTION' });
      }
    }

    const segs = parsed.segments;
    if (!segs.length) throw new Error('Playlist contains no segments');
    const hasMap = !!parsed.map;
    const total = segs.length + (hasMap ? 1 : 0);
    const parts = new Array(total);
    let received = 0;
    let done = 0;

    // Key cache: one WebCrypto key per key URI.
    const keyCache = new Map();
    const getKey = async (k) => {
      if (!keyCache.has(k.uri)) {
        const buf = await (await fetchRetry(k.uri, { guard, signal })).arrayBuffer();
        keyCache.set(k.uri, await crypto.subtle.importKey('raw', buf, { name: 'AES-CBC' }, false, ['decrypt']));
      }
      return keyCache.get(k.uri);
    };

    if (hasMap) {
      const headers = parsed.map.byterange
        ? { Range: `bytes=${parsed.map.byterange.offset}-${parsed.map.byterange.offset + parsed.map.byterange.length - 1}` }
        : null;
      const buf = await (await fetchRetry(parsed.map.uri, { guard, signal, headers })).arrayBuffer();
      parts[0] = buf;
      received += buf.byteLength;
      done++;
      onProgress && onProgress({ done, total, receivedBytes: received });
    }

    const idx0 = hasMap ? 1 : 0;
    await runPool(segs, concurrency, async (s, i) => {
      const headers = s.byterange
        ? { Range: `bytes=${s.byterange.offset}-${s.byterange.offset + s.byterange.length - 1}` }
        : null;
      let buf = await (await fetchRetry(s.url, { guard, signal, headers })).arrayBuffer();
      if (s.key) buf = await decryptAes128(buf, await getKey(s.key), ivForSegment(s));
      parts[idx0 + i] = buf;
      done++;
      received += buf.byteLength;
      onProgress && onProgress({ done, total, receivedBytes: received });
    });

    const mime = hasMap ? 'video/mp4' : 'video/mp2t';
    const ext = hasMap ? 'mp4' : 'ts';
    return { blob: new Blob(parts, { type: mime }), mime, ext, segmentCount: segs.length, receivedBytes: received };
  } finally {
    await guard.release();
  }
}

/**
 * Download one DASH representation (already parsed by probe()) and assemble it
 * into a single file. Audio+video muxing is not done — download the audio
 * representation as a separate file if needed.
 */
export async function downloadDASH({ representation, referer = null, concurrency = 6, onProgress, signal }) {
  if (representation.drm) throw Object.assign(new Error('DRM-protected content cannot be downloaded'), { code: 'DRM' });
  const { extForMime } = await import('./dash.js');
  const ext = extForMime(representation.mimeType);
  const guard = new RefererGuard(referer);

  try {
    if (representation.singleFileUrl && !representation.segments.length) {
      const buf = await (await fetchRetry(representation.singleFileUrl, { guard, signal })).arrayBuffer();
      onProgress && onProgress({ done: 1, total: 1, receivedBytes: buf.byteLength });
      return { blob: new Blob([buf], { type: representation.mimeType || 'video/mp4' }), ext, segmentCount: 1 };
    }

    const total = representation.segments.length + (representation.initUrl ? 1 : 0);
    const parts = new Array(total);
    let received = 0;
    let done = 0;

    if (representation.initUrl) {
      const buf = await (await fetchRetry(representation.initUrl, { guard, signal })).arrayBuffer();
      parts[0] = buf;
      received += buf.byteLength;
      done++;
      onProgress && onProgress({ done, total, receivedBytes: received });
    }

    const idx0 = representation.initUrl ? 1 : 0;
    await runPool(representation.segments, concurrency, async (u, i) => {
      const buf = await (await fetchRetry(u, { guard, signal })).arrayBuffer();
      parts[idx0 + i] = buf;
      done++;
      received += buf.byteLength;
      onProgress && onProgress({ done, total, receivedBytes: received });
    });

    return { blob: new Blob(parts, { type: representation.mimeType || 'video/mp4' }), ext, segmentCount: representation.segments.length };
  } finally {
    await guard.release();
  }
}
