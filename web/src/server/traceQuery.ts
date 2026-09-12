// 列表页筛选参数解析与 drizzle where 条件构建（页面与 CSV 导出共用）
// 返回 SQL 条件数组，调用方用 and(...conds) 组装
import { and, eq, exists, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db, observation, trace, textSearch, hasTags } from "@machora/shared";

const str = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

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
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromStr = str(sp.from);
  const toStr = str(sp.to);
  const tagRaw = str(sp.tag)?.trim();
  return {
    from: fromStr ? new Date(fromStr) : from,
    to: toStr ? new Date(toStr) : to,
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

function p95of(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * 当前筛选条件下的全量聚合（不随分页变化）。
 * 口径与 overview.ts 一致：错误率 = ERROR 步骤 / 全部步骤；P95 = 全部步骤 observation 时长。
 */
export async function getTraceFilterStats(
  f: TraceFilters,
): Promise<TraceFilterStats> {
  const where = buildTraceWhere(f);
  const rows = await db
    .select({
      level: observation.level,
      startTime: observation.startTime,
      endTime: observation.endTime,
      totalCost: observation.totalCost,
    })
    .from(observation)
    .innerJoin(trace, eq(observation.traceId, trace.id))
    .where(and(...where));

  let steps = 0;
  let errors = 0;
  let cost = 0;
  const durations: number[] = [];
  for (const r of rows) {
    steps++;
    if (r.level === "ERROR") errors++;
    cost += r.totalCost ?? 0;
    if (r.endTime) {
      durations.push(r.endTime.getTime() - r.startTime.getTime());
    }
  }
  return {
    steps,
    errors,
    errorRate: steps > 0 ? errors / steps : 0,
    cost,
    p95: p95of(durations),
  };
}

export interface GenerationFilters {
  since: Date | null;
  level?: string;
  model?: string;
}

export function parseGenerationFilters(
  sp: Record<string, string | string[] | undefined>,
): GenerationFilters {
  const daysRaw = str(sp.days);
  const days = daysRaw ? Number.parseInt(daysRaw, 10) : 7;
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
