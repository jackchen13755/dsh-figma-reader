export interface CaptureArgs {
    fileKey: string;
    nodeId: string;
    url: string;
    outDir: string;
    waitSeconds?: number;
    screenshot?: boolean;
    browserHarnessPath?: string;
}
export interface CaptureResult {
    schemaPath: string | null;
    dataPath: string;
    screenshotPath: string | null;
    title?: string;
}
/** 运行 browser-harness 捕获 Figma WS 帧。 */
export declare function runCapture(args: CaptureArgs): Promise<CaptureResult>;
