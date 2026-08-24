/**
 * Kiwi（Figma WS 二进制协议）解码 + 报告生成。
 *
 * 输入：CDP 捕获的 data frame（zstd 压缩的 Kiwi 消息）。
 * 输出：节点 JSON + Markdown 报告（与 REST 模式等价，但零 REST API 配额）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
// 运行时从 lib/ 定位 vendored decoder：lib/index.js → ../vendor/figma-kiwi/...
const HERE = dirname(fileURLToPath(import.meta.url));
const DECODER_PATH = resolve(HERE, '../vendor/figma-kiwi/figma_decoder.js');
function guidKey(g) {
    return `${Number(g.sessionID)}:${Number(g.localID)}`;
}
function rgba(paints) {
    if (!paints)
        return null;
    for (const p of paints) {
        if (p.type === 'SOLID' && p.visible !== false && p.color) {
            const c = p.color;
            const a = p.opacity ?? c.a ?? 1;
            return `rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`;
        }
    }
    return null;
}
function pos(n) {
    const t = n.transform ?? {};
    const s = n.size ?? {};
    return `x=${Math.round(Number(t.m02 ?? 0))} y=${Math.round(Number(t.m12 ?? 0))} w=${Math.round(Number(s.x ?? 0))} h=${Math.round(Number(s.y ?? 0))}`;
}
function fontText(n) {
    const f = n.fontName ?? {};
    return [f.family ?? '', f.style ?? '', n.fontSize != null ? `${n.fontSize}px` : ''].filter(Boolean).join(' ');
}
/** 解析单帧 Kiwi 消息，定位目标节点并构建子树报告。 */
export function decodeFrameAndBuildReport(dataFramePath, fileKey, nodeId, outDir, source = 'Figma WS Kiwi 二进制（零 REST API）') {
    const compressed = readFileSync(dataFramePath);
    const bytes = new Uint8Array(zstdDecompressSync(compressed));
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Schema = require(DECODER_PATH);
    const msg = Schema.decodeMessage(bytes);
    const nodeChanges = (msg.nodeChanges ?? []);
    const byGuid = new Map();
    for (const n of nodeChanges) {
        if (n.guid)
            byGuid.set(guidKey(n.guid), n);
    }
    // REST 节点 id `A:B` ⇔ Kiwi guid {sessionID:A, localID:B}
    const [a, b] = nodeId.split(':');
    const targetKey = `${Number(a)}:${Number(b)}`;
    const target = byGuid.get(targetKey);
    if (!target)
        throw new Error(`Kiwi 解码后找不到节点 ${nodeId}（共 ${nodeChanges.length} 个节点）`);
    // 子树（parentIndex.guid 指父节点）
    const children = new Map();
    for (const n of nodeChanges) {
        const p = n.parentIndex?.guid;
        if (p) {
            const key = guidKey(p);
            if (!children.has(key))
                children.set(key, []);
            children.get(key).push(n);
        }
    }
    const subtree = [];
    const collect = (key) => {
        subtree.push(key);
        for (const c of children.get(key) ?? [])
            collect(guidKey(c.guid));
    };
    collect(targetKey);
    const md = [];
    md.push(`# ${target.name ?? nodeId}`);
    md.push('');
    md.push(`- 节点 ID：${nodeId}`);
    md.push(`- 类型：${target.type ?? '—'}`);
    const size = target.size ?? {};
    md.push(`- 尺寸：${Math.round(Number(size.x ?? 0))} × ${Math.round(Number(size.y ?? 0))}`);
    md.push(`- 画布坐标：${pos(target)}`);
    const bg = rgba(target.fillPaints);
    if (bg)
        md.push(`- 背景：${bg}`);
    if (target.stackMode) {
        md.push(`- 布局：${target.stackMode}，padding ${target.stackVerticalPadding ?? 0}/${target.stackPaddingRight ?? 0}/${target.stackPaddingBottom ?? 0}/${target.stackHorizontalPadding ?? 0}`);
    }
    md.push('');
    md.push(`> 数据来源：${source}`);
    md.push('');
    // 文本
    const texts = [];
    for (const k of subtree) {
        const n = byGuid.get(k);
        if (n.type === 'TEXT' && n.textData?.characters)
            texts.push(n);
    }
    if (texts.length) {
        md.push('## 文本内容');
        md.push('');
        md.push('| 文本 | 字体 | 颜色 | 位置 |');
        md.push('|---|---|---|---|');
        for (const n of texts) {
            const chars = (n.textData?.characters ?? '').replace(/\|/g, '\\|');
            md.push(`| ${chars} | ${fontText(n) || '—'} | ${rgba(n.fillPaints) || '—'} | ${pos(n)} |`);
        }
        md.push('');
    }
    // 输入框
    const inputs = [];
    for (const k of subtree) {
        const n = byGuid.get(k);
        if (n.type === 'VECTOR' && /input/i.test(n.name ?? ''))
            inputs.push(n);
    }
    if (inputs.length) {
        md.push('## 输入框');
        md.push('');
        md.push('| 名称 | 尺寸 | 背景 | 描边 | 位置 |');
        md.push('|---|---|---|---|---|');
        for (const n of inputs) {
            const s = n.size ?? {};
            md.push(`| ${n.name ?? ''} | ${Math.round(Number(s.x ?? 0))}×${Math.round(Number(s.y ?? 0))} | ${rgba(n.fillPaints) || '—'} | ${rgba(n.strokePaints) || '—'} | ${pos(n)} |`);
        }
        md.push('');
    }
    // 按钮
    const buttons = [];
    for (const k of subtree) {
        const n = byGuid.get(k);
        if (/取消|复制卡|制新卡|button/i.test(n.name ?? ''))
            buttons.push(n);
    }
    if (buttons.length) {
        md.push('## 按钮');
        md.push('');
        md.push('| 名称 | 类型 | 背景 | 尺寸 |');
        md.push('|---|---|---|---|');
        for (const n of buttons) {
            const s = n.size ?? {};
            md.push(`| ${n.name ?? ''} | ${n.type ?? ''} | ${rgba(n.fillPaints) || '—'} | ${Math.round(Number(s.x ?? 0))}×${Math.round(Number(s.y ?? 0))} |`);
        }
        md.push('');
    }
    // 图层树
    md.push('## 图层树');
    md.push('');
    md.push('```');
    const lines = [];
    const tree = (key, depth) => {
        const n = byGuid.get(key);
        lines.push(`${'  '.repeat(depth)}${n.type ?? ''} ${n.name ?? ''} (${key}) ${pos(n)}`);
        for (const c of children.get(key) ?? [])
            tree(guidKey(c.guid), depth + 1);
    };
    tree(targetKey, 0);
    md.push(lines.join('\n'));
    md.push('```');
    md.push('');
    mkdirSync(outDir, { recursive: true });
    const base = `figma_${fileKey}_${nodeId.replace(':', '-')}`;
    const jsonPath = join(outDir, `${base}.ws.json`);
    const mdPath = join(outDir, `${base}.ws.report.md`);
    writeFileSync(jsonPath, JSON.stringify({ fileKey, nodeId, node: target, descendants: subtree.map((k) => byGuid.get(k)) }, (_key, value) => (typeof value === 'bigint' ? Number(value) : value), 2), 'utf8');
    writeFileSync(mdPath, md.join('\n'), 'utf8');
    return { jsonPath, mdPath, nodeCount: subtree.length, messageType: String(msg.type ?? ''), source };
}
//# sourceMappingURL=kiwi.js.map