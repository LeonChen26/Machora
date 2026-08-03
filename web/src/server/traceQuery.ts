// 列表页筛选参数解析与 Prisma where 构建（页面与 CSV 导出共用）
import type { Prisma } from "@prisma/client";

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
): Prisma.TraceWhereInput {
  return {
    projectId,
    timestamp: { gte: f.from, lte: f.to },
    ...(f.q
      ? { name: { contains: f.q, mode: "insensitive" as const } }
      : {}),
    ...(f.userId
      ? { userId: { contains: f.userId, mode: "insensitive" as const } }
      : {}),
    ...(f.sessionId
      ? { sessionId: { contains: f.sessionId, mode: "insensitive" as const } }
      : {}),
    ...(f.model
      ? {
          observations: {
            some: { model: { contains: f.model, mode: "insensitive" as const } },
          },
        }
      : {}),
    ...(f.level ? { observations: { some: { level: f.level } } } : {}),
    ...(f.env ? { environment: f.env } : {}),
    ...(f.agent
      ? { agentName: { contains: f.agent, mode: "insensitive" as const } }
      : {}),
    ...(f.tags.length > 0 ? { tags: { hasEvery: f.tags } } : {}),
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

export function buildGenerationWhere(
  projectId: string,
  f: GenerationFilters,
): Prisma.ObservationWhereInput {
  return {
    projectId,
    type: "GENERATION" as const,
    ...(f.since ? { startTime: { gte: f.since } } : {}),
    ...(f.level ? { level: f.level } : {}),
    ...(f.model
      ? { model: { contains: f.model, mode: "insensitive" as const } }
      : {}),
  };
}
