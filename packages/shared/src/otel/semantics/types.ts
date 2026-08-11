// 统一语义接入层 —— 中间模型
// 各来源（Machora / Langfuse / OpenTelemetry GenAI / OpenInference / LoongSuite）
// 的 OTLP 属性经 adapter 归一化到本模型，processor 只消费本模型，不再感知具体键。

/** 归一化 span 角色（融合 LoongSuite 与 OpenInference 的粒度） */
export type SpanKind =
  | "ENTRY" // Agent 调用入口
  | "AGENT" // Agent 本体
  | "STEP" // ReAct 单轮
  | "LLM" // 模型调用
  | "TOOL" // 工具调用
  | "EMBEDDING" // 嵌入
  | "CHAIN" // 工作流 / 链条
  | "RETRIEVER" // RAG 检索
  | "RERANKER" // 重排
  | "EVENT" // 日志 / 事件
  | "UNKNOWN";

/** 一套语义来源对某个 span 提取出的统一语义（字段为 null 表示该来源未提供） */
export interface SemanticSpan {
  kind: SpanKind | null;
  operation: string | null;
  model: string | null;
  toolName: string | null;
  toolCallId: string | null;
  agentName: string | null;
  workflowName: string | null;
  skillName: string | null;
  userId: string | null;
  sessionId: string | null;
  traceName: string | null;
  tags: string[] | null;
  metadata: unknown;
  input: unknown;
  output: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  totalCost: number | null;
  level: string | null;
}

/** 语义来源标识 */
export type SemanticSource =
  | "machora"
  | "langfuse"
  | "openinference"
  | "genai"
  | "loongsuite"
  | "fallback";

/** 语义接入层 adapter：把某来源的属性抽取为统一语义（先注册 / 高优先级者先合并） */
export interface SemanticsAdapter {
  source: SemanticSource;
  priority: number;
  extract(attrs: Record<string, unknown>): Partial<SemanticSpan>;
}

/** 落库 observation.type：与 span.kind 一致的多值（span.kind → type 直接落库）。
 *  SPAN = 通用节点（kind 为 UNKNOWN/null 时的落库值）。 */
export type MachoraObservationType =
  | "ENTRY"
  | "AGENT"
  | "STEP"
  | "LLM"
  | "TOOL"
  | "EMBEDDING"
  | "CHAIN"
  | "RETRIEVER"
  | "RERANKER"
  | "EVENT"
  | "SPAN";

export interface AnalyzedSpan extends SemanticSpan {
  type: MachoraObservationType;
  level: string;
}

/** 模型调用类 type（LLM / EMBEDDING） */
export const GENERATION_OBS_TYPES = ["LLM", "EMBEDDING"] as const;

export const isGenerationType = (t: string | null | undefined): boolean =>
  t === "LLM" || t === "EMBEDDING";
