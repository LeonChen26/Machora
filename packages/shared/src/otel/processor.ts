// OTLP Span → Machora Trace / Observation 映射处理器
// 语义识别统一走 semantics/（adapter 接入层）：Machora / Langfuse /
// OpenInference / GenAI / LoongSuite 多套语义归一化后由本文件落库。

import {
  ATTR,
  NOISE_PREFIXES,
} from "./attributes.ts";
import {
  MACHORA_ATTR,
  analyzeSpan,
} from "./semantics/index.ts";
import type { AnalyzedSpan } from "./semantics/index.ts";
import {
  decodeAttributes,
  type OtlpExportTraceServiceRequest,
  type OtlpSpan,
} from "./types.ts";
import { db } from "../db.ts";
import { observation, trace } from "../drizzle/schema.ts";

// 类型兼容导出（历史 import 路径）
export type { MachoraObservationType } from "./semantics/types.ts";

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
  type: AnalyzedSpan["type"];
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
// metadata 构建
// ---------------------------------------------------------------------------

// 已提取到专用字段 / 显式剔除的属性键，不再进 metadata
// 语义键需保留在 metadata：虽在 ATTR 中，但无专用列，轨迹视图（推理轨迹）角色分类
// 依赖它们；gen_ai.tool.name 同时已被提取为 observation.name，保留便于分类与审计。
const RETAIN_IN_METADATA = new Set<string>([
  ATTR.GEN_AI_SPAN_KIND,
  ATTR.GEN_AI_OPERATION,
  ATTR.GEN_AI_TOOL_NAME,
  ATTR.GEN_AI_TOOL_CALL_ID,
  MACHORA_ATTR.SPAN_KIND,
  MACHORA_ATTR.OPERATION,
  MACHORA_ATTR.TOOL_NAME,
  MACHORA_ATTR.TOOL_CALL_ID,
]);
const EXTRACTED_KEYS = new Set<string>(
  [
    ...(Object.values(ATTR) as string[]),
    ...(Object.values(MACHORA_ATTR) as string[]),
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
  ].filter((k) => !RETAIN_IN_METADATA.has(k)),
);

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

function nanosToDate(ns: string | number | undefined): Date | null {
  if (ns === undefined || ns === null || ns === "") return null;
  const n = Number(ns);
  if (!Number.isFinite(n)) return null;
  return new Date(n / 1e6);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

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

    // 3. 语义分析：每个 span 归一化一次（trace 级字段取整组内先定义者）
    const analyzed = new Map<FlattenedSpan, AnalyzedSpan>();
    for (const s of spans) {
      analyzed.set(s, analyzeSpan(s.attrs, s.statusCode));
    }
    const firstDefinedSemantic = <K extends keyof AnalyzedSpan>(
      key: K,
    ): AnalyzedSpan[K] | undefined => {
      for (const s of spans) {
        const v = analyzed.get(s)![key];
        if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
          return v;
        }
      }
      return undefined;
    };

    // trace 级属性
    const traceName = firstDefinedSemantic("traceName");
    const userId = firstDefinedSemantic("userId");
    const sessionId = firstDefinedSemantic("sessionId");
    const agentName = firstDefinedSemantic("agentName");
    const workflowName = firstDefinedSemantic("workflowName");
    const skillName = firstDefinedSemantic("skillName");
    const tags = firstDefinedSemantic("tags") ?? [];
    const traceInput = firstDefinedByAttr(spans, ATTR.TRACE_INPUT);
    const traceOutput = firstDefinedByAttr(spans, ATTR.TRACE_OUTPUT);
    const traceMetadata = firstDefinedByAttr(spans, ATTR.TRACE_METADATA);
    const semanticMetadata = firstDefinedSemantic("metadata");
    const environment =
      (firstDefinedByAttr(spans, ATTR.ENVIRONMENT) as string | undefined) ??
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
      agentName: typeof agentName === "string" && agentName !== "" ? agentName : null,
      workflowName:
        typeof workflowName === "string" && workflowName !== "" ? workflowName : null,
      skillName: typeof skillName === "string" && skillName !== "" ? skillName : null,
      input: traceInput ?? null,
      output: traceOutput ?? null,
      metadata: traceMetadata ?? semanticMetadata ?? null,
      tags,
    };
    traces.push(trace);

    // 4. span → observation
    for (const s of spans) {
      const a = analyzed.get(s)!;
      const obsName = a.toolName ?? s.span.name ?? null;

      observations.push({
        id: s.spanId,
        traceId,
        projectId,
        type: a.type,
        name: obsName,
        parentObservationId:
          s.parentSpanId && bySpanId.has(s.parentSpanId) ? s.parentSpanId : null,
        startTime: s.startTime,
        endTime: s.endTime,
        model: a.model,
        agentName: a.agentName,
        workflowName: a.workflowName,
        skillName: a.skillName,
        input: a.input,
        output: a.output,
        metadata: buildMetadata(s.attrs, s.resourceAttrs),
        level: a.level,
        usage: s.attrs[ATTR.OBS_USAGE_DETAILS] ?? null,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        totalTokens: a.totalTokens,
        totalCost: a.totalCost,
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

/** 整组内按属性键取第一个定义值（trace 级专用键，语义层不提取） */
function firstDefinedByAttr(
  spans: FlattenedSpan[],
  key: string,
): unknown {
  for (const s of spans) {
    const v = s.attrs[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
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
