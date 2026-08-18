# @deepseek-ai/dsh-tool-figma-reader

读取 Figma 设计稿节点的 DSH 工具插件：解析图层树、文本、字体、颜色、布局、按钮/输入框，
生成 Markdown 报告 + 原始 JSON + 渲染 PNG。

## 功能

- 输入 Figma URL（含 `node-id`）或 `file_key + node_id`
- 调用 Figma REST API（`/v1/files/{key}/nodes`）拉取节点完整结构
- 自动生成结构化 Markdown 报告（图层树 / 文本 / 输入框 / 按钮与组件实例）
- 可选渲染节点 PNG（`/v1/images/{key}`）
- 凭据：工具参数 `token`、插件配置 `token` 或环境变量 `FIGMA_TOKEN` 三选一

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
    token: ''            # 可选：默认读环境变量 FIGMA_TOKEN
    outputDir: ~/Desktop/figma-exports
    scale: 2
    render: true
```

最后重启 DSH（或注入器环境内热装配）。

### 方式 B：本地构建注入

```bash
DSH_CHECKOUT=<你的 deepseek-harness checkout> bash scripts/build.sh
```

注入器环境内对 AI 说：`dev_inject_plugin /Users/zhe.chen/Desktop/dsh/github/dsh-figma-reader`

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

输出：节点 JSON、`*.report.md`、`*.png` 三个文件路径 + 报告摘要。

## 环境变量

```bash
export FIGMA_TOKEN=figd_xxx
```

## 许可证

MIT
