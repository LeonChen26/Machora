// OpenInference semantic attribute keys used by the Machora probe.
// Mirrors packages/shared/src/otel/attributes.ts in the Machroa repo.

export const OPENINFERENCE_KIND = "openinference.span.kind";
export const OPENINFERENCE_INPUT = "input.value";
export const OPENINFERENCE_OUTPUT = "output.value";
export const OPENINFERENCE_LLM_MODEL = "llm.model_name";
export const OPENINFERENCE_LLM_TOKEN_PROMPT = "llm.token_count.prompt";
export const OPENINFERENCE_LLM_TOKEN_COMPLETION = "llm.token_count.completion";
export const OPENINFERENCE_LLM_TOKEN_TOTAL = "llm.token_count.total";
export const OPENINFERENCE_SESSION_ID = "session.id";
export const OPENINFERENCE_USER_ID = "user.id";
export const OPENINFERENCE_AGENT_NAME = "agent.name";
export const OPENINFERENCE_TOOL_NAME = "tool.name";
export const OPENINFERENCE_TOOL_ID = "tool_call.id";

export const SPAN_KIND_AGENT = "AGENT";
export const SPAN_KIND_CHAIN = "CHAIN";
export const SPAN_KIND_LLM = "LLM";
export const SPAN_KIND_TOOL = "TOOL";
