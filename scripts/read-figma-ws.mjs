#!/usr/bin/env node
/**
 * 独立 CLI：从本地捕获目录（如 ~/Downloads/figma_ws，浏览器扩展静默生成）
 * 读取 Kiwi 帧并用仓库内 vendored 解码器生成节点报告。
 *
 * 用法：
 *   node scripts/read-figma-ws.mjs <fileKey> <nodeId>
 *     [--dir ~/Downloads/figma_ws] [--out /tmp/figma-report]
 *     [--data /path/to/frame_0001_recv_XXXb.bin]
 *
 * 不依赖 DSH、不控制浏览器；只读取扩展/手动捕获落盘的帧文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { decodeFrameAndBuildReport } from '../lib/kiwi.js'

function usage() {
  console.error(
    `用法：node scripts/read-figma-ws.mjs <fileKey> <nodeId> [--dir <捕获目录>] [--out <导出目录>] [--data <数据帧文件>]`,
  )
  process.exit(2)
}

const args = process.argv.slice(2)
function opt(name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

const positional = args.filter((a) => !a.startsWith('--'))
if (positional.length < 2) usage()
const [fileKey, nodeId] = positional
const dir = resolve(opt('--dir') || join(homedir(), 'Downloads', 'figma_ws'))
const out = resolve(opt('--out') || join(homedir(), 'Desktop', 'figma-exports', 'ws'))
const dataArg = opt('--data')

let dataPath = dataArg
let manifest = null
const manifestPath = join(dir, 'last_capture.json')
if (!dataPath && existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // 防止串用另一个文件捕获的帧：仅当清单未记录文件或与请求 fileKey 一致时使用
    const murl = String(manifest.url ?? '')
    const mk = (murl.match(/figma\.com\/(?:design|file|proto)\/([^/?#]+)/i) || [])[1]
    if (mk && mk !== fileKey) {
      console.error(`清单属于另一个文件（${mk}），与请求文件 ${fileKey} 不符；请先打开目标 Figma 页并重新下载帧`)
      process.exit(1)
    }
    // 清单若指向 <1KB 的小帧（非场景图），忽略并回退到目录里最大数据帧
    if (manifest.dataFile && (manifest.dataSize || 0) >= 1024) {
      dataPath = join(dir, manifest.dataFile)
    }
  } catch (e) {
    console.error(`读取 ${manifestPath} 失败：${e.message}`)
  }
}
if (!dataPath) {
  // 退路：目录里最新的 frame_0001_recv_*.bin
  const { readdirSync, statSync } = await import('node:fs')
  const candidates = readdirSync(dir)
    .filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  if (!candidates.length) {
    console.error(`目录 ${dir} 里没有可用的数据帧（先安装扩展打开 Figma 页面，或手动捕获）`)
    process.exit(1)
  }
  dataPath = join(dir, candidates[0].f)
}

if (!existsSync(dataPath)) {
  console.error(`数据帧不存在：${dataPath}`)
  process.exit(1)
}

const result = decodeFrameAndBuildReport(dataPath, fileKey, nodeId, out, '浏览器下载帧（本地文件）')
console.log(JSON.stringify({ ...result, sourceDir: dir, manifest }, null, 2))
