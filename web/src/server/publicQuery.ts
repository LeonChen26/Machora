// 公开查询 API 公共工具：时间窗 / 游标分页 / 字段选择 / 响应信封
// 对齐 Langfuse 公开 API 风格：{ data, meta: { limit, nextCursor, hasMore, totalCount } }

import { gte, lte, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { observation, score, trace } from "@machora/shared";

export const TRACE_SELECT_FIELDS = [
  "id",
  "projectId",
  "name",
  "timestamp",
  "environment",
  "userId",
  "sessionId",
  "agentName",
  "workflowName",
  "skillName",
  "input",
  "output",
  "metadata",
  "tags",
  "createdAt",
] as const;

export const OBSERVATION_SELECT_FIELDS = [
  "id",
  "traceId",
  "projectId",
  "type",
  "name",
  "parentObservationId",
  "startTime",
  "endTime",
  "model",
  "agentName",
  "workflowName",
  "input",
  "output",
  "metadata",
  "level",
  "usage",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "totalCost",
] as const;

export const SCORE_SELECT_FIELDS = [
  "id",
  "traceId",
  "observationId",
  "projectId",
  "name",
  "value",
  "dataType",
  "source",
  "comment",
  "timestamp",
] as const;

/** 字段白名单 → drizzle 列映射（供 db.select(columns) 动态列选择） */
export const TRACE_COLUMNS = {
  id: trace.id,
  projectId: trace.projectId,
  name: trace.name,
  timestamp: trace.timestamp,
  environment: trace.environment,
  userId: trace.userId,
  sessionId: trace.sessionId,
  agentName: trace.agentName,
  workflowName: trace.workflowName,
  skillName: trace.skillName,
  input: trace.input,
  output: trace.output,
  metadata: trace.metadata,
  tags: trace.tags,
  createdAt: trace.createdAt,
} as const;

export const OBSERVATION_COLUMNS = {
  id: observation.id,
  traceId: observation.traceId,
  projectId: observation.projectId,
  type: observation.type,
  name: observation.name,
  parentObservationId: observation.parentObservationId,
  startTime: observation.startTime,
  endTime: observation.endTime,
  model: observation.model,
  agentName: observation.agentName,
  workflowName: observation.workflowName,
  input: observation.input,
  output: observation.output,
  metadata: observation.metadata,
  level: observation.level,
  usage: observation.usage,
  inputTokens: observation.inputTokens,
  outputTokens: observation.outputTokens,
  totalTokens: observation.totalTokens,
  totalCost: observation.totalCost,
} as const;

export const SCORE_COLUMNS = {
  id: score.id,
  traceId: score.traceId,
  observationId: score.observationId,
  projectId: score.projectId,
  name: score.name,
  value: score.value,
  dataType: score.dataType,
  source: score.source,
  comment: score.comment,
  timestamp: score.timestamp,
} as const;

export interface CommonQuery {
  limit: number;
  cursor?: string;
  from?: Date;
  to?: Date;
  /** 合法字段子集（undefined = 全字段返回） */
  select?: string[];
}

export type ParseResult =
  | { ok: true; value: CommonQuery }
  | { ok: false; error: string };

export function parseCommonQuery(
  sp: URLSearchParams,
  maxLimit = 1000,
): ParseResult {
  const limitRaw = sp.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    return { ok: false, error: `limit must be an integer in [1, ${maxLimit}]` };
  }

  const cursor = sp.get("cursor") || undefined;
  const fromRaw = sp.get("from") || undefined;
  const toRaw = sp.get("to") || undefined;
  if (fromRaw && Number.isNaN(Date.parse(fromRaw))) {
    return { ok: false, error: "from must be an ISO datetime string" };
  }
  if (toRaw && Number.isNaN(Date.parse(toRaw))) {
    return { ok: false, error: "to must be an ISO datetime string" };
  }
  if (fromRaw && toRaw && Date.parse(fromRaw) > Date.parse(toRaw)) {
    return { ok: false, error: "from must not be later than to" };
  }

  const selectRaw = sp.get("select");
  const select = selectRaw
    ? selectRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    ok: true,
    value: {
      limit,
      cursor,
      from: fromRaw ? new Date(fromRaw) : undefined,
      to: toRaw ? new Date(toRaw) : undefined,
      select,
    },
  };
}

/** 字段选择白名单校验：返回合法字段子集；select=undefined 时返回 undefined（全字段） */
export function buildSelect(
  select: string[] | undefined,
  allowed: readonly string[],
): string[] | undefined {
  if (!select) return undefined;
  const unknown = select.filter((f) => !(allowed as readonly string[]).includes(f));
  if (unknown.length > 0) {
    throw new Error(`unknown select field(s): ${unknown.join(", ")}`);
  }
  return select;
}

/**
 * 按字段子集裁剪列映射（供 db.select(columns) 使用）。
 * fields 为 undefined（或空）时返回全字段映射。
 */
export function pickColumns<T extends Record<string, unknown>>(
  columns: T,
  fields: string[] | undefined,
): T {
  if (!fields || fields.length === 0) return columns;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in columns) out[f] = columns[f];
  }
  return out as T;
}

/** 时间窗过滤（from/to 均为可选，未给则不限）返回条件数组 */
export function timeWindow(
  col: AnyPgColumn,
  from?: Date,
  to?: Date,
): SQL<unknown>[] {
  const conds: SQL<unknown>[] = [];
  if (from) conds.push(gte(col, from));
  if (to) conds.push(lte(col, to));
  return conds;
}

export function listEnvelope(
  data: unknown[],
  meta: { limit: number; nextCursor: string | null; totalCount: number },
) {
  return {
    data,
    meta: { ...meta, hasMore: meta.nextCursor !== null },
  };
}
