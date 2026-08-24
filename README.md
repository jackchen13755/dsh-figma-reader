# @deepseek-ai/dsh-tool-figma-reader

读取 Figma 设计稿节点的 DSH 工具插件：解析图层树、文本、字体、颜色、布局、按钮/输入框，
生成 Markdown 报告 + 原始 JSON + 渲染 PNG。

## 功能

- 输入 Figma URL（含 `node-id`）或 `file_key + node_id`
- **读取优先级**：① 浏览器扩展下载的 Kiwi 帧（`~/Downloads/figma_ws`）→ ② Figma REST API（整文件缓存）→ ③ 浏览器会话/CDP 连接捕获
- **浏览器下载帧优先**：若 `~/Downloads/figma_ws` 已有与目标 file key 匹配的下载帧，直接用本地文件解码，零 REST API、零新开标签页
- REST 模式调用 `/v1/files/{key}` 拉整份文件并**本地缓存**，之后同文件任意节点零 API 读取
- **WS/连接模式（`figma_read_node_ws`）**：完全不调 REST API，通过 browser-harness/CDP 捕获编辑器 WebSocket 的 Kiwi 二进制帧并本地解码
- 自动生成结构化 Markdown 报告（图层树 / 文本 / 输入框 / 按钮与组件实例）
- 可选渲染节点 PNG（REST 模式走 `/v1/images/{key}`，连接模式走编辑器视口截图；下载帧模式不提供 PNG/截图）
- 凭据：工具参数 `token`、插件配置 `token` 或环境变量 `FIGMA_TOKEN` 三选一（仅 REST 模式需要）

## 安装

### 方式 A：git 装配（推荐）

仓库根目录即标准 DSH 插件包，直接按 git 依赖装配：

```bash
dsh plugin --profile web add github:jackchen13755/dsh-figma-reader
```

或手动在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加一行：

```json
"@deepseek-ai/dsh-tool-figma-reader": "github:jackchen13755/dsh-figma-reader#main"
```

然后在使用的 Agent preset（如 `~/.dsh/.agent-presets/<preset>/agent.cordis.yml`）的工具行追加：

```yaml
- id: tool-figma-reader
  name: '@deepseek-ai/dsh-tool-figma-reader'
  config:
    token: ''            # 可选：默认读环境变量 FIGMA_TOKEN（仅 REST 模式需要）
    outputDir: ~/Desktop/figma-exports
    scale: 2
    render: true
    localCaptureDir: ~/Downloads/figma_ws   # 可选：浏览器下载帧目录
```

最后重启 DSH（或注入器环境内热装配）。

### 方式 B：本地构建注入

```bash
DSH_CHECKOUT=<你的 deepseek-harness checkout> bash scripts/build.sh
```

注入器环境内对 AI 说：`dev_inject_plugin <你的 dsh-figma-reader 本地绝对路径>`

## 使用

会话里调用工具 `figma_read_node`：

```
figma_read_node url=https://www.figma.com/design/<fileKey>/<name>?node-id=8049-4704
```

或：

```
figma_read_node file_key=Zh9LpkjKgNrwuBITsD5d6g node_id=8049:4704 render=true scale=2
```

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 二选一 | Figma design/file/proto 链接（含 node-id） |
| `file_key` + `node_id` | 二选一 | 直接指定文件与节点 |
| `token` | 否 | Figma Personal Access Token（缺省用配置/`FIGMA_TOKEN`） |
| `render` | 否 | 是否渲染 PNG，默认 true |
| `scale` | 否 | PNG 缩放倍数，默认 2 |
| `output_dir` | 否 | 导出目录，默认 `~/Desktop/figma-exports` |
| `refresh` | 否 | 强制重新拉整文件并刷新缓存，默认 false |
| `local_capture_dir` | 否 | 浏览器下载帧目录，默认 `~/Downloads/figma_ws` |

输出：节点 JSON、`*.report.md`、`*.png` 三个文件路径 + 报告摘要。
若命中的是浏览器下载帧，输出文件为 `*.ws.json` / `*.ws.report.md`，且不提供 PNG。

## 整文件缓存（省 API 配额）

默认开启：首次读取某个文件时，用 `GET /v1/files/{key}` 拉一次**整份文件**，缓存到
`<output_dir>/figma_cache/<fileKey>.json`；之后读同一文件的任何节点都直接走本地缓存，
不再调用 REST API。

- 只有 `render=true`（渲染 PNG）或 `refresh=true` 时才会产生新请求；
- 缓存里找不到节点时会自动强制刷新一次再查找；
- 整文件缓存可能较大（几十 MB），属正常；删掉 `figma_cache/<fileKey>.json` 即清除缓存。

## WS / 浏览器下载模式（零 REST API）

`figma_read_node_ws` 完全不调用 Figma REST API。读取优先级：

1. **浏览器下载帧**：先检查 `~/Downloads/figma_ws`（`local_capture_dir` 可改），若存在与
   `file_key` 匹配的 `last_capture.json` 数据帧，直接本地解码——**不新开标签页、不等待**；
2. **连接捕获（回退）**：若没有可用下载帧，才通过 browser-harness/CDP 驱动你已登录
   Figma 的 Chrome，监听编辑器 WebSocket，捕获 Kiwi 二进制帧（zstd 压缩），再用仓库内
   vendored 解码器还原场景图，按节点 id 提取子树生成报告。

前置条件（仅连接捕获需要）：

- Chrome 已带 `--remote-debugging-port=9222` 启动，且已登录 Figma；
- 本机装有 `browser-harness` CLI（默认 `~/.local/bin/browser-harness`）。

用法：

```
figma_read_node_ws url=https://www.figma.com/design/<fileKey>/<name>?node-id=8049-4704
```

或：

```
figma_read_node_ws file_key=Zh9LpkjKgNrwuBITsD5d6g node_id=8049:4704 screenshot=true wait_seconds=18
```

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 二选一 | Figma 链接（含 node-id） |
| `file_key` + `node_id` | 二选一 | 直接指定文件与节点 |
| `screenshot` | 否 | 是否截取编辑器视口 PNG，默认 true |
| `wait_seconds` | 否 | 等待 Figma 初始同步的秒数，默认 18 |
| `browser_harness_path` | 否 | browser-harness CLI 路径 |
| `output_dir` | 否 | 导出目录，默认 `~/Desktop/figma-exports/ws` |
| `local_capture_dir` | 否 | 浏览器下载帧目录，默认 `~/Downloads/figma_ws` |

注意事项：

- 命中浏览器下载帧时**不提供视口截图**；需要截图请显式调用连接捕获模式（或临时把 `local_capture_dir` 指向无下载帧的目录）；
- 回退连接捕获时每次调用会**新开一个 Figma 标签页**（约 20 秒），完成后不自动关闭；
- 截图是编辑器**视口截图**，不是按节点裁切的干净导出（干净导出仍需 REST `/v1/images`）；
- 解码器由一次捕获的 schema 生成，已验证跨会话稳定；若未来 Figma 协议变更导致解码失败，
  可联系维护者重新生成 `vendor/figma-kiwi/figma_decoder.js`。

## 环境变量

```bash
export FIGMA_TOKEN=figd_xxx
```

## 许可证

MIT
