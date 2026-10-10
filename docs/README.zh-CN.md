# Open Video Downloader

**中文** · [English](../README.md)

开源的浏览器视频下载扩展（Chrome / Edge，Manifest V3）——嗅探网页流量中的视频，支持 **HLS (m3u8)**、**DASH (MPD)** 与直链文件（mp4 / webm / mp3 …）的检测与下载。对标商业扩展 Video DownloadHelper 的核心功能，但**完全本地运行、零遥测、零服务器依赖**，且无需安装任何外部伴生程序。

---

## 功能

| 能力 | 说明 |
|---|---|
| 🔍 全网嗅探 | 通过 `webRequest` 观察页面网络请求，按扩展名 / Content-Type 识别视频、音频与流媒体清单 |
| 📄 页面扫描 | 内容脚本扫描 `<video>` / `<audio>` / `<source>` 元素与页面内嵌的 m3u8 / mpd 地址 |
| 🏷️ 角标计数 | 工具栏图标实时显示当前页检测到的媒体数量 |
| 📺 HLS 下载 | 解析 master / media 播放列表，可选清晰度；并发下载分片后合并为单个 `.ts` 或 `.mp4` |
| 🔐 AES-128 解密 | 使用 WebCrypto 解密加密分片（显式 IV 或按序列号推导 IV） |
| 🎞️ DASH 下载 | 解析 MPD（SegmentTemplate / SegmentTimeline / SegmentList / 单文件），按最高画质下载，可附带音轨 |
| 🍪 反盗链 | 对校验 Referer 的 CDN,通过临时 `declarativeNetRequest` 规则补齐 Referer / Origin 后重试 |
| 📁 智能命名 | 文件名模板 `{title}` `{host}` `{ext}` `{date}` `{time}`，可存入子文件夹 |
| 🌐 双语界面 | 英文 / 简体中文（跟随浏览器语言） |
| 🚫 零追踪 | 不收集任何数据，无埋点、无远程请求（媒体下载本身除外） |

## 安装（开发者模式加载）

1. 下载 / 克隆本仓库。
2. 打开 Chrome，访问 `chrome://extensions`。
3. 打开右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本仓库根目录。
5. 工具栏出现 Open Video Downloader 图标即安装成功（Edge 同理：`edge://extensions`）。

## 使用

1. 打开任意含视频的网页并**播放视频**（嗅探需要看到真实流量）。
2. 点击工具栏图标，弹窗中列出检测到的媒体（可按 视频 / 流媒体 / 音频 筛选）。
3. 直链文件点击 ⬇ 直接进入浏览器下载；HLS / DASH 会打开**下载管理器**页面。
4. 在管理器中选择清晰度 → 点击 **下载**，等待分片抓取与合并完成，文件自动保存。
5. 常用设置在扩展的 **设置** 页：音频检测、分片并列显示、最小体积过滤、并发数、保存位置、命名模板。

## 工作原理

```
┌─────────────┐   webRequest(观察)   ┌────────────────────┐
│  网页/播放器  │ ───────────────────▶ │  Service Worker     │
│  +内容脚本    │   content.found      │  嗅探 + 媒体库       │
└─────────────┘                      │  (storage.session)  │
       ▲                             └─────────┬──────────┘
       │ popup.getList / download              │ manager.getMedia
┌──────┴──────┐                      ┌─────────▼──────────┐
│   Popup     │                      │  Manager 页面       │
│  检测列表    │                      │  probe → 选清晰度    │
└─────────────┘                      │  并发抓取分片        │
                                      │  AES-128 解密       │
                                      │  Blob 合并 → 保存    │
                                      └────────────────────┘
```

- **Service Worker**（`background/`）：嗅探、去重、角标、直链下载、Referer 解锁规则管理。
- **内容脚本**（`content/`）：DOM 媒体元素与静态 HTML 中的清单地址。
- **核心库**（`lib/`）：HLS 解析、DASH 解析、下载引擎（重试 / 并发池 / 解密）。
- **Manager 页面**（`manager/`）：普通扩展页面，因此可用 `Blob` / `URL` / `crypto.subtle` 完成流式合并。

## 已知限制

- **DRM**（Widevine / FairPlay / PlayReady）内容无法下载（`ContentProtection` 会被识别并提示）。
- **直播流**只导出当前播放列表窗口内的分片。
- HLS 仅支持 `AES-128` 加密；`SAMPLE-AES` / `cbcs` 不支持。
- DASH 音轨与视频分开保存（不做混流）。
- 部分站点（如 YouTube）使用带签名时效的专有接口，属于灰色地带，本项目不做站点特化适配，也不承诺支持。
- 合并在内存中进行，超大视频（数 GB）受设备内存限制。

## 开发

```bash
npm test      # 运行解析器单元测试（Node 即可，无需浏览器）
npm run icons # 重新生成图标（纯 Python 标准库）
npm run package  # 打包 dist/open-video-downloader.zip（可用于商店上传）
```

## 隐私

扩展不发起任何与下载无关的网络请求，不存储、不上传任何浏览数据。媒体库仅保存在 `chrome.storage.session`（浏览器关闭即清空）。

## 许可

[MIT](../LICENSE) — © Open Video Downloader contributors。

Clean-room 实现，与 Video DownloadHelper / SAS ACLAP 无任何关联。
