// Parser unit tests runnable under plain Node (no DOM needed for these paths).
// Full MPD parsing uses DOMParser, so it is exercised in the browser instead;
// here we cover the pure DASH helpers plus the complete HLS parser.

import assert from 'node:assert/strict';
import { parseM3U8, parseMediaPlaylist, parseAttrList, hexToBytes, pickBestVariant, ivForSegment } from '../lib/hls.js';
import { parseDuration, expandTemplate } from '../lib/dash.js';
import { classifyUrl, applyFilenameTemplate, baseNameFromUrl, normalizeUrl, mediaKey } from '../lib/util.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    process.exitCode = 1;
  }
}

const BASE = 'https://cdn.example.com/video/master.m3u8';

// ---------------------------------------------------------------- HLS ------

test('parseAttrList handles quoted values with commas', () => {
  const a = parseAttrList('BANDWIDTH=1280000,RESOLUTION=1920x1080,CODECS="avc1.42e00a,mp4a.40.2",NAME="720p"');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.RESOLUTION, '1920x1080');
  assert.equal(a.CODECS, 'avc1.42e00a,mp4a.40.2');
  assert.equal(a.NAME, '720p');
});

test('hexToBytes converts IV attributes', () => {
  const iv = hexToBytes('0x9c7db8778570d05c3177c349fd9236aa');
  assert.equal(iv.length, 16);
  assert.equal(iv[0], 0x9c);
  assert.equal(iv[15], 0xaa);
});

test('master playlist: variants parsed and resolved', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360,CODECS="avc1.42e00a,mp4a.40.2"',
    'https://other.example.com/360/v.m3u8?tok=abc',
    '#EXT-X-STREAM-INF:BANDWIDTH=5120000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    '1080/v.m3u8',
  ].join('\n');
  const p = parseM3U8(text, BASE);
  assert.ok(p.isMaster);
  assert.equal(p.variants.length, 2);
  assert.equal(p.variants[0].url, 'https://other.example.com/360/v.m3u8?tok=abc');
  assert.equal(p.variants[1].url, 'https://cdn.example.com/video/1080/v.m3u8');
  const best = pickBestVariant(p.variants);
  assert.equal(best.height, 1080);
});

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MEDIA-SEQUENCE:10',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/enc.key",IV=0x9c7db8778570d05c3177c349fd9236aa',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:5.76,',
  'seg0.m4s',
  '#EXTINF:5.76,',
  '#EXT-X-BYTERANGE:400000@0',
  'media.mp4',
  '#EXTINF:4.0,',
  '#EXT-X-BYTERANGE:350000',
  'media.mp4',
  '#EXT-X-ENDLIST',
].join('\n');

test('media playlist: segments, keys, map, sequence', () => {
  const p = parseMediaPlaylist(MEDIA, BASE);
  assert.equal(p.isMaster, false);
  assert.equal(p.segments.length, 3);
  assert.equal(p.live, false);
  assert.equal(p.mediaSequence, 10);
  assert.ok(Math.abs(p.totalDuration - (5.76 + 5.76 + 4.0)) < 1e-9);

  const s0 = p.segments[0];
  assert.equal(s0.url, 'https://cdn.example.com/video/seg0.m4s');
  assert.equal(s0.seq, 10);
  assert.equal(s0.key.method, 'AES-128');
  assert.equal(s0.key.uri, 'https://keys.example.com/enc.key');
  assert.deepEqual([...s0.key.iv.slice(0, 2)], [0x9c, 0x7d]);
  assert.equal(s0.byterange, null);

  assert.equal(p.map.uri, 'https://cdn.example.com/video/init.mp4');
});

test('media playlist: byte ranges resolve continuation offsets', () => {
  const p = parseMediaPlaylist(MEDIA, BASE);
  assert.deepEqual(p.segments[1].byterange, { length: 400000, offset: 0 });
  assert.deepEqual(p.segments[2].byterange, { length: 350000, offset: 400000 });
});

test('live playlist detection (no ENDLIST)', () => {
  const p = parseMediaPlaylist('#EXTM3U\n#EXTINF:4.0,\nseg1.ts\n', BASE);
  assert.equal(p.live, true);
});

test('ivForSegment derives sequence number when IV absent', () => {
  const iv = ivForSegment({ key: { iv: null }, seq: 0x01020304 });
  assert.equal(iv.length, 16);
  assert.equal(iv[12], 1);
  assert.equal(iv[13], 2);
  assert.equal(iv[14], 3);
  assert.equal(iv[15], 4);
});

// ---------------------------------------------------------------- DASH -----

test('parseDuration handles ISO 8601 durations', () => {
  assert.equal(parseDuration('PT10S'), 10);
  assert.equal(parseDuration('PT1M30.5S'), 90.5);
  assert.equal(parseDuration('PT2H'), 7200);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('garbage'), null);
});

test('expandTemplate substitutes tokens, formats and escapes', () => {
  assert.equal(expandTemplate('seg_$Number$.m4s', { Number: 42 }), 'seg_42.m4s');
  assert.equal(expandTemplate('seg_$Number%08d$.m4s', { Number: 42 }), 'seg_00000042.m4s');
  assert.equal(expandTemplate('$RepresentationID$/$Bandwidth$/x', { RepresentationID: 'v720', Bandwidth: 2000000 }), 'v720/2000000/x');
  assert.equal(expandTemplate('a$$b', {}), 'a$b');
  assert.equal(expandTemplate('keep_$Unknown$', {}), 'keep_$Unknown$');
});

// ---------------------------------------------------------------- util -----

test('classifyUrl maps extensions to media types', () => {
  assert.equal(classifyUrl('https://x.com/a/bunny.mp4?range=0-').type, 'video');
  assert.equal(classifyUrl('https://x.com/hls/index.m3u8').type, 'hls');
  assert.equal(classifyUrl('https://x.com/dash/manifest.mpd?x=1').type, 'dash');
  assert.equal(classifyUrl('https://x.com/audio/pod.mp3').type, 'audio');
  assert.equal(classifyUrl('https://x.com/seg-00042.ts').type, 'segment');
  assert.equal(classifyUrl('https://x.com/page'), null);
});

test('normalizeUrl strips fragments for dedupe', () => {
  assert.equal(normalizeUrl('https://x.com/a.mp4#t=2'), 'https://x.com/a.mp4');
});

test('mediaKey drops query for playlists (CDN re-signing), keeps it for files', () => {
  const a = mediaKey('https://cdn.example.com/v/index.m3u8?auth_key=1700000000-abc-0xyz#frag', 'hls');
  const b = mediaKey('https://cdn.example.com/v/index.m3u8?auth_key=1799999999-zzz-0qqq', 'hls');
  assert.equal(a, b);
  assert.equal(a, 'https://cdn.example.com/v/index.m3u8');
  const f1 = mediaKey('https://x.com/a.mp4?sig=1', 'video');
  const f2 = mediaKey('https://x.com/a.mp4?sig=2', 'video');
  assert.notEqual(f1, f2);
});

test('applyFilenameTemplate fills tokens and guarantees an extension', () => {
  const name = applyFilenameTemplate('{title}.{ext}', { title: 'My: Video?', ext: 'mp4', url: 'https://x.com/v.mp4' });
  assert.equal(name, 'My Video.mp4');
  const noExt = applyFilenameTemplate('{host}-{date}', { host: 'x.com', ext: 'ts', url: 'https://x.com/a.ts' });
  assert.ok(noExt.endsWith('.ts'));
});

test('baseNameFromUrl decodes and strips extension', () => {
  assert.equal(baseNameFromUrl('https://x.com/files/My%20Video%20HD.mp4?sig=1'), 'My Video HD');
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
