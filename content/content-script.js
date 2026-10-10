// Content script: reports <video>/<audio>/<source> elements and m3u8/mpd URLs
// found in the page's static DOM to the service worker. Runs in all frames.

(() => {
  if (window.__OVD_CONTENT__) return;
  window.__OVD_CONTENT__ = true;

  const HTML_URL_RE = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi;
  let timer = null;

  function urlsFromDom() {
    const out = new Set();
    for (const el of document.querySelectorAll('video, audio, source')) {
      const u = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (/^https?:/i.test(u)) out.add(u);
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        for (const cand of srcset.split(',')) {
          const u2 = cand.trim().split(/\s+/)[0];
          if (/^https?:/i.test(u2) && /\.(m3u8|mpd|mp4|webm)(?:[?#]|$)/i.test(u2)) out.add(u2);
        }
      }
    }
    return out;
  }

  function urlsFromHtml() {
    const out = new Set();
    try {
      const html = document.documentElement.outerHTML;
      for (const m of html.matchAll(HTML_URL_RE)) out.add(m[0]);
    } catch {
      /* ignore */
    }
    return out;
  }

  function scan() {
    if (document.hidden && timer) return; // rescans happen when visible again
    const items = [...urlsFromDom(), ...urlsFromHtml()].map((url) => ({ url }));
    if (!items.length) return;
    try {
      chrome.runtime.sendMessage({
        cmd: 'content.found',
        url: location.href,
        title: document.title,
        items,
      }).catch?.(() => {});
    } catch {
      /* extension context gone */
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 400);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // Media events fire when a player finally settles on a src (often after ads).
  for (const ev of ['playing', 'loadeddata', 'canplay']) {
    document.addEventListener(ev, schedule, true);
  }
  document.addEventListener('visibilitychange', schedule, true);

  setTimeout(scan, 300);
  setTimeout(scan, 2500);
  window.addEventListener('load', schedule);
})();
