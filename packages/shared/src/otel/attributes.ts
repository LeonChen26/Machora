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

  // OpenInference（LlamaIndex 等）
  OPENINFERENCE_KIND: "openinference.span.kind",
} as const;

// metadata 中剔除的噪声前缀（参考 Langfuse OtelIngestionProcessor）
export const NOISE_PREFIXES = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "llm.",
] as const;
