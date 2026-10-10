// Popup: lists media detected on the active tab, with quick actions.

import { formatBytes, formatDuration, baseNameFromUrl } from '../lib/util.js';

const $ = (sel) => document.querySelector(sel);

let items = [];
let filter = 'all';

const send = (msg) => chrome.runtime.sendMessage(msg);

function i18nPass(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const t = chrome.i18n.getMessage(el.dataset.i18n);
    if (t) el.textContent = t;
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      const t = chrome.i18n.getMessage(key);
      if (t) el.setAttribute(attr, t);
    }
  }
}

function typeGroup(rec) {
  if (rec.type === 'hls' || rec.type === 'dash') return 'stream';
  if (rec.type === 'audio' || rec.type === 'segment') return 'audio';
  return 'video';
}

function typeLabel(rec) {
  return chrome.i18n.getMessage(`type_${rec.type}`) || rec.type.toUpperCase();
}

function itemIconText(rec) {
  if (rec.type === 'hls') return 'HLS';
  if (rec.type === 'dash') return 'DASH';
  if (rec.type === 'audio') return 'AUD';
  return 'VID';
}

function visibleItems() {
  if (filter === 'all') return items;
  return items.filter((r) => typeGroup(r) === filter);
}

function metaLine(rec) {
  const bits = [];
  if (rec.quality) bits.push(rec.quality);
  if (rec.playlistKind === 'master') {
    bits.push(chrome.i18n.getMessage('masterPlaylistLabel', [String(rec.variantKeys ? rec.variantKeys.length : 0)]));
  } else if (rec.playlistKind === 'media') {
    if (rec.duration) bits.push(formatDuration(rec.duration));
    if (rec.live) bits.push(chrome.i18n.getMessage('liveLabel'));
    if (!rec.duration && !rec.live) bits.push('—');
  } else {
    bits.push(rec.size ? formatBytes(rec.size) : '—');
  }
  bits.push(chrome.i18n.getMessage(rec.source === 'page' ? 'sourcePage' : 'sourceNetwork'));
  return bits.join(' · ');
}

function buildItem(rec) {
  const el = document.createElement('div');
  el.className = 'item';
  el.setAttribute('role', 'listitem');

  const icon = document.createElement('div');
  icon.className = `item-icon ${typeGroup(rec) === 'stream' ? 'stream' : ''}`;
  icon.textContent = itemIconText(rec);

  const main = document.createElement('div');
  main.className = 'item-main';

  const name = document.createElement('div');
  name.className = 'item-name';
  const label = `${baseNameFromUrl(rec.url)}.${rec.ext || 'bin'}`;
  name.textContent = label;
  name.title = rec.url;

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = typeLabel(rec);
  meta.append(tag, document.createTextNode(metaLine(rec)));

  main.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  const copyBtn = iconBtn(
    'M8 3h8v2H8zM6 5h12v2H6zm-1 4h14v12H5zm2 2v8h10v-8z',
    chrome.i18n.getMessage('itemCopy'),
    () => navigator.clipboard.writeText(rec.url).then(() => flash(copyBtn))
  );
  const openBtn = iconBtn(
    'M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z',
    chrome.i18n.getMessage('itemOpen'),
    () => chrome.tabs.create({ url: rec.url, active: false })
  );
  const dlBtn = iconBtn(
    rec.type === 'hls' || rec.type === 'dash'
      ? 'M12 3v10.2M12 13.2l-4-4M12 13.2l4-4M4 17h16v3H4z'
      : 'M12 3v10.2M12 13.2l-4-4M12 13.2l4-4M5 17h14',
    chrome.i18n.getMessage('itemDownload'),
    () => downloadItem(rec),
    true
  );

  actions.append(copyBtn, openBtn, dlBtn);
  el.append(icon, main, actions);
  return el;
}

function iconBtn(path, title, onClick, primary = false) {
  const btn = document.createElement('button');
  btn.className = `act${primary ? ' dl' : ''}`;
  btn.title = title || '';
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

function flash(btn) {
  const old = btn.style.color;
  btn.style.color = '#16a34a';
  setTimeout(() => (btn.style.color = old), 500);
}

async function downloadItem(rec) {
  if (rec.type === 'hls' || rec.type === 'dash') {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`manager/manager.html?id=${encodeURIComponent(rec.id)}`) });
    window.close();
    return;
  }
  const res = await send({ cmd: 'download.file', id: rec.id });
  if (!res || !res.ok) {
    showNotice(chrome.i18n.getMessage('errDownload') || 'Download failed');
  }
}

function render() {
  const list = $('#list');
  const empty = $('#empty');
  list.textContent = '';
  const visible = visibleItems();
  for (const rec of visible) list.append(buildItem(rec));
  empty.classList.toggle('hidden', visible.length > 0);
  $('#count').textContent = chrome.i18n.getMessage('countLabel', [String(items.length)]);
  $('#btn-dl-all').disabled = items.length === 0;
  $('#btn-clear').disabled = items.length === 0;
}

function showNotice(text) {
  const n = $('#notice');
  n.textContent = text;
  n.classList.remove('hidden');
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;

  if (tab.url && !/^https?:/i.test(tab.url)) {
    showNotice(chrome.i18n.getMessage('unsupportedPage'));
  }

  const res = await send({ cmd: 'popup.getList', tabId: tab.id });
  if (res && res.ok) {
    // Variant playlists referenced by an already-classified master are folded
    // into it — one entry per actual video.
    items = (res.items || []).filter((r) => !r.coveredBy);
    render();
  }
}

async function downloadAll() {
  const streams = items.filter((r) => r.type === 'hls' || r.type === 'dash');
  const files = items.filter((r) => r.type !== 'hls' && r.type !== 'dash');
  for (const rec of files) await send({ cmd: 'download.file', id: rec.id });
  if (streams.length) {
    const q = streams.map((s) => `id=${encodeURIComponent(s.id)}`).join('&');
    await chrome.tabs.create({ url: chrome.runtime.getURL(`manager/manager.html?${q}`) });
    window.close();
  }
}

// Wire up
i18nPass();

$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.f;
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  render();
});

$('#btn-clear').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await send({ cmd: 'popup.clear', tabId: tab.id });
  items = [];
  render();
});

$('#btn-dl-all').addEventListener('click', downloadAll);
$('#btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.cmd === 'media.updated') refresh();
});

refresh();
