// 公开查询 API 公共工具：时间窗 / 游标分页 / 字段选择 / 响应信封
// 对齐 Langfuse 公开 API 风格：{ data, meta: { limit, nextCursor, hasMore, totalCount } }

import { and, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { observation, score, trace, selfMetrics } from "@machora/shared";

/** OpenAPI 查询流量计数（System 自运维折线图"查询"系列）。
 * 仅公开查询端点调用；console 管理接口不埋点，天然不计入。 */
export function countOpenApiQuery(
  status: "ok" | "bad-request" = "ok",
): void {
  selfMetrics.inc("machora.query.requests", 1, { status });
}

export const TRACE_SELECT_FIELDS = [
  "id",
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
  col: AnySQLiteColumn,
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

// ---------------------------------------------------------------------------
// 游标分页（keyset）
//
// 历史缺陷：查询按 timestamp 降序排序，游标却只带 id（`lt(id, cursor)`）。
// id 为随机 UUID（crypto.randomUUID），与时间序无关，因此第 2 页起会漏行 / 重行；
// 且 nextCursor 取的是多取的那条 lookahead 行，每页还会额外跳掉一条。
// 现改为对客户端不透明的复合游标 (timestamp, id)，并以页内最后一条作为游标。
// ---------------------------------------------------------------------------

/** 复合游标：`<epochMs>:<id>`，base64url 编码（对客户端不透明） */
export function encodeCursor(timestamp: Date, id: string): string {
  return Buffer.from(`${timestamp.getTime()}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx <= 0) return null;
    const ts = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(ts) || id === "") return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/**
 * keyset 条件：`ts < cur.ts OR (ts = cur.ts AND id < cur.id)`。
 * 配合 `orderBy(desc(tsCol), desc(idCol))` 使用。非法 / 空游标返回 undefined（等价首页）。
 */
export function cursorCond(
  tsCol: AnySQLiteColumn,
  idCol: AnySQLiteColumn,
  cursor: string | undefined,
): SQL<unknown> | undefined {
  if (!cursor) return undefined;
  const cur = decodeCursor(cursor);
  if (!cur) return undefined;
  const ts = new Date(cur.ts);
  return or(lt(tsCol, ts), and(eq(tsCol, ts), lt(idCol, cur.id)));
}

/** 计算下一页游标：多取一条（limit + 1）时，取「当前页最后一条」的 (timestamp, id) */
export function nextCursorOf<T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  tsKey: string,
  idKey: string,
): string | null {
  if (items.length <= limit) return null;
  const last = items[limit - 1];
  if (!last) return null;
  return encodeCursor(last[tsKey] as Date, String(last[idKey]));
}

/** 在 select 字段中补上游标必需列（即便未在 select 中请求，也要取回用于计算游标） */
export function withCursorFields(
  fields: string[] | undefined,
  required: readonly string[],
): string[] | undefined {
  if (!fields) return undefined;
  return Array.from(new Set([...fields, ...required]));
}

/** 返回前裁掉「仅因游标而追加」的列，不破坏 select 字段选择契约 */
export function omitCursorFields<T extends Record<string, unknown>>(
  row: T,
  requested: string[] | undefined,
  required: readonly string[],
): T {
  if (!requested) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of required) if (!requested.includes(f)) delete out[f];
  return out as T;
}
