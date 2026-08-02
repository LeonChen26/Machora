// 公开查询 API 公共工具：时间窗 / 游标分页 / 字段选择 / 响应信封
// 对齐 Langfuse 公开 API 风格：{ data, meta: { limit, nextCursor, hasMore, totalCount } }

import { Prisma } from "@prisma/client";

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

/** 字段选择白名单校验：返回 Prisma select 子句；select=undefined 时返回 undefined（全字段） */
export function buildSelect(
  select: string[] | undefined,
  allowed: readonly string[],
): Prisma.TraceSelect | Prisma.ObservationSelect | Prisma.ScoreSelect | undefined {
  if (!select) return undefined;
  const unknown = select.filter((f) => !(allowed as readonly string[]).includes(f));
  if (unknown.length > 0) {
    throw new Error(`unknown select field(s): ${unknown.join(", ")}`);
  }
  const obj: Record<string, true> = {};
  for (const f of select) obj[f] = true;
  return obj as Prisma.TraceSelect;
}

/** 时间窗过滤（from/to 均为可选，未给则不限） */
export function timeWindow(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { gte: from, lte: to };
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
