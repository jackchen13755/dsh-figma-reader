/**
 * @deepseek-ai/dsh-tool-figma-reader — 读取 Figma 设计稿节点。
 *
 * 把一个 Figma 设计稿节点（FRAME/组件）拉成三层产物：
 * 1. 节点原始 JSON（来自整文件缓存，避免反复消耗 REST 配额）
 * 2. 结构化 Markdown 报告（图层树、文本、字体、颜色、布局、按钮/输入框）
 * 3. 渲染 PNG（`GET /v1/images/{key}`，可选）
 *
 * 配额友好：默认首次读取某文件时用 `GET /v1/files/{key}` 拉整份文件并缓存到
 * `<outputDir>/figma_cache/<fileKey>.json`；之后读取同文件的任何节点都直接走本地
 * 缓存，不再调用 API。只有渲染 PNG 或 `refresh=true` 时才会产生新请求。
 *
 * 设计稿节点由 Figma REST API 读取，无需浏览器；凭据用 Personal Access Token
 * （配置项 token，或环境变量 FIGMA_TOKEN）。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCapture } from './capture.js'
import { decodeFrameAndBuildReport } from './kiwi.js'

export const name = '@deepseek-ai/dsh-tool-figma-reader'
export const inject = ['tools']

export interface Config {
  /** Figma Personal Access Token（优先于环境变量 FIGMA_TOKEN）。 */
  token?: string
  /** 导出目录，默认 ~/Desktop/figma-exports。 */
  outputDir?: string
  /** 渲染 PNG 的缩放倍数，默认 2。 */
  scale?: number
  /** 默认是否渲染 PNG，默认 true。 */
  render?: boolean
  /** browser-harness CLI 路径（WS 模式用），默认 ~/.local/bin/browser-harness。 */
  browserHarnessPath?: string
  /** WS 模式等待 Figma 初始同步的秒数，默认 18。 */
  wsWaitSeconds?: number
}

export const Config = z.object({
  token: z.string().default(''),
  outputDir: z.string().default(''),
  scale: z.number().default(2),
  render: z.boolean().default(true),
  browserHarnessPath: z.string().default(''),
  wsWaitSeconds: z.number().default(18),
})

const API = 'https://api.figma.com/v1'

/** 文本块，供工具 result 渲染。 */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** 从 Figma URL 或直接参数中解析 fileKey 与 nodeId。 */
function resolveTarget(url?: string, fileKey?: string, nodeId?: string): { fileKey: string; nodeId: string } {
  if (fileKey && nodeId) return { fileKey, nodeId }
  if (!url) throw new Error('需要提供 Figma URL（fileKey+nodeId）或直接传 file_key + node_id')
  const m = /figma\.com\/(?:design|file|proto)\/([^/?#]+)/i.exec(url)
  if (!m) throw new Error(`无法从 URL 解析 file key: ${url}`)
  const key = m[1]
  const nm = /[?&]node-id=([^&#]+)/i.exec(url) || /[?&]ids=([^&#]+)/i.exec(url)
  let node = nodeId || (nm ? decodeURIComponent(nm[1]) : '')
  if (!node) throw new Error('URL 缺少 node-id，请直接传 node_id')
  node = node.replace(/-(\d+)$/i, (_s, d: string) => ':' + d)
  return { fileKey: key, nodeId: node }
}

async function figmaGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(API + path, {
    headers: { 'X-Figma-Token': token, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Figma API ${res.status}: ${body.slice(0, 300) || res.statusText}`)
  }
  return (await res.json()) as T
}

interface BBox {
  x: number
  y: number
  width: number
  height: number
}

interface FigmaNode {
  id: string
  name: string
  type: string
  characters?: string
  style?: Record<string, unknown>
  fills?: Array<{ type?: string; visible?: boolean; color?: Record<string, number>; opacity?: number }>
  strokes?: Array<{ type?: string; visible?: boolean; color?: Record<string, number>; opacity?: number }>
  strokeWeight?: number
  cornerRadius?: number
  absoluteBoundingBox?: BBox
  children?: FigmaNode[]
  layoutMode?: string
  backgroundColor?: Record<string, number>
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  componentId?: string
}

interface WholeFile {
  name: string
  lastModified?: string
  document: FigmaNode
}

/** 在整文件文档树里按节点 id 深度优先查找。 */
function findNode(root: FigmaNode, id: string): FigmaNode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

function bboxText(n: FigmaNode): string {
  const b = n.absoluteBoundingBox
  return b ? `x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}` : ''
}

function rgba(fills?: FigmaNode['fills']): string | null {
  if (!fills) return null
  for (const f of fills) {
    if (f.type === 'SOLID' && f.visible !== false && f.color) {
      const c = f.color
      const a = f.opacity ?? c.a ?? 1
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`
    }
  }
  return null
}

function fontText(n: FigmaNode): string {
  const s = n.style ?? {}
  const f = String(s.fontFamily ?? '')
  const w = String(s.fontWeight ?? '')
  const size = String(s.fontSize ?? '')
  return [f, w, size ? size + 'px' : ''].filter(Boolean).join(' ')
}

/** 把文档节点树渲染成 Markdown 报告。 */
function buildReport(root: FigmaNode): string {
  const out: string[] = []
  out.push(`# ${root.name}`)
  out.push('')
  out.push(`- 节点 ID：${root.id}`)
  out.push(`- 类型：${root.type}`)
  out.push(`- 尺寸：${root.absoluteBoundingBox ? `${Math.round(root.absoluteBoundingBox.width)} × ${Math.round(root.absoluteBoundingBox.height)}` : '—'}`)
  if (root.absoluteBoundingBox) out.push(`- 画布坐标：x=${Math.round(root.absoluteBoundingBox.x)}, y=${Math.round(root.absoluteBoundingBox.y)}`)
  const bg = rgba(root.fills ?? [{ type: 'SOLID', color: root.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 } }])
  if (bg) out.push(`- 背景：${bg}`)
  if (root.layoutMode) {
    out.push(`- 布局：${root.layoutMode}，padding ${root.paddingTop ?? 0}/${root.paddingRight ?? 0}/${root.paddingBottom ?? 0}/${root.paddingLeft ?? 0}`)
  }
  out.push('')

  // 文本
  const texts: Array<{ depth: number; n: FigmaNode }> = []
  const walk = (n: FigmaNode, depth: number): void => {
    if (n.type === 'TEXT' && n.characters) texts.push({ depth, n })
    for (const c of n.children ?? []) walk(c, depth + 1)
  }
  walk(root, 0)

  if (texts.length) {
    out.push('## 文本内容')
    out.push('')
    out.push('| 文本 | 字体 | 颜色 | 位置 |')
    out.push('|---|---|---|---|')
    for (const { n } of texts) {
      out.push(`| ${(n.characters ?? '').replace(/\u00a0/g, ' ').replace(/\|/g, '\\|')} | ${fontText(n) || '—'} | ${rgba(n.fills) || '—'} | ${bboxText(n)} |`)
    }
    out.push('')
  }

  // 输入框（Input Field 矢量）
  const inputs: FigmaNode[] = []
  const collect = (n: FigmaNode): void => {
    if (n.type === 'VECTOR' && /input\s*field/i.test(n.name)) inputs.push(n)
    for (const c of n.children ?? []) collect(c)
  }
  collect(root)
  if (inputs.length) {
    out.push('## 输入框')
    out.push('')
    out.push('| 名称 | 尺寸 | 背景 | 描边 | 位置 |')
    out.push('|---|---|---|---|---|')
    for (const n of inputs) {
      out.push(`| ${n.name} | ${n.absoluteBoundingBox ? `${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '—'} | ${rgba(n.fills) || '—'} | ${rgba(n.strokes) || '—'}${n.strokeWeight ? ` ${n.strokeWeight}px` : ''} | ${bboxText(n)} |`)
    }
    out.push('')
  }

  // 按钮/实例
  const buttons: FigmaNode[] = []
  const collectBtn = (n: FigmaNode): void => {
    if (/button/i.test(n.name) || n.type === 'INSTANCE') buttons.push(n)
    for (const c of n.children ?? []) collectBtn(c)
  }
  collectBtn(root)
  if (buttons.length) {
    out.push('## 按钮与组件实例')
    out.push('')
    out.push('| 名称 | 类型 | 背景 | 描边 | 尺寸 |')
    out.push('|---|---|---|---|---|')
    for (const n of buttons) {
      out.push(`| ${n.name} | ${n.type}${n.componentId ? ` (${n.componentId})` : ''} | ${rgba(n.fills) || '—'} | ${rgba(n.strokes) || '—'}${n.strokeWeight ? ` ${n.strokeWeight}px` : ''} | ${n.absoluteBoundingBox ? `${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '—'} |`)
    }
    out.push('')
  }

  // 完整图层树
  out.push('## 图层树')
  out.push('')
  out.push('```')
  const lines: string[] = []
  const tree = (n: FigmaNode, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${n.type} ${n.name} (${n.id}) ${bboxText(n)}`)
    for (const c of n.children ?? []) tree(c, depth + 1)
  }
  tree(root, 0)
  out.push(lines.join('\n'))
  out.push('```')
  out.push('')

  return out.join('\n')
}

export function apply(ctx: Context, config: Config = {}): void {
  const token = config.token || process.env.FIGMA_TOKEN
  const outputDir = resolve(config.outputDir || join(homedir(), 'Desktop', 'figma-exports'))
  const scale = config.scale ?? 2
  const renderDefault = config.render ?? true

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'figma_read_node',
    description: '读取 Figma 设计稿节点（整文件缓存，省 API 配额）：解析图层/文本/样式，生成 Markdown 报告并可选渲染 PNG',
    parameters: {
      url: { type: 'string', description: 'Figma 设计稿 URL（含 node-id）' },
      file_key: { type: 'string', description: 'Figma file key（传 url 时可不填）' },
      node_id: { type: 'string', description: '节点 ID，如 8049:4704（传 url 时可不填）' },
      token: { type: 'string', description: 'Figma Personal Access Token（缺省用配置/FIGMA_TOKEN）' },
      render: { type: 'boolean', description: '是否渲染 PNG，默认 true' },
      scale: { type: 'number', description: 'PNG 缩放倍数，默认 2' },
      output_dir: { type: 'string', description: '导出目录，默认 ~/Desktop/figma-exports' },
      refresh: { type: 'boolean', description: '强制重新拉取整文件并刷新缓存，默认 false' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [textBlock(String(value))],
    },
    async execute(args: { url?: string; file_key?: string; node_id?: string; token?: string; render?: boolean; scale?: number; output_dir?: string; refresh?: boolean }) {
      const tk = args.token || token
      if (!tk) throw new Error('缺少 Figma token：请在工具参数 token、插件配置 token 或环境变量 FIGMA_TOKEN 中提供')
      const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id)
      const outDir = resolve(args.output_dir || outputDir)
      await mkdir(outDir, { recursive: true })
      const cacheDir = join(outDir, 'figma_cache')
      const cacheFile = join(cacheDir, `${fileKey}.json`)

      // 1) 整文件数据：优先缓存，refresh=true 或缓存缺失时拉 API
      const readCache = async (): Promise<WholeFile | null> => {
        try {
          return JSON.parse(await readFile(cacheFile, 'utf8')) as WholeFile
        } catch {
          return null
        }
      }
      const fetchWhole = async (): Promise<WholeFile> => {
        const data = await figmaGet<WholeFile>(`/files/${encodeURIComponent(fileKey)}`, tk)
        await mkdir(cacheDir, { recursive: true })
        await writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf8')
        return data
      }

      let data: WholeFile | null = null
      let fromCache = false
      if (!args.refresh) {
        data = await readCache()
        fromCache = data !== null
      }
      if (!data) data = await fetchWhole()

      // 2) 定位节点；缓存里没有则强制刷新一次再找
      let doc = findNode(data.document, nodeId)
      if (!doc && fromCache) {
        data = await fetchWhole()
        fromCache = false
        doc = findNode(data.document, nodeId)
      }
      if (!doc) throw new Error(`节点 ${nodeId} 不存在或无权限`)

      const base = `figma_${fileKey}_${nodeId.replace(':', '-')}`
      const jsonPath = join(outDir, `${base}.json`)
      const mdPath = join(outDir, `${base}.report.md`)
      await writeFile(jsonPath, JSON.stringify({ fileKey, fileName: data.name, nodeId, node: doc }, null, 2), 'utf8')

      // 3) Markdown 报告
      const report = buildReport(doc)
      await writeFile(mdPath, report, 'utf8')

      // 4) 渲染 PNG（独立请求，按需调用）
      let pngPath: string | null = null
      if (args.render ?? renderDefault) {
        const img = await figmaGet<{ images: Record<string, string> }>(
          `/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${args.scale ?? scale}`,
          tk,
        )
        const url = img.images?.[nodeId]
        if (url) {
          const res = await fetch(url)
          if (res.ok) {
            pngPath = join(outDir, `${base}.png`)
            await writeFile(pngPath, Buffer.from(await res.arrayBuffer()))
          }
        }
      }

      const lines = [
        `✅ 已读取 Figma 节点：${doc.name}`,
        `- 文件：${data.name}（file key ${fileKey}）`,
        `- 节点：${nodeId}（${doc.type}，${doc.absoluteBoundingBox ? `${Math.round(doc.absoluteBoundingBox.width)}×${Math.round(doc.absoluteBoundingBox.height)}` : '尺寸未知'}）`,
        `- 数据来源：${fromCache ? '整文件缓存' : 'Figma API 整文件（已写入缓存）'}`,
        `- 缓存文件：${cacheFile}`,
        `- 报告：${mdPath}`,
        `- JSON：${jsonPath}`,
        ...(pngPath ? [`- PNG：${pngPath}`] : []),
        '',
        '--- 报告摘要 ---',
        '',
        report,
      ]
      return lines.join('\n')
    },
  })), '@deepseek-ai/dsh-tool-figma-reader: figma_read_node')

  // ── WS 模式：零 REST API，靠浏览器会话捕获 Kiwi 二进制帧 ──────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'figma_read_node_ws',
    description: '通过浏览器会话（零 REST API）读取 Figma 节点：CDP 捕获 Kiwi 二进制帧并解码生成报告',
    parameters: {
      url: { type: 'string', description: 'Figma 设计稿 URL（含 node-id）' },
      file_key: { type: 'string', description: 'Figma file key（传 url 时可不填）' },
      node_id: { type: 'string', description: '节点 ID，如 8049:4704（传 url 时可不填）' },
      output_dir: { type: 'string', description: '导出目录，默认 ~/Desktop/figma-exports/ws' },
      screenshot: { type: 'boolean', description: '是否顺带截取编辑器视口 PNG，默认 true' },
      wait_seconds: { type: 'number', description: '等待 Figma 初始同步秒数，默认 18' },
      browser_harness_path: { type: 'string', description: 'browser-harness CLI 路径，缺省用配置/默认路径' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [textBlock(String(value))],
    },
    async execute(args: { url?: string; file_key?: string; node_id?: string; output_dir?: string; screenshot?: boolean; wait_seconds?: number; browser_harness_path?: string }) {
      const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id)
      const outDir = resolve(args.output_dir || config.outputDir || join(homedir(), 'Desktop', 'figma-exports', 'ws'))
      await mkdir(outDir, { recursive: true })
      const captureDir = join(outDir, 'ws_capture')
      const figmaUrl = args.url || `https://www.figma.com/file/${encodeURIComponent(fileKey)}?node-id=${encodeURIComponent(nodeId)}`
      const cap = await runCapture({
        fileKey,
        nodeId,
        url: figmaUrl,
        outDir: captureDir,
        waitSeconds: args.wait_seconds ?? config.wsWaitSeconds ?? 18,
        screenshot: args.screenshot ?? true,
        browserHarnessPath: args.browser_harness_path || config.browserHarnessPath || undefined,
      })
      const dec = decodeFrameAndBuildReport(cap.dataPath, fileKey, nodeId, outDir)
      const lines = [
        `✅ 已通过 Figma WS（零 REST API）读取节点：${nodeId}`,
        `- 数据来源：浏览器会话 Kiwi 二进制帧（browser-harness/CDP）`,
        `- 消息类型：${dec.messageType}，子树节点数：${dec.nodeCount}`,
        `- 报告：${dec.mdPath}`,
        `- JSON：${dec.jsonPath}`,
        ...(cap.screenshotPath ? [`- 视口截图：${cap.screenshotPath}`] : []),
        '',
        '--- 报告摘要 ---',
        '',
        await readFile(dec.mdPath, 'utf8'),
      ]
      return lines.join('\n')
    },
  })), '@deepseek-ai/dsh-tool-figma-reader: figma_read_node_ws')
}
