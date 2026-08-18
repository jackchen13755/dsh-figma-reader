import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const name = '@deepseek-ai/dsh-tool-figma-reader';
export const inject = ['tools'];
export const Config = z.object({
    token: z.string().default(''),
    outputDir: z.string().default(''),
    scale: z.number().default(2),
    render: z.boolean().default(true),
});
const API = 'https://api.figma.com/v1';
/** 文本块，供工具 result 渲染。 */
function textBlock(text) {
    return { type: 'text', text };
}
/** 从 Figma URL 或直接参数中解析 fileKey 与 nodeId。 */
function resolveTarget(url, fileKey, nodeId) {
    if (fileKey && nodeId)
        return { fileKey, nodeId };
    if (!url)
        throw new Error('需要提供 Figma URL（fileKey+nodeId）或直接传 file_key + node_id');
    const m = /figma\.com\/(?:design|file|proto)\/([^/?#]+)/i.exec(url);
    if (!m)
        throw new Error(`无法从 URL 解析 file key: ${url}`);
    const key = m[1];
    const nm = /[?&]node-id=([^&#]+)/i.exec(url) || /[?&]ids=([^&#]+)/i.exec(url);
    let node = nodeId || (nm ? decodeURIComponent(nm[1]) : '');
    if (!node)
        throw new Error('URL 缺少 node-id，请直接传 node_id');
    node = node.replace(/-(\d+)$/i, (_s, d) => ':' + d);
    return { fileKey: key, nodeId: node };
}
async function figmaGet(path, token) {
    const res = await fetch(API + path, {
        headers: { 'X-Figma-Token': token, Accept: 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Figma API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }
    return (await res.json());
}
/** 在整文件文档树里按节点 id 深度优先查找。 */
function findNode(root, id) {
    if (root.id === id)
        return root;
    for (const c of root.children ?? []) {
        const hit = findNode(c, id);
        if (hit)
            return hit;
    }
    return null;
}
function bboxText(n) {
    const b = n.absoluteBoundingBox;
    return b ? `x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}` : '';
}
function rgba(fills) {
    if (!fills)
        return null;
    for (const f of fills) {
        if (f.type === 'SOLID' && f.visible !== false && f.color) {
            const c = f.color;
            const a = f.opacity ?? c.a ?? 1;
            return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
        }
    }
    return null;
}
function fontText(n) {
    const s = n.style ?? {};
    const f = String(s.fontFamily ?? '');
    const w = String(s.fontWeight ?? '');
    const size = String(s.fontSize ?? '');
    return [f, w, size ? size + 'px' : ''].filter(Boolean).join(' ');
}
/** 把文档节点树渲染成 Markdown 报告。 */
function buildReport(root) {
    const out = [];
    out.push(`# ${root.name}`);
    out.push('');
    out.push(`- 节点 ID：${root.id}`);
    out.push(`- 类型：${root.type}`);
    out.push(`- 尺寸：${root.absoluteBoundingBox ? `${Math.round(root.absoluteBoundingBox.width)} × ${Math.round(root.absoluteBoundingBox.height)}` : '—'}`);
    if (root.absoluteBoundingBox)
        out.push(`- 画布坐标：x=${Math.round(root.absoluteBoundingBox.x)}, y=${Math.round(root.absoluteBoundingBox.y)}`);
    const bg = rgba(root.fills ?? [{ type: 'SOLID', color: root.backgroundColor ?? { r: 1, g: 1, b: 1, a: 1 } }]);
    if (bg)
        out.push(`- 背景：${bg}`);
    if (root.layoutMode) {
        out.push(`- 布局：${root.layoutMode}，padding ${root.paddingTop ?? 0}/${root.paddingRight ?? 0}/${root.paddingBottom ?? 0}/${root.paddingLeft ?? 0}`);
    }
    out.push('');
    // 文本
    const texts = [];
    const walk = (n, depth) => {
        if (n.type === 'TEXT' && n.characters)
            texts.push({ depth, n });
        for (const c of n.children ?? [])
            walk(c, depth + 1);
    };
    walk(root, 0);
    if (texts.length) {
        out.push('## 文本内容');
        out.push('');
        out.push('| 文本 | 字体 | 颜色 | 位置 |');
        out.push('|---|---|---|---|');
        for (const { n } of texts) {
            out.push(`| ${(n.characters ?? '').replace(/\u00a0/g, ' ').replace(/\|/g, '\\|')} | ${fontText(n) || '—'} | ${rgba(n.fills) || '—'} | ${bboxText(n)} |`);
        }
        out.push('');
    }
    // 输入框（Input Field 矢量）
    const inputs = [];
    const collect = (n) => {
        if (n.type === 'VECTOR' && /input\s*field/i.test(n.name))
            inputs.push(n);
        for (const c of n.children ?? [])
            collect(c);
    };
    collect(root);
    if (inputs.length) {
        out.push('## 输入框');
        out.push('');
        out.push('| 名称 | 尺寸 | 背景 | 描边 | 位置 |');
        out.push('|---|---|---|---|---|');
        for (const n of inputs) {
            out.push(`| ${n.name} | ${n.absoluteBoundingBox ? `${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '—'} | ${rgba(n.fills) || '—'} | ${rgba(n.strokes) || '—'}${n.strokeWeight ? ` ${n.strokeWeight}px` : ''} | ${bboxText(n)} |`);
        }
        out.push('');
    }
    // 按钮/实例
    const buttons = [];
    const collectBtn = (n) => {
        if (/button/i.test(n.name) || n.type === 'INSTANCE')
            buttons.push(n);
        for (const c of n.children ?? [])
            collectBtn(c);
    };
    collectBtn(root);
    if (buttons.length) {
        out.push('## 按钮与组件实例');
        out.push('');
        out.push('| 名称 | 类型 | 背景 | 描边 | 尺寸 |');
        out.push('|---|---|---|---|---|');
        for (const n of buttons) {
            out.push(`| ${n.name} | ${n.type}${n.componentId ? ` (${n.componentId})` : ''} | ${rgba(n.fills) || '—'} | ${rgba(n.strokes) || '—'}${n.strokeWeight ? ` ${n.strokeWeight}px` : ''} | ${n.absoluteBoundingBox ? `${Math.round(n.absoluteBoundingBox.width)}×${Math.round(n.absoluteBoundingBox.height)}` : '—'} |`);
        }
        out.push('');
    }
    // 完整图层树
    out.push('## 图层树');
    out.push('');
    out.push('```');
    const lines = [];
    const tree = (n, depth) => {
        lines.push(`${'  '.repeat(depth)}${n.type} ${n.name} (${n.id}) ${bboxText(n)}`);
        for (const c of n.children ?? [])
            tree(c, depth + 1);
    };
    tree(root, 0);
    out.push(lines.join('\n'));
    out.push('```');
    out.push('');
    return out.join('\n');
}
export function apply(ctx, config = {}) {
    const token = config.token || process.env.FIGMA_TOKEN;
    const outputDir = resolve(config.outputDir || join(homedir(), 'Desktop', 'figma-exports'));
    const scale = config.scale ?? 2;
    const renderDefault = config.render ?? true;
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
            render: (_args, value) => [textBlock(String(value))],
        },
        async execute(args) {
            const tk = args.token || token;
            if (!tk)
                throw new Error('缺少 Figma token：请在工具参数 token、插件配置 token 或环境变量 FIGMA_TOKEN 中提供');
            const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id);
            const outDir = resolve(args.output_dir || outputDir);
            await mkdir(outDir, { recursive: true });
            const cacheDir = join(outDir, 'figma_cache');
            const cacheFile = join(cacheDir, `${fileKey}.json`);
            // 1) 整文件数据：优先缓存，refresh=true 或缓存缺失时拉 API
            const readCache = async () => {
                try {
                    return JSON.parse(await readFile(cacheFile, 'utf8'));
                }
                catch {
                    return null;
                }
            };
            const fetchWhole = async () => {
                const data = await figmaGet(`/files/${encodeURIComponent(fileKey)}`, tk);
                await mkdir(cacheDir, { recursive: true });
                await writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf8');
                return data;
            };
            let data = null;
            let fromCache = false;
            if (!args.refresh) {
                data = await readCache();
                fromCache = data !== null;
            }
            if (!data)
                data = await fetchWhole();
            // 2) 定位节点；缓存里没有则强制刷新一次再找
            let doc = findNode(data.document, nodeId);
            if (!doc && fromCache) {
                data = await fetchWhole();
                fromCache = false;
                doc = findNode(data.document, nodeId);
            }
            if (!doc)
                throw new Error(`节点 ${nodeId} 不存在或无权限`);
            const base = `figma_${fileKey}_${nodeId.replace(':', '-')}`;
            const jsonPath = join(outDir, `${base}.json`);
            const mdPath = join(outDir, `${base}.report.md`);
            await writeFile(jsonPath, JSON.stringify({ fileKey, fileName: data.name, nodeId, node: doc }, null, 2), 'utf8');
            // 3) Markdown 报告
            const report = buildReport(doc);
            await writeFile(mdPath, report, 'utf8');
            // 4) 渲染 PNG（独立请求，按需调用）
            let pngPath = null;
            if (args.render ?? renderDefault) {
                const img = await figmaGet(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${args.scale ?? scale}`, tk);
                const url = img.images?.[nodeId];
                if (url) {
                    const res = await fetch(url);
                    if (res.ok) {
                        pngPath = join(outDir, `${base}.png`);
                        await writeFile(pngPath, Buffer.from(await res.arrayBuffer()));
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
            ];
            return lines.join('\n');
        },
    })), '@deepseek-ai/dsh-tool-figma-reader: figma_read_node');
}
//# sourceMappingURL=index.js.map