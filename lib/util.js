// Shared helpers used by the service worker and extension pages (ES modules).

export const VIDEO_EXTS = new Set(['mp4', 'webm', 'flv', 'mov', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg', '3gp', '3g2', 'ogv', 'wmv']);
export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'ac3']);
// Extensions that almost always belong to an HLS/DASH stream being played,
// not to a standalone downloadable file.
export const SEGMENT_EXTS = new Set(['ts', 'm4s']);

export const SETTING_DEFAULTS = {
  detectAudio: true,
  includeSegments: false,
  minSizeMB: 1,
  concurrency: 6,
  saveAs: false,
  downloadSubdir: '',
  filenameTemplate: '{title}.{ext}',
};

/** File extension of a URL's pathname ('' when none). */
export function getUrlExt(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([A-Za-z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Strip the fragment so the same media hit twice (SPA players) dedupes. */
export function normalizeUrl(url) {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

/**
 * Dedupe key for the media database. For playlists (hls/dash) the query string
 * is dropped too: CDNs re-sign the same playlist with a fresh token on every
 * request, which would otherwise create one entry per playback.
 */
export function mediaKey(url, type) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (type === 'hls' || type === 'dash') u.search = '';
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Classify a URL as media by its extension.
 * Returns {type, ext} where type is 'hls' | 'dash' | 'video' | 'audio' | 'segment',
 * or null when the URL does not look like media.
 */
export function classifyUrl(url) {
  const ext = getUrlExt(url);
  if (!ext) return null;
  if (ext === 'm3u8') return { type: 'hls', ext };
  if (ext === 'mpd') return { type: 'dash', ext };
  if (SEGMENT_EXTS.has(ext)) return { type: 'segment', ext };
  if (VIDEO_EXTS.has(ext)) return { type: 'video', ext };
  if (AUDIO_EXTS.has(ext)) return { type: 'audio', ext };
  return null;
}

const CT_PATTERNS = [
  [/mpegurl/i, 'hls'],
  [/dash\+xml/i, 'dash'],
  [/^video\//i, 'video'],
  [/^audio\//i, 'audio'],
  [/mp2t/i, 'segment'],
];

/** Classify by Content-Type header value; null when not media. */
export function classifyContentType(ct) {
  if (!ct) return null;
  for (const [re, type] of CT_PATTERNS) if (re.test(ct)) return { type };
  return null;
}

const CT_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-flv': 'flv',
  'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/mp2t': 'ts',
  'video/x-ms-wmv': 'wmv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/flac': 'flac', 'audio/webm': 'weba',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
};

export function extFromContentType(ct) {
  if (!ct) return '';
  const base = ct.split(';')[0].trim().toLowerCase();
  return CT_EXT[base] || '';
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function sanitizeFilename(name, fallback = 'video') {
  let n = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (n.length > 120) n = n.slice(0, 120).trim();
  return n || fallback;
}

/** Best-effort readable name from a media URL, without extension. */
export function baseNameFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    let n = decodeURIComponent(p);
    const dot = n.lastIndexOf('.');
    if (dot > 0) n = n.slice(0, dot);
    return sanitizeFilename(n, hostOf(url) ? `${hostOf(url).replace(/[^\w.-]/g, '-')}-${Date.now()}` : 'media');
  } catch {
    return 'media';
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Build a filename from a template with {title} {host} {date} {time} {ext} tokens.
 * Used for both direct-file downloads and merged stream downloads.
 */
export function applyFilenameTemplate(template, { title, host, ext, url, now = new Date() }) {
  const base = sanitizeFilename(title || '', '') || baseNameFromUrl(url);
  let name = String(template || '{title}.{ext}')
    .replaceAll('{title}', base)
    .replaceAll('{host}', host || hostOf(url) || 'video')
    .replaceAll('{date}', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
    .replaceAll('{time}', `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`)
    .replaceAll('{ext}', ext || 'mp4');
  if (!/\.[A-Za-z0-9]{1,5}$/.test(name)) name += `.${ext || 'mp4'}`;
  return sanitizeFilename(name);
}
