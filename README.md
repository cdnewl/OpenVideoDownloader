# Open Video Downloader

**English** · [中文](docs/README.zh-CN.md)

An open-source browser video downloader extension (Chrome / Edge, Manifest V3). It sniffs web traffic for media and supports detection & download of **HLS (m3u8)**, **DASH (MPD)** and direct files (mp4 / webm / mp3 …). It aims to match the core feature set of the commercial Video DownloadHelper, but **runs fully locally, with zero telemetry and no server dependency** — no companion app required.

---

## Features

| Capability | Description |
|---|---|
| 🔍 Global sniffing | Observes page requests via `webRequest`, identifies video, audio, and stream manifests by extension / Content-Type |
| 📄 Page scanning | Content script scans `<video>` / `<audio>` / `<source>` elements and embedded m3u8 / mpd URLs |
| 🏷️ Badge counter | Toolbar icon shows the real-time media count for the current page |
| 📺 HLS download | Parses master / media playlists, picks a rendition, downloads segments concurrently, and merges into a single `.ts` or `.mp4` |
| 🔐 AES-128 decryption | Decrypts encrypted segments via WebCrypto (explicit IV or IV-by-sequence-number) |
| 🎞️ DASH download | Parses MPD (SegmentTemplate / SegmentTimeline / SegmentList / single file), downloads the highest rendition, with optional audio track |
| 🍪 Anti-hotlink | For CDNs that validate `Referer`, patches Referer / Origin via temporary `declarativeNetRequest` rules and retries |
| 📁 Smart naming | Filename templates `{title}` `{host}` `{ext}` `{date}` `{time}`, with optional sub-folder |
| 🌐 Bilingual UI | English / Simplified Chinese (follows browser language) |
| 🚫 Zero tracking | No data collection, no analytics, no remote requests (apart from the media downloads themselves) |

## Install (Developer Mode)

1. Download / clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the repository root.
5. The Open Video Downloader icon appears in the toolbar — installation complete (Edge: `edge://extensions`).

## Usage

1. Open any page that contains a video and **play the video** (sniffing requires real traffic).
2. Click the toolbar icon — the popup lists detected media, filterable by Video / Stream / Audio.
3. Direct files download immediately via ⬇; HLS / DASH open the **Download Manager** page.
4. In the manager, pick a rendition → click **Download**, wait for segment fetching and merging; the file is saved automatically.
5. Common settings live on the extension's **Options** page: audio detection, per-segment display, minimum size filter, concurrency, save location, naming template.

## How It Works

```
┌─────────────┐   webRequest(observe)  ┌────────────────────┐
│  Web page   │ ─────────────────────▶ │  Service Worker     │
│  + content  │   content.found        │  sniff + media lib  │
└─────────────┘                        │  (storage.session)  │
       ▲                               └─────────┬──────────┘
       │ popup.getList / download                │ manager.getMedia
┌──────┴──────┐                        ┌─────────▼──────────┐
│   Popup     │                        │  Manager page       │
│  detection  │                        │  probe → pick rend. │
└─────────────┘                        │  concurrent fetch   │
                                       │  AES-128 decrypt    │
                                       │  Blob merge → save  │
                                       └────────────────────┘
```

- **Service Worker** (`background/`): sniffing, dedup, badge, direct downloads, Referer unlock rules.
- **Content script** (`content/`): DOM media elements and static-HTML manifest URLs.
- **Core library** (`lib/`): HLS parser, DASH parser, download engine (retry / concurrency pool / decryption).
- **Manager page** (`manager/`): a regular extension page, so it can use `Blob` / `URL` / `crypto.subtle` to stream-assemble files.

## Comparison with Video DownloadHelper

| | Video DownloadHelper | This project |
|---|---|---|
| Open source | ✗ (proprietary) | ✓ MIT |
| Companion app | Some features require VDH Companion / ffmpeg | **Not required** — everything runs in the browser |
| HLS / DASH merge | ✓ (depends on external tools) | ✓ (in-browser; raw TS / fMP4 concat) |
| Format conversion | ✓ (external ffmpeg) | ✗ (`.ts` plays directly in VLC, or run `ffmpeg -i in.ts -c copy out.mp4`) |
| A/V muxing | ✓ | ✗ (DASH audio saved as separate `.m4a`) |
| DRM content | ✗ | ✗ (technically infeasible for both) |
| Telemetry | Limited | None |

## Known Limitations

- **DRM** (Widevine / FairPlay / PlayReady) content cannot be downloaded (`ContentProtection` is detected and reported).
- **Live streams** export only the segments within the current playlist window.
- HLS supports `AES-128` only; `SAMPLE-AES` / `cbcs` are unsupported.
- DASH audio and video are saved separately (no muxing).
- Some sites (e.g. YouTube) use signed, time-limited proprietary APIs — a grey area. This project does not provide site-specific workarounds and makes no promise of support.
- Merging happens in memory; very large videos (multi-GB) are bounded by device RAM.

## Development

```bash
npm test         # Run parser unit tests (plain Node, no browser needed)
npm run icons    # Regenerate icons (Python standard library only)
npm run package  # Build dist/open-video-downloader.zip (store-upload-ready)
```

## Privacy

The extension makes no network requests unrelated to downloads. It does not store or upload any browsing data. The media library lives only in `chrome.storage.session` and is cleared when the browser closes.

## License

[MIT](LICENSE) — © Open Video Downloader contributors.

Clean-room implementation. Not affiliated with Video DownloadHelper / SAS ACLAP.
