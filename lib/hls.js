// HLS (m3u8) playlist parsing. Pure functions — safe to run in Node for tests.

/** Parse an HLS attribute list: BANDWIDTH=1280000,RESOLUTION=1920x1080,CODECS="a,b" */
export function parseAttrList(s) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ')) i++;
    if (i >= s.length) break;
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq).trim();
    i = eq + 1;
    let val = '';
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      val = s.slice(i + 1, end < 0 ? s.length : end);
      i = end < 0 ? s.length : end + 1;
    } else {
      let end = s.indexOf(',', i);
      if (end < 0) end = s.length;
      val = s.slice(i, end).trim();
      i = end;
    }
    if (key) out[key] = val;
  }
  return out;
}

/** '0x9c7db8778570d05c3177c349fd9236aa' -> Uint8Array(16) */
export function hexToBytes(hex) {
  const h = String(hex || '').replace(/^0x/i, '');
  const out = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function safeResolve(rel, base) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

/**
 * Parse a master playlist.
 * Returns { isMaster: true, variants: [{url, bandwidth, width, height, codecs, name}] }
 */
export function parseMasterPlaylist(text, baseUrl) {
  const variants = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      const res = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '') || [];
      pending = {
        bandwidth: parseInt(a.BANDWIDTH) || 0,
        width: res ? +res[1] : 0,
        height: res ? +res[2] : 0,
        codecs: a.CODECS || '',
        name: a.NAME || '',
      };
    } else if (!line.startsWith('#') && pending) {
      pending.url = safeResolve(line, baseUrl);
      variants.push(pending);
      pending = null;
    }
  }
  return { isMaster: true, variants };
}

/**
 * Parse a media playlist.
 * Returns { isMaster:false, segments:[{url,duration,byterange,key,discontinuity,seq}],
 *          map, live, targetDuration, mediaSequence, version, totalDuration }
 * - key: {method, uri, iv, keyformat} | null  (iv as Uint8Array when given)
 * - byterange: {length, offset} | null (offset resolved against previous segment)
 */
export function parseMediaPlaylist(text, baseUrl) {
  const segments = [];
  let map = null;
  let live = true;
  let targetDuration = 0;
  let mediaSequence = 0;
  let version = 1;

  let duration = 0;
  let byterange = null;
  let key = null;
  let discontinuity = false;
  let nextByteOffset = 0; // running offset for continuation BYTERANGE entries
  let total = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        const m = /^(\d+)(?:@(\d+))?\s*$/.exec(line.slice('#EXT-X-BYTERANGE:'.length));
        if (m) byterange = { length: +m[1], offset: m[2] !== undefined ? +m[2] : null };
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrList(line.slice('#EXT-X-KEY:'.length));
        if ((a.METHOD || 'NONE').toUpperCase() === 'NONE') {
          key = null;
        } else {
          key = {
            method: (a.METHOD || '').toUpperCase(),
            uri: a.URI ? safeResolve(a.URI, baseUrl) : null,
            iv: a.IV ? hexToBytes(a.IV) : null,
            keyformat: a.KEYFORMAT || 'identity',
          };
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrList(line.slice('#EXT-X-MAP:'.length));
        const br = /^(\d+)(?:@(\d+))?\s*$/.exec(a.BYTERANGE || '');
        map = {
          uri: safeResolve(a.URI || '', baseUrl),
          byterange: br ? { length: +br[1], offset: br[2] !== undefined ? +br[2] : 0 } : null,
        };
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-VERSION:')) {
        version = parseInt(line.slice('#EXT-X-VERSION:'.length)) || 1;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        discontinuity = true;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        live = false;
      }
      continue;
    }

    // Plain URI line = one segment.
    const seg = {
      url: safeResolve(line, baseUrl),
      duration,
      byterange: byterange ? { length: byterange.length, offset: byterange.offset ?? nextByteOffset } : null,
      key,
      discontinuity,
      seq: mediaSequence + segments.length,
    };
    segments.push(seg);
    total += duration;
    nextByteOffset = seg.byterange ? seg.byterange.offset + seg.byterange.length : 0;
    duration = 0;
    byterange = null;
    discontinuity = false;
  }

  return { isMaster: false, segments, map, live, targetDuration, mediaSequence, version, totalDuration: total };
}

/** Parse either flavor of playlist. */
export function parseM3U8(text, baseUrl) {
  if (!/#EXTM3U/.test(text)) throw new Error('Not an M3U8 playlist');
  if (/^#EXT-X-STREAM-INF:/m.test(text)) return parseMasterPlaylist(text, baseUrl);
  return parseMediaPlaylist(text, baseUrl);
}

/** Highest resolution, then highest bandwidth. */
export function pickBestVariant(variants) {
  if (!variants || !variants.length) return null;
  return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

/** AES-128 IV: explicit attr, or the segment media sequence number (RFC 8216 §4.3.2.4). */
export function ivForSegment(seg) {
  if (seg.key && seg.key.iv && seg.key.iv.length === 16) return seg.key.iv;
  const iv = new Uint8Array(16);
  let n = seg.seq | 0;
  for (let i = 15; i >= 12; i--) {
    iv[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return iv;
}
