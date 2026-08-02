// OTel 属性键常量（参考 Langfuse packages/shared/src/server/otel/attributes.ts
// 与 OpenTelemetry GenAI 语义约定 gen_ai.*）

export const ATTR = {
  // trace 级（Langfuse 约定 + GenAI 兼容）
  TRACE_NAME: "langfuse.trace.name",
  TRACE_USER_ID: "user.id",
  TRACE_SESSION_ID: "session.id",
  TRACE_TAGS: "langfuse.trace.tags",
  TRACE_METADATA: "langfuse.trace.metadata",
  TRACE_INPUT: "langfuse.trace.input",
  TRACE_OUTPUT: "langfuse.trace.output",
  COMPAT_USER_ID: "langfuse.user.id",
  COMPAT_SESSION_ID: "langfuse.session.id",
  ENVIRONMENT: "langfuse.environment",
  RELEASE: "langfuse.release",

  // observation 级
  OBS_TYPE: "langfuse.observation.type",
  OBS_METADATA: "langfuse.observation.metadata",
  OBS_LEVEL: "langfuse.observation.level",
  OBS_STATUS_MESSAGE: "langfuse.observation.status_message",
  OBS_INPUT: "langfuse.observation.input",
  OBS_OUTPUT: "langfuse.observation.output",
  OBS_MODEL: "langfuse.observation.model.name",
  OBS_USAGE_DETAILS: "langfuse.observation.usage_details",
  OBS_COST_DETAILS: "langfuse.observation.cost_details",

  // OpenTelemetry GenAI 语义约定
  GEN_AI_OPERATION: "gen_ai.operation.name",
  GEN_AI_TOOL_NAME: "gen_ai.tool.name",
  GEN_AI_TOOL_CALL_ID: "gen_ai.tool.call.id",
  GEN_AI_TOOL_ARGS: "gen_ai.tool.call.arguments",
  GEN_AI_TOOL_RESULT: "gen_ai.tool.call.result",
  GEN_AI_INPUT_MESSAGES: "gen_ai.input.messages",
  GEN_AI_OUTPUT_MESSAGES: "gen_ai.output.messages",
  GEN_AI_SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  GEN_AI_PROMPT: "gen_ai.prompt",
  GEN_AI_COMPLETION: "gen_ai.completion",
  GEN_AI_REQUEST_MODEL: "gen_ai.request.model",
  GEN_AI_RESPONSE_MODEL: "gen_ai.response.model",
  GEN_AI_USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  GEN_AI_USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  GEN_AI_AGENT_NAME: "gen_ai.agent.name",
  GEN_AI_WORKFLOW_NAME: "gen_ai.workflow.name",
  // LoongSuite GenAI SemConv 增强（阿里云 loongsuite-otel-util-genai，见 design.md §6.8）
  // gen_ai.skill.* 挂在 execute_tool span 上标识业务技能；其余 skill.id/description/version 留 metadata
  GEN_AI_SKILL_NAME: "gen_ai.skill.name",
  // LoongSuite 用 gen_ai.span.kind（LLM/STEP/TOOL/AGENT/ENTRY 等）标记 span 类型；
  // entry span 把 user/session 写入 gen_ai.user.id / gen_ai.session.id
  GEN_AI_SPAN_KIND: "gen_ai.span.kind",
  GEN_AI_USER_ID: "gen_ai.user.id",
  GEN_AI_SESSION_ID: "gen_ai.session.id",
  GEN_AI_ERROR_TYPE: "error.type",

  // OpenInference（LlamaIndex 等）：span.kind 带前缀，其余属性为精简键
  // （规范见 https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md）
  OPENINFERENCE_KIND: "openinference.span.kind",
  OPENINFERENCE_INPUT: "input.value",
  OPENINFERENCE_INPUT_MIME: "input.mime_type",
  OPENINFERENCE_OUTPUT: "output.value",
  OPENINFERENCE_OUTPUT_MIME: "output.mime_type",
  OPENINFERENCE_LLM_MODEL: "llm.model_name",
  OPENINFERENCE_LLM_TOKEN_PROMPT: "llm.token_count.prompt",
  OPENINFERENCE_LLM_TOKEN_COMPLETION: "llm.token_count.completion",
  OPENINFERENCE_LLM_TOKEN_TOTAL: "llm.token_count.total",
  OPENINFERENCE_LLM_COST_TOTAL: "llm.cost.total",
  OPENINFERENCE_METADATA: "metadata",
  OPENINFERENCE_SESSION_ID: "session.id",
  OPENINFERENCE_USER_ID: "user.id",
  OPENINFERENCE_TAGS: "tag.tags",
  OPENINFERENCE_AGENT_NAME: "agent.name",
  OPENINFERENCE_TOOL_NAME: "tool.name",
  OPENINFERENCE_TOOL_ID: "tool_call.id",
} as const;

// GenAI 语义约定 well-known operation 值：agent / workflow / plan / memory 系列 + LoongSuite 增强
// （entry 应用入口、react_step ReAct 单轮、rerank、skill 系列）
// 这些操作统一映射 SPAN（语义保留在 name/metadata），此处显式枚举供识别与文档化
export const AGENT_OPERATIONS = new Set<string>([
  "invoke_agent",
  "create_agent",
  "plan",
  "invoke_workflow",
  "create_workflow",
  "create_memory",
  "search_memory",
  "upsert_memory",
  "update_memory",
  "get_memory",
  "delete_memory",
  "memory",
  "retrieval",
  // LoongSuite GenAI SemConv（2026-08-02 补齐）
  "entry",
  "react_step",
  "rerank",
  "invoke_skill",
  "create_skill",
  "skill",
]);

// metadata 中剔除的噪声前缀（参考 Langfuse OtelIngestionProcessor）
export const NOISE_PREFIXES = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "llm.",
  "openinference.",
  "embedding.",
] as const;

// OpenInference span kind（openinference.span.kind）→ Machora observation 类型
// 规范见 https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
export const OPENINFERENCE_GENERATION_KINDS = new Set<string>([
  "LLM",
  "EMBEDDING",
]);

export const OPENINFERENCE_SPAN_KINDS = new Set<string>([
  "CHAIN",
  "RETRIEVER",
  "RERANKER",
  "TOOL",
  "AGENT",
  "GUARDRAIL",
  "EVALUATOR",
  "PROMPT",
]);
