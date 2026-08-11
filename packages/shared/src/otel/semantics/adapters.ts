// 统一语义接入层 —— 各来源 adapter
// 每个来源（Machora / Langfuse / OpenInference / GenAI / LoongSuite / 兜底推断）
// 实现 extract(attrs) → Partial<SemanticSpan>；按 priority 从低到高合并（先到先得）。

import { ATTR, AGENT_OPERATIONS } from "../attributes.ts";
import { MACHORA_ATTR } from "./machora.ts";
import type { SemanticSpan, SemanticsAdapter, SpanKind } from "./types.ts";
import { asNumber, asObject, asString, asStringArray, decodeJsonValue } from "./util.ts";

const empty = (): SemanticSpan => ({
  kind: null,
  operation: null,
  model: null,
  toolName: null,
  toolCallId: null,
  agentName: null,
  workflowName: null,
  skillName: null,
  userId: null,
  sessionId: null,
  traceName: null,
  tags: null,
  metadata: null,
  input: null,
  output: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  totalCost: null,
  level: null,
});

// ---------------------------------------------------------------------------
// 1. Machora 原生语义（优先级最高）
// ---------------------------------------------------------------------------
const machoraAdapter: SemanticsAdapter = {
  source: "machora",
  priority: 10,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const kind = asString(attrs[MACHORA_ATTR.SPAN_KIND]);
    if (kind) part.kind = kind.toUpperCase() as SpanKind;
    const operation = asString(attrs[MACHORA_ATTR.OPERATION]);
    if (operation) part.operation = operation;
    const model = asString(attrs[MACHORA_ATTR.MODEL_NAME]);
    if (model) part.model = model;
    const toolName = asString(attrs[MACHORA_ATTR.TOOL_NAME]);
    if (toolName) part.toolName = toolName;
    const toolCallId = asString(attrs[MACHORA_ATTR.TOOL_CALL_ID]);
    if (toolCallId) part.toolCallId = toolCallId;
    const agentName = asString(attrs[MACHORA_ATTR.AGENT_NAME]);
    if (agentName) part.agentName = agentName;
    const workflowName = asString(attrs[MACHORA_ATTR.WORKFLOW_NAME]);
    if (workflowName) part.workflowName = workflowName;
    const skillName = asString(attrs[MACHORA_ATTR.SKILL_NAME]);
    if (skillName) part.skillName = skillName;
    const userId = asString(attrs[MACHORA_ATTR.USER_ID]);
    if (userId) part.userId = userId;
    const sessionId = asString(attrs[MACHORA_ATTR.SESSION_ID]);
    if (sessionId) part.sessionId = sessionId;
    const traceName = asString(attrs[MACHORA_ATTR.TRACE_NAME]);
    if (traceName) part.traceName = traceName;
    const tags = asStringArray(attrs[MACHORA_ATTR.TAGS]);
    if (tags.length > 0) part.tags = tags;
    if (attrs[MACHORA_ATTR.METADATA] !== undefined) part.metadata = attrs[MACHORA_ATTR.METADATA];
    if (attrs[MACHORA_ATTR.INPUT] !== undefined)
      part.input = decodeJsonValue(attrs[MACHORA_ATTR.INPUT], "application/json");
    if (attrs[MACHORA_ATTR.OUTPUT] !== undefined)
      part.output = decodeJsonValue(attrs[MACHORA_ATTR.OUTPUT], "application/json");
    const inTok = asNumber(attrs[MACHORA_ATTR.TOKEN_INPUT]);
    if (inTok !== null) part.inputTokens = inTok;
    const outTok = asNumber(attrs[MACHORA_ATTR.TOKEN_OUTPUT]);
    if (outTok !== null) part.outputTokens = outTok;
    const totTok = asNumber(attrs[MACHORA_ATTR.TOKEN_TOTAL]);
    if (totTok !== null) part.totalTokens = totTok;
    const cost = asNumber(attrs[MACHORA_ATTR.COST_TOTAL]);
    if (cost !== null) part.totalCost = cost;
    const level = asString(attrs[MACHORA_ATTR.LEVEL]);
    if (level) part.level = level;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 2. Langfuse 语义
// ---------------------------------------------------------------------------
const langfuseAdapter: SemanticsAdapter = {
  source: "langfuse",
  priority: 20,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const model = asString(attrs[ATTR.OBS_MODEL]);
    if (model) part.model = model;
    const userId = asString(attrs[ATTR.TRACE_USER_ID] ?? attrs[ATTR.COMPAT_USER_ID]);
    if (userId) part.userId = userId;
    const sessionId = asString(attrs[ATTR.TRACE_SESSION_ID] ?? attrs[ATTR.COMPAT_SESSION_ID]);
    if (sessionId) part.sessionId = sessionId;
    const traceName = asString(attrs[ATTR.TRACE_NAME]);
    if (traceName) part.traceName = traceName;
    const tags = asStringArray(attrs[ATTR.TRACE_TAGS]);
    if (tags.length > 0) part.tags = tags;
    if (attrs[ATTR.OBS_METADATA] !== undefined) part.metadata = attrs[ATTR.OBS_METADATA];
    if (attrs[ATTR.OBS_INPUT] !== undefined) part.input = attrs[ATTR.OBS_INPUT];
    if (attrs[ATTR.OBS_OUTPUT] !== undefined) part.output = attrs[ATTR.OBS_OUTPUT];
    const usage = asObject(attrs[ATTR.OBS_USAGE_DETAILS]);
    if (usage) {
      const inTok = asNumber(usage["input"]);
      if (inTok !== null) part.inputTokens = inTok;
      const outTok = asNumber(usage["output"]);
      if (outTok !== null) part.outputTokens = outTok;
    }
    const cost = asObject(attrs[ATTR.OBS_COST_DETAILS]);
    if (cost) {
      const c = asNumber(cost["total"]);
      if (c !== null) part.totalCost = c;
    }
    const level = asString(attrs[ATTR.OBS_LEVEL]);
    if (level) part.level = level;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 3. OpenInference（LlamaIndex 生态，精简键 + span.kind 前缀）
// ---------------------------------------------------------------------------
const openInferenceAdapter: SemanticsAdapter = {
  source: "openinference",
  priority: 30,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const kind = asString(attrs[ATTR.OPENINFERENCE_KIND]);
    if (kind) part.kind = kind.toUpperCase() as SpanKind;
    const model = asString(attrs[ATTR.OPENINFERENCE_LLM_MODEL]);
    if (model) part.model = model;
    const toolName = asString(attrs[ATTR.OPENINFERENCE_TOOL_NAME]);
    if (toolName) part.toolName = toolName;
    const toolCallId = asString(attrs[ATTR.OPENINFERENCE_TOOL_ID]);
    if (toolCallId) part.toolCallId = toolCallId;
    const agentName = asString(attrs[ATTR.OPENINFERENCE_AGENT_NAME]);
    if (agentName) part.agentName = agentName;
    const userId = asString(attrs[ATTR.OPENINFERENCE_USER_ID]);
    if (userId) part.userId = userId;
    const sessionId = asString(attrs[ATTR.OPENINFERENCE_SESSION_ID]);
    if (sessionId) part.sessionId = sessionId;
    const tags = asStringArray(attrs[ATTR.OPENINFERENCE_TAGS]);
    if (tags.length > 0) part.tags = tags;
    if (attrs[ATTR.OPENINFERENCE_METADATA] !== undefined)
      part.metadata = decodeJsonValue(attrs[ATTR.OPENINFERENCE_METADATA], "application/json");
    if (attrs[ATTR.OPENINFERENCE_INPUT] !== undefined)
      part.input = decodeJsonValue(attrs[ATTR.OPENINFERENCE_INPUT], attrs[ATTR.OPENINFERENCE_INPUT_MIME]);
    if (attrs[ATTR.OPENINFERENCE_OUTPUT] !== undefined)
      part.output = decodeJsonValue(attrs[ATTR.OPENINFERENCE_OUTPUT], attrs[ATTR.OPENINFERENCE_OUTPUT_MIME]);
    const inTok = asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_PROMPT]);
    if (inTok !== null) part.inputTokens = inTok;
    const outTok = asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_COMPLETION]);
    if (outTok !== null) part.outputTokens = outTok;
    const totTok = asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_TOTAL]);
    if (totTok !== null) part.totalTokens = totTok;
    const cost = asNumber(attrs[ATTR.OPENINFERENCE_LLM_COST_TOTAL]);
    if (cost !== null) part.totalCost = cost;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 4. LoongSuite GenAI 增强（gen_ai.span.kind / gen_ai.skill.* / gen_ai.user.id 等）
// ---------------------------------------------------------------------------
const loongSuiteAdapter: SemanticsAdapter = {
  source: "loongsuite",
  priority: 35,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const kind = asString(attrs[ATTR.GEN_AI_SPAN_KIND]);
    if (kind) part.kind = kind.toUpperCase() as SpanKind;
    const skillName = asString(attrs[ATTR.GEN_AI_SKILL_NAME]);
    if (skillName) part.skillName = skillName;
    const userId = asString(attrs[ATTR.GEN_AI_USER_ID]);
    if (userId) part.userId = userId;
    const sessionId = asString(attrs[ATTR.GEN_AI_SESSION_ID]);
    if (sessionId) part.sessionId = sessionId;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 5. OpenTelemetry GenAI（标准 gen_ai.*）
// ---------------------------------------------------------------------------
const genAiAdapter: SemanticsAdapter = {
  source: "genai",
  priority: 40,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const operation = asString(attrs[ATTR.GEN_AI_OPERATION]);
    if (operation) part.operation = operation;
    const model =
      asString(attrs[ATTR.GEN_AI_REQUEST_MODEL]) ??
      asString(attrs[ATTR.GEN_AI_RESPONSE_MODEL]);
    if (model) part.model = model;
    const toolName = asString(attrs[ATTR.GEN_AI_TOOL_NAME]);
    if (toolName) part.toolName = toolName;
    const toolCallId = asString(attrs[ATTR.GEN_AI_TOOL_CALL_ID]);
    if (toolCallId) part.toolCallId = toolCallId;
    const agentName = asString(attrs[ATTR.GEN_AI_AGENT_NAME]);
    if (agentName) part.agentName = agentName;
    const workflowName = asString(attrs[ATTR.GEN_AI_WORKFLOW_NAME]);
    if (workflowName) part.workflowName = workflowName;
    if (attrs[ATTR.GEN_AI_INPUT_MESSAGES] !== undefined)
      part.input = decodeJsonValue(attrs[ATTR.GEN_AI_INPUT_MESSAGES], undefined);
    else if (attrs[ATTR.GEN_AI_TOOL_ARGS] !== undefined)
      part.input = attrs[ATTR.GEN_AI_TOOL_ARGS];
    else if (attrs[ATTR.GEN_AI_PROMPT] !== undefined) part.input = attrs[ATTR.GEN_AI_PROMPT];
    if (attrs[ATTR.GEN_AI_OUTPUT_MESSAGES] !== undefined)
      part.output = decodeJsonValue(attrs[ATTR.GEN_AI_OUTPUT_MESSAGES], undefined);
    else if (attrs[ATTR.GEN_AI_TOOL_RESULT] !== undefined)
      part.output = attrs[ATTR.GEN_AI_TOOL_RESULT];
    else if (attrs[ATTR.GEN_AI_COMPLETION] !== undefined) part.output = attrs[ATTR.GEN_AI_COMPLETION];
    const inTok = asNumber(attrs[ATTR.GEN_AI_USAGE_INPUT_TOKENS]);
    if (inTok !== null) part.inputTokens = inTok;
    const outTok = asNumber(attrs[ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]);
    if (outTok !== null) part.outputTokens = outTok;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 6. 兜底：由 operation / tool / model 推断 kind（保证旧行为等价）
// ---------------------------------------------------------------------------
const GENERATION_OPERATIONS = new Set<string>([
  "chat",
  "completion",
  "text_completion",
  "generate_content",
  "generate",
  "embeddings",
]);

function inferKindFromOperation(op: string | null, toolName: string | null, model: string | null): SpanKind | null {
  if (op) {
    const o = op.toLowerCase();
    if (o === "embeddings") return "EMBEDDING";
    if (GENERATION_OPERATIONS.has(o)) return "LLM";
    if (o === "entry") return "ENTRY";
    if (o === "invoke_agent" || o === "create_agent" || o === "agent") return "AGENT";
    if (o === "react_step" || o === "plan") return "STEP";
    if (o === "invoke_workflow" || o === "create_workflow") return "CHAIN";
    if (o === "retrieval") return "RETRIEVER";
    if (o === "rerank") return "RERANKER";
    if (AGENT_OPERATIONS.has(o)) return "UNKNOWN"; // memory/skill 等 → SPAN
    return null;
  }
  if (toolName) return "TOOL";
  if (model) return "LLM";
  return null;
}

const fallbackAdapter: SemanticsAdapter = {
  source: "fallback",
  priority: 100,
  extract(attrs) {
    const part: Partial<SemanticSpan> = {};
    const kind = inferKindFromOperation(
      asString(attrs[ATTR.GEN_AI_OPERATION]),
      asString(attrs[ATTR.GEN_AI_TOOL_NAME] ?? attrs[ATTR.OPENINFERENCE_TOOL_NAME]),
      asString(attrs[ATTR.GEN_AI_REQUEST_MODEL] ?? attrs[ATTR.GEN_AI_RESPONSE_MODEL]),
    );
    if (kind) part.kind = kind;
    return part;
  },
};

// ---------------------------------------------------------------------------
// 注册表（统一接入层管理：新增语义来源只需在此追加 adapter）
// ---------------------------------------------------------------------------
export const SEMANTICS_ADAPTERS: SemanticsAdapter[] = [
  machoraAdapter,
  langfuseAdapter,
  openInferenceAdapter,
  loongSuiteAdapter,
  genAiAdapter,
  fallbackAdapter,
].sort((a, b) => a.priority - b.priority);

export { empty as emptySemanticSpan };
