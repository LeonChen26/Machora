// Machora 原生语义（machora.*）
// 与 packages/shared/src/otel/semantics/machora.ts 对齐：
// 探针直接上报 machora.* 键，接入层 machora adapter（priority 10）归一化后
// machora.span.kind 直接落库 observation.type（span.kind 多值，最高优先级）。

export const MACHORA_SPAN_KIND = "machora.span.kind";
export const MACHORA_OPERATION = "machora.operation";
export const MACHORA_TRACE_NAME = "machora.trace.name";
export const MACHORA_USER_ID = "machora.user.id";
export const MACHORA_SESSION_ID = "machora.session.id";
export const MACHORA_AGENT_NAME = "machora.agent.name";
export const MACHORA_WORKFLOW_NAME = "machora.workflow.name";
export const MACHORA_SKILL_NAME = "machora.skill.name";
export const MACHORA_TAGS = "machora.tags";
export const MACHORA_METADATA = "machora.metadata";
export const MACHORA_MODEL_NAME = "machora.model.name";
export const MACHORA_TOOL_NAME = "machora.tool.name";
export const MACHORA_TOOL_CALL_ID = "machora.tool.call.id";
export const MACHORA_INPUT = "machora.input"; // JSON 字符串或对象
export const MACHORA_OUTPUT = "machora.output";
export const MACHORA_TOKEN_INPUT = "machora.token.input";
export const MACHORA_TOKEN_OUTPUT = "machora.token.output";
export const MACHORA_TOKEN_TOTAL = "machora.token.total";
export const MACHORA_COST_TOTAL = "machora.cost.total";
export const MACHORA_LEVEL = "machora.level";

// machora.span.kind 取值（与接入层 MACHORA_SPAN_KINDS 一致）
export const SPAN_KIND_ENTRY = "ENTRY"; // 顶层执行入口（根）
export const SPAN_KIND_AGENT = "AGENT"; // agent 本体运行
export const SPAN_KIND_STEP = "STEP"; // ReAct 单轮
export const SPAN_KIND_CHAIN = "CHAIN"; // 工作流 / 子链
export const SPAN_KIND_LLM = "LLM";
export const SPAN_KIND_TOOL = "TOOL";
export const SPAN_KIND_EMBEDDING = "EMBEDDING";
export const SPAN_KIND_RETRIEVER = "RETRIEVER";
