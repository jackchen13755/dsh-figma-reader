/**
 * @deepseek-ai/dsh-tool-figma-reader — 读取 Figma 设计稿节点。
 *
 * 把一个 Figma 设计稿节点（FRAME/组件）拉成三层产物：
 * 1. 节点原始 JSON（REST API `GET /v1/files/{key}/nodes`）
 * 2. 结构化 Markdown 报告（图层树、文本、字体、颜色、布局、按钮/输入框）
 * 3. 渲染 PNG（`GET /v1/images/{key}`，可选）
 *
 * 设计稿节点由 Figma REST API 读取，无需浏览器；凭据用 Personal Access Token
 * （配置项 token，或环境变量 FIGMA_TOKEN）。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@deepseek-ai/dsh-tool-figma-reader";
export declare const inject: string[];
export interface Config {
    /** Figma Personal Access Token（优先于环境变量 FIGMA_TOKEN）。 */
    token?: string;
    /** 导出目录，默认 ~/Desktop/figma-exports。 */
    outputDir?: string;
    /** 渲染 PNG 的缩放倍数，默认 2。 */
    scale?: number;
    /** 默认是否渲染 PNG，默认 true。 */
    render?: boolean;
}
export declare const Config: z<Schemastery.ObjectS<{
    token: z<string, string>;
    outputDir: z<string, string>;
    scale: z<number, number>;
    render: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    token: z<string, string>;
    outputDir: z<string, string>;
    scale: z<number, number>;
    render: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config?: Config): void;
