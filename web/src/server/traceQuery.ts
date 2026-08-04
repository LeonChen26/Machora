// 列表页筛选参数解析与 drizzle where 条件构建（页面与 CSV 导出共用）
// 返回 SQL 条件数组，调用方用 and(...conds) 组装
import { and, arrayContains, eq, exists, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import { db, observation, trace } from "@machora/shared";

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

export function buildTraceWhere(
  projectId: string,
  f: TraceFilters,
): SQL<unknown>[] {
  const conds: SQL<unknown>[] = [
    eq(trace.projectId, projectId),
    gte(trace.timestamp, f.from),
    lte(trace.timestamp, f.to),
  ];
  if (f.q) conds.push(ilike(trace.name, `%${f.q}%`));
  if (f.userId) conds.push(ilike(trace.userId, `%${f.userId}%`));
  if (f.sessionId) conds.push(ilike(trace.sessionId, `%${f.sessionId}%`));
  if (f.model) {
    conds.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(observation)
          .where(
            and(
              eq(observation.traceId, trace.id),
              ilike(observation.model, `%${f.model}%`),
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
  if (f.agent) conds.push(ilike(trace.agentName, `%${f.agent}%`));
  if (f.tags.length > 0) conds.push(arrayContains(trace.tags, f.tags));
  return conds;
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

export function buildGenerationWhere(
  projectId: string,
  f: GenerationFilters,
): SQL<unknown>[] {
  const conds: SQL<unknown>[] = [
    eq(observation.projectId, projectId),
    eq(observation.type, "GENERATION"),
  ];
  if (f.since) conds.push(gte(observation.startTime, f.since));
  if (f.level) conds.push(eq(observation.level, f.level));
  if (f.model) conds.push(ilike(observation.model, `%${f.model}%`));
  return conds;
}
