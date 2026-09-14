// 列表页筛选参数解析与 drizzle where 条件构建（页面与 CSV 导出共用）
// 返回 SQL 条件数组，调用方用 and(...conds) 组装
import { and, count, eq, exists, gte, inArray, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { db, observation, trace, textSearch, hasTags } from "@machora/shared";

const str = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

/** 解析单个日期参数：非法输入回退默认值（避免 Invalid Date → 绑定 NaN → 查询恒空且无提示） */
function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? fallback : new Date(t);
}

/** 时间窗天数：空 / 非法 → fallback；0 = 不限；上限 365 防超大窗口 */
export function parseDays(
  raw: string | string[] | undefined,
  fallback = 7,
): number {
  const s = str(raw);
  if (s === undefined || s.trim() === "") return fallback;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 365);
}

export interface TraceFilters {
  from: Date;
  to: Date;
  q?: string;
  userId?: string;
  sessionId?: string;
  model?: string;
  tags: string[];
  level?: string;
  env?: string;
  agent?: string;
}

export function parseTraceFilters(
  sp: Record<string, string | string[] | undefined>,
): TraceFilters {
  // 默认时间窗：最近 7 天
  const now = new Date();
  const fromStr = str(sp.from);
  const toStr = str(sp.to);
  const tagRaw = str(sp.tag)?.trim();
  const to = parseDate(toStr, now);
  let from = parseDate(fromStr, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  // 起止倒置时收敛为同一时刻，避免 gte/lte 互斥导致列表恒空
  if (from.getTime() > to.getTime()) from = to;
  return {
    from,
    to,
    q: str(sp.q)?.trim(),
    userId: str(sp.user)?.trim(),
    sessionId: str(sp.session)?.trim(),
    model: str(sp.model)?.trim(),
    tags: tagRaw
      ? tagRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    level: str(sp.level)?.trim(),
    env: str(sp.env)?.trim(),
    agent: str(sp.agent)?.trim(),
  };
}

export function buildTraceWhere(f: TraceFilters): SQL<unknown>[] {
  const conds: SQL<unknown>[] = [
    gte(trace.timestamp, f.from),
    lte(trace.timestamp, f.to),
  ];
  if (f.q) conds.push(textSearch(trace.name, f.q));
  if (f.userId) conds.push(textSearch(trace.userId, f.userId));
  if (f.sessionId) conds.push(textSearch(trace.sessionId, f.sessionId));
  if (f.model) {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(observation)
          .where(
            and(
              eq(observation.traceId, trace.id),
              textSearch(observation.model, f.model),
            ),
          ),
      ),
    );
  }
  if (f.level) {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(observation)
          .where(
            and(eq(observation.traceId, trace.id), eq(observation.level, f.level)),
          ),
      ),
    );
  }
  if (f.env) conds.push(eq(trace.environment, f.env));
  if (f.agent) conds.push(textSearch(trace.agentName, f.agent));
  if (f.tags.length > 0) conds.push(hasTags(trace.tags, f.tags));
  return conds;
}

export interface TraceFilterStats {
  /** 步骤数（observation 条数） */
  steps: number;
  /** ERROR 步骤数 */
  errors: number;
  /** 步骤级错误率 = ERROR 步骤 / 全部步骤 */
  errorRate: number;
  /** 成本合计 */
  cost: number;
  /** 步骤耗时 P95 */
  p95: number | null;
}

/**
 * 当前筛选条件下的全量聚合（不随分页变化）。
 * 口径与 overview.ts 一致：错误率 = ERROR 步骤 / 全部步骤；P95 = 全部步骤 observation 时长。
 *
 * 聚合下推：只回传 1 行标量 + 1 个 P95 值，不再把命中行全量拉到 JS 再聚合——
 * better-sqlite3 是同步驱动，全量拉取会在扫描与循环期间长时间独占事件循环。
 * P95 = 时长升序第 `min(n-1, floor(n*0.95))` 条（n 为有 endTime 的步骤数），
 * 与原 JS 实现 sorted[Math.min(len-1, floor(len*0.95))] 一致。
 */
export async function getTraceFilterStats(
  f: TraceFilters,
): Promise<TraceFilterStats> {
  const where = and(...buildTraceWhere(f));
  const [scalar] = await db
    .select({
      steps: count(),
      errors: sql<number>`coalesce(sum(case when ${observation.level} = 'ERROR' then 1 else 0 end), 0)`,
      cost: sql<number>`coalesce(sum(${observation.totalCost}), 0)`,
      timed: sql<number>`coalesce(sum(case when ${observation.endTime} is not null then 1 else 0 end), 0)`,
    })
    .from(observation)
    .innerJoin(trace, eq(observation.traceId, trace.id))
    .where(where);

  const steps = Number(scalar?.steps ?? 0);
  const errors = Number(scalar?.errors ?? 0);
  const timed = Number(scalar?.timed ?? 0);

  return {
    steps,
    errors,
    errorRate: steps > 0 ? errors / steps : 0,
    cost: Number(scalar?.cost ?? 0),
    p95: await sqlP95(where, timed),
  };
}

/** observation 时长（ms）升序第 floor(n*0.95) 条；n 为有 endTime 的步骤数 */
async function sqlP95(
  where: SQL<unknown> | undefined,
  n: number,
): Promise<number | null> {
  if (n <= 0) return null;
  const offset = Math.min(n - 1, Math.floor(n * 0.95));
  const dur = sql<number>`(${observation.endTime} - ${observation.startTime})`;
  const [row] = await db
    .select({ dur })
    .from(observation)
    .innerJoin(trace, eq(observation.traceId, trace.id))
    .where(and(where, isNotNull(observation.endTime)))
    .orderBy(dur)
    .limit(1)
    .offset(offset);
  return row?.dur ?? null;
}

export interface GenerationFilters {
  since: Date | null;
  level?: string;
  model?: string;
}

export function parseGenerationFilters(
  sp: Record<string, string | string[] | undefined>,
): GenerationFilters {
  const days = parseDays(sp.days, 7);
  return {
    since: days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null,
    level: str(sp.level)?.trim(),
    model: str(sp.model)?.trim(),
  };
}

export function buildGenerationWhere(f: GenerationFilters): SQL<unknown>[] {
  const conds: SQL<unknown>[] = [
    // 模型调用 = LLM / EMBEDDING（type 与 span.kind 一致）
    inArray(observation.type, ["LLM", "EMBEDDING"]),
  ];
  if (f.since) conds.push(gte(observation.startTime, f.since));
  if (f.level) conds.push(eq(observation.level, f.level));
  if (f.model) conds.push(textSearch(observation.model, f.model));
  return conds;
}
