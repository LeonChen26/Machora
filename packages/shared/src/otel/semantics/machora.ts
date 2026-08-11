// Machora 自有语义规范（machora.*）
// 参考 LoongSuite（gen_ai.span.kind=ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING）与
// OpenInference（openinference.span.kind=LLM/CHAIN/TOOL/AGENT/...）设计：
// 提供一套与具体框架无关、粒度统一（含 ENTRY/STEP 等角色）的推荐语义。
// 优先级：本规范最高（machora.* 显式覆盖 langfuse.observation.type 之外的一切）。

export const MACHORA_ATTR = {
  // 角色：ENTRY / AGENT / STEP / LLM / TOOL / EMBEDDING / CHAIN / RETRIEVER / RERANKER / EVENT
  SPAN_KIND: "machora.span.kind",
  // 显式 observation 类型覆盖（span.kind 多值；兼容旧三值 GENERATION / SPAN / EVENT），最高优先级
  OBS_TYPE: "machora.observation.type",
  OPERATION: "machora.operation",

  TRACE_NAME: "machora.trace.name",
  USER_ID: "machora.user.id",
  SESSION_ID: "machora.session.id",
  AGENT_NAME: "machora.agent.name",
  WORKFLOW_NAME: "machora.workflow.name",
  SKILL_NAME: "machora.skill.name",
  TAGS: "machora.tags",
  METADATA: "machora.metadata",

  MODEL_NAME: "machora.model.name",
  TOOL_NAME: "machora.tool.name",
  TOOL_CALL_ID: "machora.tool.call.id",
  INPUT: "machora.input", // JSON 字符串或对象
  OUTPUT: "machora.output",
  TOKEN_INPUT: "machora.token.input",
  TOKEN_OUTPUT: "machora.token.output",
  TOKEN_TOTAL: "machora.token.total",
  COST_TOTAL: "machora.cost.total",
  LEVEL: "machora.level",
} as const;

/** machora.span.kind → 生成类（GENERATION）的取值 */
export const MACHORA_GENERATION_KINDS = new Set<string>(["LLM", "EMBEDDING"]);

/** machora.span.kind → 事件类（EVENT）的取值 */
export const MACHORA_EVENT_KINDS = new Set<string>(["EVENT"]);

/** machora.span.kind 全部合法取值（供文档与校验） */
export const MACHORA_SPAN_KINDS = [
  "ENTRY",
  "AGENT",
  "STEP",
  "LLM",
  "TOOL",
  "EMBEDDING",
  "CHAIN",
  "RETRIEVER",
  "RERANKER",
  "EVENT",
] as const;
