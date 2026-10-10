// DASH (MPD) parsing for VOD profiles.
// Supports: BaseURL chains, SegmentTemplate (duration-based & SegmentTimeline),
// SegmentList, and single-file (SegmentBase) representations.
// Uses DOMParser at runtime; pure helpers are Node-testable.

function children(el, localName) {
  return el ? [...el.children].filter((c) => c.localName === localName) : [];
}

function child(el, localName) {
  return el ? [...el.children].find((c) => c.localName === localName) || null : null;
}

function safeResolve(rel, base) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function resolveBase(baseUrlEl, parent) {
  const u = baseUrlEl && baseUrlEl.textContent && baseUrlEl.textContent.trim();
  return u ? safeResolve(u, parent) : parent;
}

/** ISO 8601 duration 'PT1M30S' -> seconds (null when unparsable). */
export function parseDuration(s) {
  if (!s) return null;
  const m = /^P(?:([.\d]+)D)?T?(?:([.\d]+)H)?(?:([.\d]+)M)?(?:([.\d]+)S)?$/.exec(s.trim());
  if (!m || !m.slice(1).some(Boolean)) return null;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + +(m[4] || 0);
}

/**
 * Expand a SegmentTemplate URL template.
 * Supports $RepresentationID$, $Bandwidth$, $Number$, $Time$ with optional
 * printf-style width ($Number%08d$) and $$ escaping.
 */
export function expandTemplate(tpl, vars) {
  return String(tpl).replace(/\$([A-Za-z]+)(%0\d+d)?\$|\$\$/g, (m, name, fmt) => {
    if (m === '$$') return '$';
    if (!(name in vars) || vars[name] === undefined) return m;
    let v = String(vars[name]);
    if (fmt) v = v.padStart(+fmt.slice(2, -1), '0');
    return v;
  });
}

function readTemplate(el) {
  if (!el) return null;
  const t = {
    media: el.getAttribute('media') || null,
    initialization: el.getAttribute('initialization') || null,
    duration: +el.getAttribute('duration') || 0,
    timescale: +el.getAttribute('timescale') || 1,
    startNumber: el.getAttribute('startNumber') != null ? +el.getAttribute('startNumber') : undefined,
    timeline: null,
  };
  const stl = child(el, 'SegmentTimeline');
  if (stl) {
    t.timeline = children(stl, 'S').map((s) => ({
      t: s.getAttribute('t') != null ? +s.getAttribute('t') : undefined,
      d: +s.getAttribute('d') || 0,
      r: s.getAttribute('r') != null ? Math.max(0, +s.getAttribute('r')) : 0,
    }));
  }
  return t;
}

export function ctFromMime(mime) {
  if (!mime) return '';
  if (/^video\//i.test(mime)) return 'video';
  if (/^audio\//i.test(mime)) return 'audio';
  return '';
}

function buildRepresentation(rep, rBase, inheritedTemplate, ctx) {
  const id = rep.getAttribute('id') || '';
  const bandwidth = +(rep.getAttribute('bandwidth') || 0);
  const mimeType = rep.getAttribute('mimeType') || ctx.asMime || '';
  const info = {
    id,
    bandwidth,
    width: +rep.getAttribute('width') || 0,
    height: +rep.getAttribute('height') || 0,
    codecs: rep.getAttribute('codecs') || ctx.asCodecs || '',
    mimeType,
    contentType: ctFromMime(mimeType) || ctx.asContentType,
    audioSamplingRate: +rep.getAttribute('audioSamplingRate') || 0,
    drm: ctx.asContentProtection || children(rep, 'ContentProtection').length > 0,
    initUrl: null,
    segments: [],
    singleFileUrl: null,
  };

  const segList = child(rep, 'SegmentList');
  if (segList) {
    const init = child(segList, 'Initialization');
    if (init && init.getAttribute('sourceURL')) info.initUrl = safeResolve(init.getAttribute('sourceURL'), rBase);
    for (const su of children(segList, 'SegmentURL')) {
      const m = su.getAttribute('media');
      if (m) info.segments.push(safeResolve(m, rBase));
    }
    return info;
  }

  const tpl = { ...(inheritedTemplate || {}) , ...stripNull(readTemplate(child(rep, 'SegmentTemplate')) || {}) };
  if (tpl && tpl.media) {
    const varsBase = { RepresentationID: id, Bandwidth: bandwidth };
    if (tpl.initialization) info.initUrl = safeResolve(expandTemplate(tpl.initialization, varsBase), rBase);
    const timescale = tpl.timescale || 1;
    const startNumber = tpl.startNumber ?? 1;
    if (tpl.timeline) {
      let n = startNumber;
      let t = 0;
      for (const s of tpl.timeline) {
        if (s.t !== undefined) t = s.t;
        for (let i = 0; i <= s.r; i++) {
          info.segments.push(safeResolve(expandTemplate(tpl.media, { ...varsBase, Number: n, Time: t }), rBase));
          n++;
          t += s.d;
        }
      }
    } else if (tpl.duration) {
      const count = ctx.periodDur > 0 ? Math.max(1, Math.ceil((ctx.periodDur * timescale) / tpl.duration)) : 1;
      for (let i = 0; i < count; i++) {
        info.segments.push(safeResolve(expandTemplate(tpl.media, { ...varsBase, Number: startNumber + i, Time: i * tpl.duration }), rBase));
      }
    }
    return info;
  }

  // SegmentBase or a representation-specific BaseURL: media is a single file.
  // (Even with an indexRange, downloading the full file yields a playable fMP4.)
  if (ctx.repHasOwnBase || child(rep, 'SegmentBase') || ctx.asHasSegmentBase) {
    info.singleFileUrl = rBase;
  }
  return info;
}

function stripNull(t) {
  return t;
}

/**
 * Parse an MPD document.
 * Returns { type, isLive, adaptations: [{contentType, mimeType, representations}] }
 * where each representation has absolute initUrl/segments/singleFileUrl.
 */
export function parseMPD(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector && doc.querySelector('parsererror')) throw new Error('Invalid MPD XML');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Not an MPD document');

  const type = mpd.getAttribute('type') || 'static';
  const mpdDur = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const out = { type, isLive: type === 'dynamic', adaptations: [] };
  const mpdBase = resolveBase(child(mpd, 'BaseURL'), baseUrl);

  for (const period of children(mpd, 'Period')) {
    const pBase = resolveBase(child(period, 'BaseURL'), mpdBase);
    const periodDur = parseDuration(period.getAttribute('duration')) ?? mpdDur ?? 0;
    for (const as of children(period, 'AdaptationSet')) {
      const aBase = resolveBase(child(as, 'BaseURL'), pBase);
      const asMime = as.getAttribute('mimeType') || '';
      const reps = [];
      const asTemplate = readTemplate(child(as, 'SegmentTemplate'));
      const asContentProtection = children(as, 'ContentProtection').length > 0;
      const asHasSegmentBase = !!child(as, 'SegmentBase');
      const asContentType =
        as.getAttribute('contentType') ||
        ctFromMime(asMime) ||
        ctFromMime(child(as, 'Representation')?.getAttribute('mimeType') || '');

      for (const rep of children(as, 'Representation')) {
        const hasOwnBase = !!child(rep, 'BaseURL');
        const rBase = resolveBase(child(rep, 'BaseURL'), aBase);
        const info = buildRepresentation(rep, rBase, asTemplate, {
          asMime,
          asCodecs: as.getAttribute('codecs') || '',
          asContentType,
          asContentProtection,
          asHasSegmentBase,
          repHasOwnBase: hasOwnBase,
          periodDur,
        });
        if (info && (info.segments.length || info.initUrl || info.singleFileUrl)) reps.push(info);
      }
      if (reps.length) out.adaptations.push({ contentType: asContentType || 'video', mimeType: asMime, representations: reps });
    }
  }
  return out;
}

/** All video representations across adaptation sets, best first. */
export function pickVideoRepresentations(mpd) {
  return mpd.adaptations
    .filter((a) => a.contentType === 'video')
    .flatMap((a) => a.representations)
    .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
}

/** Best audio representation (or null). */
export function pickAudioRepresentation(mpd) {
  const reps = mpd.adaptations
    .filter((a) => a.contentType === 'audio')
    .flatMap((a) => a.representations)
    .sort((a, b) => b.bandwidth - a.bandwidth);
  return reps[0] || null;
}

export function extForMime(mime) {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  if (m === 'audio/mp4' || m === 'audio/aac') return 'm4a';
  if (m === 'video/webm') return 'webm';
  if (m === 'audio/webm') return 'weba';
  if (m === 'audio/mpeg') return 'mp3';
  return 'mp4';
}
