// Options page: binds form fields to chrome.storage.sync.

const DEFAULTS = {
  detectAudio: true,
  includeSegments: false,
  minSizeMB: 1,
  concurrency: 6,
  saveAs: false,
  downloadSubdir: '',
  filenameTemplate: '{title}.{ext}',
};

const FIELDS = ['detectAudio', 'includeSegments', 'minSizeMB', 'concurrency', 'saveAs', 'downloadSubdir', 'filenameTemplate'];

const $ = (id) => document.getElementById(id);

function i18nPass() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const t = chrome.i18n.getMessage(el.dataset.i18n);
    if (t) el.textContent = t;
  }
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.type === 'number' || el.type === 'range') out[f] = Number(el.value);
    else out[f] = el.value.trim();
  }
  return out;
}

function writeForm(cfg) {
  for (const f of FIELDS) {
    const el = $(f);
    const v = cfg[f];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  $('concurrencyOut').textContent = String(cfg.concurrency);
}

async function save() {
  await chrome.storage.sync.set(readForm());
  const s = $('saved');
  s.classList.remove('hidden');
  setTimeout(() => s.classList.add('hidden'), 1500);
}

async function reset() {
  await chrome.storage.sync.set(DEFAULTS);
  writeForm(DEFAULTS);
  const s = $('saved');
  s.classList.remove('hidden');
  setTimeout(() => s.classList.add('hidden'), 1500);
}

async function init() {
  i18nPass();
  const stored = await chrome.storage.sync.get(DEFAULTS);
  writeForm({ ...DEFAULTS, ...stored });

  $('save').addEventListener('click', save);
  $('reset').addEventListener('click', reset);
  $('concurrency').addEventListener('input', () => {
    $('concurrencyOut').textContent = $('concurrency').value;
  });
}

init();
