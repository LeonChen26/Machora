// OTLP Span → Machora Trace / Observation 映射处理器
// 参考 Langfuse OtelIngestionProcessor + ObservationTypeMapperRegistry

import {
  ATTR,
  AGENT_OPERATIONS,
  NOISE_PREFIXES,
  OPENINFERENCE_GENERATION_KINDS,
  OPENINFERENCE_SPAN_KINDS,
} from "./attributes.ts";
import {
  decodeAttributes,
  type OtlpExportTraceServiceRequest,
  type OtlpSpan,
} from "./types.ts";
import { db } from "../db.ts";
import { observation, trace } from "../drizzle/schema.ts";

// ---------------------------------------------------------------------------
// 类型与状态常量
// ---------------------------------------------------------------------------

export type MachoraObservationType = "SPAN" | "GENERATION" | "EVENT";

const LEVEL_ALIASES: Record<string, string> = {
  DEBUG: "DEBUG",
  TRACE: "DEBUG",
  VERBOSE: "DEBUG",
  DEFAULT: "DEFAULT",
  INFO: "DEFAULT",
  LOG: "DEFAULT",
  NOTICE: "DEFAULT",
  OK: "DEFAULT",
  SUCCESS: "DEFAULT",
  WARNING: "WARNING",
  WARN: "WARNING",
  ERROR: "ERROR",
  FATAL: "ERROR",
  CRITICAL: "ERROR",
};

// 已提取到专用字段 / 显式剔除的属性键，不再进 metadata
// 语义键需保留在 metadata：虽在 ATTR 中，但无专用列，轨迹视图（推理轨迹）角色分类
// 依赖它们；gen_ai.tool.name 同时已被提取为 observation.name，保留便于分类与审计。
const RETAIN_IN_METADATA = new Set<string>([
  ATTR.GEN_AI_SPAN_KIND,
  ATTR.GEN_AI_OPERATION,
  ATTR.GEN_AI_TOOL_NAME,
  ATTR.GEN_AI_TOOL_CALL_ID,
]);
const EXTRACTED_KEYS = new Set<string>(
  Object.values(ATTR)
    .concat(["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"])
    .filter((k) => !RETAIN_IN_METADATA.has(k)),
);
// ---------------------------------------------------------------------------
// 中间结构
// ---------------------------------------------------------------------------

export interface TraceRecord {
  id: string;
  projectId: string;
  name: string | null;
  timestamp: Date;
  environment: string;
  userId: string | null;
  sessionId: string | null;
  agentName: string | null;
  workflowName: string | null;
  skillName: string | null;
  input: unknown;
  output: unknown;
  metadata: unknown;
  tags: string[];
}

export interface ObservationRecord {
  id: string;
  traceId: string;
  projectId: string;
  type: MachoraObservationType;
  name: string | null;
  parentObservationId: string | null;
  startTime: Date;
  endTime: Date | null;
  model: string | null;
  agentName: string | null;
  workflowName: string | null;
  skillName: string | null;
  input: unknown;
  output: unknown;
  metadata: unknown;
  level: string;
  usage: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  totalCost: number | null;
}

interface FlattenedSpan {
  span: OtlpSpan;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  attrs: Record<string, unknown>;
  resourceAttrs: Record<string, unknown>;
  scopeName: string | undefined;
  startTime: Date;
  endTime: Date | null;
  statusCode: number;
  statusMessage: string | null;
  events: { time: Date; name: string; attrs: Record<string, unknown> }[];
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function nanosToDate(ns: string | number | undefined): Date | null {
  if (ns === undefined || ns === null || ns === "") return null;
  const n = Number(ns);
  if (!Number.isFinite(n)) return null;
  return new Date(n / 1e6);
}

function parseLevel(attrs: Record<string, unknown>, statusCode: number): string {
  const raw = attrs[ATTR.OBS_LEVEL];
  if (typeof raw === "string" && LEVEL_ALIASES[raw.trim().toUpperCase()]) {
    return LEVEL_ALIASES[raw.trim().toUpperCase()];
  }
  if (statusCode === 2) return "ERROR";
  // OTel GenAI 语义：error.type 存在（且无显式 level / 非 OK status）→ ERROR
  if (attrs[ATTR.GEN_AI_ERROR_TYPE] !== undefined) return "ERROR";
  return "DEFAULT";
}

// ---------------------------------------------------------------------------
// 类型映射（优先级从高到低，参考 Langfuse ObservationTypeMapperRegistry）
// ---------------------------------------------------------------------------

function mapObservationType(
  attrs: Record<string, unknown>,
  _scopeName: string | undefined,
): MachoraObservationType {
  // 1. langfuse.observation.type
  const explicit = attrs[ATTR.OBS_TYPE];
  if (typeof explicit === "string") {
    const t = explicit.trim().toUpperCase();
    if (t === "GENERATION" || t === "EVENT") return t;
    return "SPAN";
  }

  // 2. OpenInference span kind（LlamaIndex 生态，required 属性）
  const oi = attrs[ATTR.OPENINFERENCE_KIND];
  if (typeof oi === "string" && oi.trim() !== "") {
    const kind = oi.trim().toUpperCase();
    if (OPENINFERENCE_GENERATION_KINDS.has(kind)) return "GENERATION";
    if (OPENINFERENCE_SPAN_KINDS.has(kind)) return "SPAN";
  }

  // 3. GenAI operation name
  const op = attrs[ATTR.GEN_AI_OPERATION];
  if (typeof op === "string") {
    const o = op.trim().toLowerCase();
    if (
      o === "chat" ||
      o === "completion" ||
      o === "text_completion" ||
      o === "generate_content" ||
      o === "generate" ||
      o === "embeddings"
    ) {
      return "GENERATION";
    }
    // agent / workflow / plan / memory / retrieval 系列：显式枚举 → SPAN
    // （语义保留在 SPAN.name / metadata，见 design.md §6.3）
    if (AGENT_OPERATIONS.has(o)) {
      return "SPAN";
    }
  }

  // 4. LoongSuite gen_ai.span.kind（LLM/STEP/TOOL/AGENT/ENTRY 等，见 design.md §6.8）
  const sk = attrs[ATTR.GEN_AI_SPAN_KIND];
  if (typeof sk === "string" && sk.trim() !== "") {
    const kind = sk.trim().toUpperCase();
    if (kind === "LLM" || kind === "EMBEDDING") return "GENERATION";
    return "SPAN";
  }

  // 5. 工具调用
  if (
    attrs[ATTR.GEN_AI_TOOL_NAME] !== undefined ||
    attrs[ATTR.GEN_AI_TOOL_CALL_ID] !== undefined
  ) {
    return "SPAN"; // TOOL 语义暂落在 SPAN.name（见 design.md §6.3）
  }

  // 6. 含模型信息 → generation
  if (
    attrs[ATTR.OBS_MODEL] !== undefined ||
    attrs[ATTR.GEN_AI_REQUEST_MODEL] !== undefined ||
    attrs[ATTR.GEN_AI_RESPONSE_MODEL] !== undefined
  ) {
    return "GENERATION";
  }

  return "SPAN";
}

// ---------------------------------------------------------------------------
// 字段提取
// ---------------------------------------------------------------------------

function extractModel(attrs: Record<string, unknown>): string | null {
  for (const k of [
    ATTR.OBS_MODEL,
    ATTR.GEN_AI_REQUEST_MODEL,
    ATTR.GEN_AI_RESPONSE_MODEL,
    ATTR.OPENINFERENCE_LLM_MODEL,
  ]) {
    const v = attrs[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** OpenInference 的 input/output.value 是字符串（mime_type 多为 application/json），尝试解码为对象 */
function decodeOtelValue(
  v: unknown,
  mime: unknown,
): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed === "") return v;
  const mimeStr = typeof mime === "string" ? mime.toLowerCase() : "";
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (mimeStr.includes("json") || looksJson) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}

/** 提取 gen_ai.agent.name / gen_ai.workflow.name（空串视为无） */
function extractSemanticName(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const v = attrs[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function extractIo(
  attrs: Record<string, unknown>,
): { input: unknown; output: unknown } {
  let input: unknown = null;
  let output: unknown = null;

  if (attrs[ATTR.OBS_INPUT] !== undefined) input = attrs[ATTR.OBS_INPUT];
  else if (attrs[ATTR.GEN_AI_INPUT_MESSAGES] !== undefined)
    // LoongSuite 等 SDK 可能把 messages 序列化为 JSON 字符串，尝试解码为数组
    input = decodeOtelValue(attrs[ATTR.GEN_AI_INPUT_MESSAGES], undefined);
  else if (attrs[ATTR.GEN_AI_TOOL_ARGS] !== undefined)
    input = attrs[ATTR.GEN_AI_TOOL_ARGS];
  else if (attrs[ATTR.GEN_AI_PROMPT] !== undefined)
    input = attrs[ATTR.GEN_AI_PROMPT];
  else if (attrs[ATTR.OPENINFERENCE_INPUT] !== undefined)
    input = decodeOtelValue(
      attrs[ATTR.OPENINFERENCE_INPUT],
      attrs[ATTR.OPENINFERENCE_INPUT_MIME],
    );

  if (attrs[ATTR.OBS_OUTPUT] !== undefined) output = attrs[ATTR.OBS_OUTPUT];
  else if (attrs[ATTR.GEN_AI_OUTPUT_MESSAGES] !== undefined)
    output = decodeOtelValue(attrs[ATTR.GEN_AI_OUTPUT_MESSAGES], undefined);
  else if (attrs[ATTR.GEN_AI_TOOL_RESULT] !== undefined)
    output = attrs[ATTR.GEN_AI_TOOL_RESULT];
  else if (attrs[ATTR.GEN_AI_COMPLETION] !== undefined)
    output = attrs[ATTR.GEN_AI_COMPLETION];
  else if (attrs[ATTR.OPENINFERENCE_OUTPUT] !== undefined)
    output = decodeOtelValue(
      attrs[ATTR.OPENINFERENCE_OUTPUT],
      attrs[ATTR.OPENINFERENCE_OUTPUT_MIME],
    );

  return { input, output };
}

function extractUsage(attrs: Record<string, unknown>): {
  usage: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  totalCost: number | null;
} {
  let inputTokens = asNumber(attrs[ATTR.GEN_AI_USAGE_INPUT_TOKENS]);
  let outputTokens = asNumber(attrs[ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]);
  let totalCost: number | null = null;

  const usageDetails = asObject(attrs[ATTR.OBS_USAGE_DETAILS]);
  if (usageDetails) {
    inputTokens ??= asNumber(usageDetails["input"]);
    outputTokens ??= asNumber(usageDetails["output"]);
  }
  // OpenInference：llm.token_count.{prompt,completion,total}
  inputTokens ??= asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_PROMPT]);
  outputTokens ??= asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_COMPLETION]);
  const costDetails = asObject(attrs[ATTR.OBS_COST_DETAILS]);
  if (costDetails) totalCost = asNumber(costDetails["total"]);
  totalCost ??= asNumber(attrs[ATTR.OPENINFERENCE_LLM_COST_TOTAL]);

  // totalTokens 优先级：显式 total > input+output 推算
  const explicitTotal = asNumber(attrs[ATTR.OPENINFERENCE_LLM_TOKEN_TOTAL]);
  const totalTokens =
    explicitTotal ?? (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);

  return {
    usage: attrs[ATTR.OBS_USAGE_DETAILS] ?? null,
    inputTokens,
    outputTokens,
    totalTokens,
    totalCost,
  };
}

function buildMetadata(
  attrs: Record<string, unknown>,
  resourceAttrs: Record<string, unknown>,
): unknown {
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (EXTRACTED_KEYS.has(k)) continue;
    if (NOISE_PREFIXES.some((p) => k.startsWith(p))) continue;
    meta[k] = v;
  }
  if (Object.keys(resourceAttrs).length > 0) {
    meta["resource"] = resourceAttrs;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

// ---------------------------------------------------------------------------
// 解析：OTLP payload → Trace/Observation 记录
// ---------------------------------------------------------------------------

export function parseOtelPayload(
  projectId: string,
  body: OtlpExportTraceServiceRequest | Record<string, unknown>,
): { traces: TraceRecord[]; observations: ObservationRecord[] } {
  const resourceSpans = (body as OtlpExportTraceServiceRequest).resourceSpans ?? [];
  const flattened: FlattenedSpan[] = [];
  const bySpanId = new Map<string, FlattenedSpan>();

  // 1. 展平：合并 resource 属性与 scope
  for (const rs of resourceSpans) {
    const resourceAttrs = decodeAttributes(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name;
      for (const span of ss.spans ?? []) {
        const traceId = span.traceId ?? "";
        const spanId = span.spanId ?? "";
        if (!traceId || !spanId) continue;
        const start = nanosToDate(span.startTimeUnixNano);
        if (!start) continue;
        const f: FlattenedSpan = {
          span,
          spanId,
          traceId,
          parentSpanId: span.parentSpanId && span.parentSpanId !== "" ? span.parentSpanId : null,
          attrs: decodeAttributes(span.attributes),
          resourceAttrs,
          scopeName,
          startTime: start,
          endTime: nanosToDate(span.endTimeUnixNano),
          statusCode: span.status?.code ?? 0,
          statusMessage: span.status?.message ?? null,
          events: (span.events ?? [])
            .map((e) => ({
              time: nanosToDate(e.timeUnixNano),
              name: e.name ?? "",
              attrs: decodeAttributes(e.attributes),
            }))
            .filter((e): e is { time: Date; name: string; attrs: Record<string, unknown> } => e.time !== null),
        };
        flattened.push(f);
        bySpanId.set(spanId, f);
      }
    }
  }

  // 2. 按 traceId 分组，识别根 span（父不在本批即视为根）
  const groups = new Map<string, FlattenedSpan[]>();
  for (const f of flattened) {
    const list = groups.get(f.traceId) ?? [];
    list.push(f);
    groups.set(f.traceId, list);
  }

  const traces: TraceRecord[] = [];
  const observations: ObservationRecord[] = [];

  for (const [traceId, spans] of groups) {
    const roots = spans.filter(
      (s) => s.parentSpanId === null || !bySpanId.has(s.parentSpanId),
    );
    const root = roots[0];
    if (!root) continue;

    // 3. trace 级属性：整组内 langfuse.trace.* 优先，否则取根 span
    const firstDefined = (key: string): unknown => {
      for (const s of spans) {
        const v = s.attrs[key];
        if (v !== undefined && v !== null) return v;
      }
      return undefined;
    };
    const traceName = firstDefined(ATTR.TRACE_NAME);
    const userId =
      firstDefined(ATTR.TRACE_USER_ID) ??
      firstDefined(ATTR.COMPAT_USER_ID) ??
      firstDefined(ATTR.OPENINFERENCE_USER_ID) ??
      firstDefined(ATTR.GEN_AI_USER_ID);
    const sessionId =
      firstDefined(ATTR.TRACE_SESSION_ID) ??
      firstDefined(ATTR.COMPAT_SESSION_ID) ??
      firstDefined(ATTR.OPENINFERENCE_SESSION_ID) ??
      firstDefined(ATTR.GEN_AI_SESSION_ID);
    const traceInput = firstDefined(ATTR.TRACE_INPUT);
    const traceOutput = firstDefined(ATTR.TRACE_OUTPUT);
    const traceMetadata = firstDefined(ATTR.TRACE_METADATA);
    // OpenInference：metadata 为 JSON 字符串（精简键），解码后作为 trace 级 metadata
    const oiMetadata = decodeOtelValue(
      firstDefined(ATTR.OPENINFERENCE_METADATA),
      "application/json",
    );
    const tags = asStringArray(firstDefined(ATTR.TRACE_TAGS));
    const oiTags = asStringArray(firstDefined(ATTR.OPENINFERENCE_TAGS));
    const environment =
      (firstDefined(ATTR.ENVIRONMENT) as string | undefined) ??
      (root.resourceAttrs["deployment.environment"] as string | undefined) ??
      "default";

    const trace: TraceRecord = {
      id: traceId,
      projectId,
      name:
        typeof traceName === "string" && traceName.trim() !== ""
          ? traceName
          : (root.span.name ?? null),
      timestamp: root.startTime,
      environment,
      userId: typeof userId === "string" && userId !== "" ? userId : null,
      sessionId:
        typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
      agentName:
        extractSemanticName(root.attrs, ATTR.GEN_AI_AGENT_NAME) ??
        extractSemanticName(root.attrs, ATTR.OPENINFERENCE_AGENT_NAME) ??
        (firstDefined(ATTR.GEN_AI_AGENT_NAME) as string | null) ??
        (firstDefined(ATTR.OPENINFERENCE_AGENT_NAME) as string | null) ??
        null,
      workflowName:
        extractSemanticName(root.attrs, ATTR.GEN_AI_WORKFLOW_NAME) ??
        (firstDefined(ATTR.GEN_AI_WORKFLOW_NAME) as string | null) ??
        null,
      skillName:
        extractSemanticName(root.attrs, ATTR.GEN_AI_SKILL_NAME) ??
        (firstDefined(ATTR.GEN_AI_SKILL_NAME) as string | null) ??
        null,
      input: traceInput ?? null,
      output: traceOutput ?? null,
      metadata: traceMetadata ?? oiMetadata ?? null,
      tags: tags.length > 0 ? tags : oiTags,
    };
    traces.push(trace);

    // 4. span → observation
    for (const s of spans) {
      const { input, output } = extractIo(s.attrs);
      const usage = extractUsage(s.attrs);
      const level = parseLevel(s.attrs, s.statusCode);
      const obsName =
        (typeof s.attrs[ATTR.GEN_AI_TOOL_NAME] === "string"
          ? (s.attrs[ATTR.GEN_AI_TOOL_NAME] as string)
          : null) ??
        (typeof s.attrs[ATTR.OPENINFERENCE_TOOL_NAME] === "string"
          ? (s.attrs[ATTR.OPENINFERENCE_TOOL_NAME] as string)
          : null) ??
        s.span.name ??
        null;

      observations.push({
        id: s.spanId,
        traceId,
        projectId,
        type: mapObservationType(s.attrs, s.scopeName),
        name: obsName,
        parentObservationId:
          s.parentSpanId && bySpanId.has(s.parentSpanId) ? s.parentSpanId : null,
        startTime: s.startTime,
        endTime: s.endTime,
        model: extractModel(s.attrs),
        agentName:
          extractSemanticName(s.attrs, ATTR.GEN_AI_AGENT_NAME) ??
          extractSemanticName(s.attrs, ATTR.OPENINFERENCE_AGENT_NAME),
        workflowName: extractSemanticName(s.attrs, ATTR.GEN_AI_WORKFLOW_NAME),
        skillName: extractSemanticName(s.attrs, ATTR.GEN_AI_SKILL_NAME),
        input,
        output,
        metadata: buildMetadata(s.attrs, s.resourceAttrs),
        level,
        usage: usage.usage,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        totalCost: usage.totalCost,
      });

      // span events → EVENT observations（挂在该 span 下，时间=事件时间）
      for (let i = 0; i < s.events.length; i++) {
        const ev = s.events[i];
        observations.push({
          id: `${s.spanId}:e${i}`,
          traceId,
          projectId,
          type: "EVENT",
          name: ev.name || null,
          parentObservationId: s.spanId,
          startTime: ev.time,
          endTime: ev.time,
          model: null,
          agentName: null,
          workflowName: null,
          skillName: null,
          input: null,
          output: null,
          metadata: Object.keys(ev.attrs).length > 0 ? ev.attrs : null,
          level: ev.name.toLowerCase().includes("exception") ? "ERROR" : "DEFAULT",
          usage: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          totalCost: null,
        });
      }
    }
  }

  return { traces, observations };
}

// ---------------------------------------------------------------------------
// 落库：先 trace（外键依赖），再 observation；单条失败不中断整批
// ---------------------------------------------------------------------------

export interface OtelProcessResult {
  traces: number;
  observations: number;
  errors: { id: string; message: string }[];
}

export async function persistOtelRecords(
  projectId: string,
  traces: TraceRecord[],
  observations: ObservationRecord[],
): Promise<OtelProcessResult> {
  const errors: { id: string; message: string }[] = [];

  // Prisma.JsonNull 的 drizzle 等价：JSON 字段为 null 时写 SQL NULL（读取语义一致）
  const jsonOrNull = (v: unknown) =>
    (v ?? null) as unknown as typeof trace.$inferInsert["input"];

  for (const t of traces) {
    try {
      await db
        .insert(trace)
        .values({
          id: t.id,
          projectId,
          name: t.name,
          timestamp: t.timestamp,
          environment: t.environment,
          userId: t.userId,
          sessionId: t.sessionId,
          agentName: t.agentName,
          workflowName: t.workflowName,
          skillName: t.skillName,
          input: jsonOrNull(t.input),
          output: jsonOrNull(t.output),
          metadata: jsonOrNull(t.metadata),
          tags: t.tags,
        })
        .onConflictDoUpdate({
          target: trace.id,
          set: {
            name: t.name,
            timestamp: t.timestamp,
            environment: t.environment,
            // 分批导出（如 SimpleSpanProcessor 逐 span POST）时，后续批次的
            // root span 可能没有这些语义属性；null 不覆盖已落库的非空值
            userId: t.userId ?? undefined,
            sessionId: t.sessionId ?? undefined,
            agentName: t.agentName ?? undefined,
            workflowName: t.workflowName ?? undefined,
            skillName: t.skillName ?? undefined,
            input: jsonOrNull(t.input),
            output: jsonOrNull(t.output),
            metadata: jsonOrNull(t.metadata),
            tags: t.tags,
          },
        });
    } catch (e) {
      errors.push({ id: t.id, message: (e as Error).message });
    }
  }

  for (const o of observations) {
    try {
      await db
        .insert(observation)
        .values({
          id: o.id,
          traceId: o.traceId,
          projectId,
          type: o.type,
          name: o.name,
          parentObservationId: o.parentObservationId,
          startTime: o.startTime,
          endTime: o.endTime,
          model: o.model,
          agentName: o.agentName,
          workflowName: o.workflowName,
          skillName: o.skillName,
          input: jsonOrNull(o.input),
          output: jsonOrNull(o.output),
          metadata: jsonOrNull(o.metadata),
          level: o.level,
          usage: jsonOrNull(o.usage),
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          totalTokens: o.totalTokens,
          totalCost: o.totalCost,
        })
        .onConflictDoUpdate({
          target: observation.id,
          set: {
            type: o.type,
            name: o.name,
            parentObservationId: o.parentObservationId,
            startTime: o.startTime,
            endTime: o.endTime,
            model: o.model,
            agentName: o.agentName ?? undefined,
            workflowName: o.workflowName ?? undefined,
            skillName: o.skillName ?? undefined,
            input: jsonOrNull(o.input),
            output: jsonOrNull(o.output),
            metadata: jsonOrNull(o.metadata),
            level: o.level,
            usage: jsonOrNull(o.usage),
            inputTokens: o.inputTokens,
            outputTokens: o.outputTokens,
            totalTokens: o.totalTokens,
            totalCost: o.totalCost,
          },
        });
    } catch (e) {
      errors.push({ id: o.id, message: (e as Error).message });
    }
  }

  return { traces: traces.length, observations: observations.length, errors };
}

/** 端到端入口：解析 + 落库 */
export async function processOtelTraces(
  projectId: string,
  body: unknown,
): Promise<OtelProcessResult> {
  const { traces, observations } = parseOtelPayload(
    projectId,
    body as OtlpExportTraceServiceRequest,
  );
  return persistOtelRecords(projectId, traces, observations);
}
