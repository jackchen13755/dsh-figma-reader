# DSH 控制扩展 + Figma WS 静默捕获

本目录是 `~/Desktop/dsh/extensions/dsh-control`（Chrome 已安装的「DSH 控制」扩展）的
版本化镜像。**实际生效的是桌面那份**；改代码后两边同步，再到 `chrome://extensions` 点
「重新加载」。

## 新增能力（1.4.0）

在原有「DSH 控制」基础上静默捕获 Figma 编辑器 WebSocket 的 Kiwi 二进制帧：

1. `content_scripts`（`figma-ws-content.js`）在 `figma.com/design|file|proto` 页面
   `document_start` 注入 `figma-ws-hook.js`（MAIN world）；
2. hook 包装 `WebSocket`，保留 schema 帧（`fig-wire` 头）与最大数据帧，通过
   `postMessage` 交给 content script → 扩展后台；
3. 后台用 `chrome.downloads` 静默写入 `~/Downloads/figma_ws/`：
   - `frame_0000_recv_<size>b.bin`（schema）
   - `frame_0001_recv_<size>b.bin`（数据）
   - `last_capture.json`（清单）
   并短暂显示角标 ✓ / 失败。

## 文件

- `manifest.json` — MV3，新增 `downloads` 权限、Figma content_scripts、WAR hook
- `background.js` — 原有转发/控制逻辑 + `figma-ws-capture` 消息处理
- `figma-ws-hook.js` — MAIN world WebSocket 捕获
- `figma-ws-content.js` — 隔离世界注入与转发
- 图标沿用原有 `icon-*.png`

## 消费帧文件（零 REST API）

```bash
node scripts/read-figma-ws.mjs <fileKey> <nodeId>
# 例：
node scripts/read-figma-ws.mjs Zh9LpkjKgNrwuBITsD5d6g 8049:4704
```

该 CLI 读 `~/Downloads/figma_ws/last_capture.json` + 数据帧，用仓库内 vendored
解码器（`vendor/figma-kiwi/`）生成报告，不经过 REST API、不控制浏览器。

## 注意

- 每次刷新 Figma 页面会重新捕获（文件名按大小命名，可能覆盖同尺寸旧文件）；
- 大文件（压缩后 >1.5MB）的 base64 data URL 可能超出 Chrome downloads 上限，
  大文件场景可考虑后续改为本地 HTTP 端口推送；
- Figma 协议变更导致解码失败时，需重新生成 `vendor/figma-kiwi/figma_decoder.js`。
