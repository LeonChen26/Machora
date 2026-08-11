// 统一语义接入层（Semantics Adapter Layer）
// Machora / Langfuse / OpenInference / GenAI / LoongSuite 等多套 OTLP 语义
// 统一归一化到 SemanticSpan 中间模型；processor 只消费本层输出。

export * from "./types.ts";
export * from "./machora.ts";
export * from "./util.ts";
export * from "./adapters.ts";
export * from "./analyze.ts";
