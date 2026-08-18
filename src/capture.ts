/**
 * 通过 browser-harness（CDP 驱动真实 Chrome）捕获 Figma WS 帧。
 *
 * 流程：新建 about:blank 标签页 → 注入 WebSocket b64 钩子 → 导航到设计稿 URL
 * （带 cache-buster）→ 等待初始同步 → 在页面内挑出 schema 帧（fig-wire 头）与
 * 最大的数据帧 → 以 base64 取出落盘。
 */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

export interface CaptureArgs {
  fileKey: string
  nodeId: string
  url: string
  outDir: string
  waitSeconds?: number
  screenshot?: boolean
  browserHarnessPath?: string
}

export interface CaptureResult {
  schemaPath: string | null
  dataPath: string
  screenshotPath: string | null
  title?: string
}

const WS_HOOK = String.raw`(() => {
  if (window.__wslog2) return;
  window.__wslog2 = { events: [] };
  const log = (ev) => { try { window.__wslog2.events.push(ev); if (window.__wslog2.events.length > 4000) window.__wslog2.events.shift(); } catch(e){} };
  const bufToB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const OrigWS = window.WebSocket;
  window.WebSocket = function(...args) {
    const ws = new OrigWS(...args);
    const url = String(args[0]);
    log({type:"open", url, time: Date.now()});
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      let desc;
      try {
        if (typeof data === "string") desc = {k:"str", v:data};
        else if (data instanceof ArrayBuffer) desc = {k:"b64", size:data.byteLength, v:bufToB64(data)};
        else if (ArrayBuffer.isView(data)) desc = {k:"b64", size:data.byteLength, v:bufToB64(data.buffer.slice(data.byteOffset, data.byteOffset+data.byteLength))};
        else desc = {k:"other", v:String(data)};
      } catch(e) { desc = {k:"err", v:e.message}; }
      log({type:"send", url, data:desc, time: Date.now()});
      return origSend(data);
    };
    ws.addEventListener("message", (e) => {
      let desc;
      try {
        if (typeof e.data === "string") desc = {k:"str", v:e.data};
        else if (e.data instanceof Blob) {
          e.data.arrayBuffer().then(buf => {
            log({type:"recv", url, data:{k:"b64", size:buf.byteLength, v:bufToB64(buf)}, time: Date.now()});
          }).catch(err => log({type:"recv", url, data:{k:"err", v:err.message}, time: Date.now()}));
          desc = {k:"blob-async", size:e.data.size};
        } else if (e.data instanceof ArrayBuffer) desc = {k:"b64", size:e.data.byteLength, v:bufToB64(e.data)};
        else if (ArrayBuffer.isView(e.data)) desc = {k:"b64", size:e.data.byteLength, v:bufToB64(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset+e.data.byteLength))};
        else desc = {k:"other", v:String(e.data)};
      } catch(e) { desc = {k:"err", v:e.message}; }
      if (desc.k !== "blob-async") log({type:"recv", url, data:desc, time: Date.now()});
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
})();`

const CAPTURE_PY = String.raw`
import json, os, time, base64, sys

HOOK = """__WS_HOOK__"""

file_key = os.environ["PY_FILE_KEY"]
node_id = os.environ["PY_NODE_ID"]
url = os.environ["PY_URL"]
out_dir = os.environ["PY_OUT_DIR"]
wait = float(os.environ.get("PY_WAIT", "18"))
screenshot = os.environ.get("PY_SCREENSHOT", "1") == "1"
shot_path = os.environ.get("PY_SHOT_PATH", "")

# 打开新标签页（保证 harness 的活跃 tab 就是它），new_tab 返回 targetId 并已切换
tid = new_tab("about:blank")
time.sleep(1)
att = cdp("Target.attachToTarget", targetId=tid, flatten=True)
sid = att["sessionId"]
cdp("Page.enable", session_id=sid)
cdp("Page.addScriptToEvaluateOnNewDocument", session_id=sid, source=HOOK)

sep = "&" if "?" in url else "?"
nav_url = url + sep + "t=ws%d-0" % int(time.time() * 1000)
cdp("Page.navigate", session_id=sid, url=nav_url)
time.sleep(wait)
time.sleep(2)

sel = js("""(() => {
  const ev = window.__wslog2 ? window.__wslog2.events : [];
  const recv = ev.filter(e => e.type === "recv" && e.data && e.data.k === "b64");
  const schema = recv.find(e => { try { const b = atob(e.data.v); return b.slice(0,8) === "fig-wire"; } catch(err) { return false; } });
  const data = recv.reduce((a,b) => (b.data.size||0) > ((a&&a.data.size)||0) ? b : a, null);
  return JSON.stringify({schema: schema ? {size: schema.data.size, b64: schema.data.v} : null, data: data ? {size: data.data.size, b64: data.data.v} : null});
})()""")
try:
    sel = json.loads(sel)
except Exception as e:
    print(json.dumps({"error": "bad selection json: %s" % e, "raw": str(sel)[:500]})); sys.exit(1)

if not sel.get("data"):
    diag = js("""(() => {
      const ev = window.__wslog2 ? window.__wslog2.events : [];
      const recv = ev.filter(e => e.type === "recv" && e.data && e.data.k === "b64").map(e => e.data.size).sort((a,b)=>b-a).slice(0,8);
      const types = [...new Set(ev.map(e => e.type))];
      return JSON.stringify({n: ev.length, types: types, recvB64Sizes: recv, url: window.location.href});
    })()""")
    try:
        diag = json.loads(diag)
    except Exception:
        diag = {"raw": str(diag)[:500]}
    print(json.dumps({"error": "no data frame captured", "diag": diag})); sys.exit(1)

os.makedirs(out_dir, exist_ok=True)
data_path = os.path.join(out_dir, "frame_0001_recv_%db.bin" % sel["data"]["size"])
open(data_path, "wb").write(base64.b64decode(sel["data"]["b64"]))
schema_path = None
if sel.get("schema") and sel["schema"].get("size"):
    schema_path = os.path.join(out_dir, "frame_0000_recv_%db.bin" % sel["schema"]["size"])
    open(schema_path, "wb").write(base64.b64decode(sel["schema"]["b64"]))

result = {"schema": schema_path, "data": data_path}
try:
    result["title"] = (page_info() or {}).get("title")
except Exception:
    pass
if screenshot and shot_path:
    try:
        capture_screenshot(shot_path, max_dim=1800)
        result["screenshot"] = shot_path
    except Exception as e:
        result["screenshot_error"] = str(e)
print(json.dumps(result))
`

/** 运行 browser-harness 捕获 Figma WS 帧。 */
export async function runCapture(args: CaptureArgs): Promise<CaptureResult> {
  const harness =
    args.browserHarnessPath || join(homedir(), '.local', 'bin', 'browser-harness')
  const wait = args.waitSeconds ?? 18
  const outDir = args.outDir
  mkdirSync(outDir, { recursive: true })
  const shotPath = args.screenshot
    ? join(outDir, `figma_${args.fileKey}_${args.nodeId.replace(':', '-')}.ws.png`)
    : ''
  const py = CAPTURE_PY.replace('__WS_HOOK__', WS_HOOK)
  const env: Record<string, string> = {
    ...process.env,
    PY_FILE_KEY: args.fileKey,
    PY_NODE_ID: args.nodeId,
    PY_URL: args.url,
    PY_OUT_DIR: outDir,
    PY_WAIT: String(wait),
    PY_SCREENSHOT: args.screenshot === false ? '0' : '1',
    PY_SHOT_PATH: shotPath,
  }
  const { stdout, stderr } = await execFileAsync(harness, ['-c', py], {
    env: env as NodeJS.ProcessEnv,
    timeout: (wait + 30) * 1000,
    maxBuffer: 20 * 1024 * 1024,
  })
  // 取 stdout 最后一行 JSON
  const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  let parsed: Record<string, unknown> | null = null
  for (const line of lines.reverse()) {
    try {
      parsed = JSON.parse(line)
      break
    } catch {
      // 继续往前找
    }
  }
  if (!parsed) {
    throw new Error(`browser-harness 无 JSON 输出：\n${stdout}\n${stderr}`)
  }
  if (parsed.error) {
    throw new Error(`捕获失败：${String(parsed.error)}`)
  }
  if (!parsed.data) throw new Error('捕获结果缺少 data 帧')
  return {
    schemaPath: parsed.schema ? String(parsed.schema) : null,
    dataPath: String(parsed.data),
    screenshotPath: parsed.screenshot ? String(parsed.screenshot) : null,
    title: parsed.title ? String(parsed.title) : undefined,
  }
}
