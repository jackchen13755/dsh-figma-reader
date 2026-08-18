/** 解析单帧 Kiwi 消息，定位目标节点并构建子树报告。 */
export declare function decodeFrameAndBuildReport(dataFramePath: string, fileKey: string, nodeId: string, outDir: string): {
    jsonPath: string;
    mdPath: string;
    nodeCount: number;
    messageType: string;
};
