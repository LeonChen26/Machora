// 导出 traces 列表为 CSV（复用列表页筛选条件，session 鉴权）
import { NextRequest } from "next/server";
import { prisma } from "@machora/shared";
import { getApiUser } from "../../../../server/session";
import { getCurrentProjectId } from "../../../../server/project";
import {
  parseTraceFilters,
  buildTraceWhere,
} from "../../../../server/traceQuery";

const LIMIT = 10_000;

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const user = await getApiUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const projectId = await getCurrentProjectId();

  const sp: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of req.nextUrl.searchParams) sp[k] = v;
  const f = parseTraceFilters(sp);

  const items = await prisma.trace.findMany({
    where: buildTraceWhere(projectId, f),
    orderBy: { timestamp: "desc" },
    take: LIMIT,
    include: {
      observations: {
        select: {
          model: true,
          type: true,
          level: true,
          startTime: true,
          endTime: true,
          totalTokens: true,
          totalCost: true,
        },
        orderBy: { startTime: "asc" },
      },
      scores: {
        select: { name: true, value: true, dataType: true },
        orderBy: { timestamp: "desc" },
        take: 3,
      },
      _count: { select: { observations: true, scores: true } },
    },
  });

  const header = [
    "名称",
    "Trace ID",
    "时间",
    "Agent",
    "用户",
    "会话",
    "模型",
    "耗时(ms)",
    "Token",
    "成本",
    "Obs",
    "Score",
    "环境",
    "级别",
  ];
  const rows = items.map((t) => {
    const models = Array.from(
      new Set(t.observations.map((o) => o.model).filter(Boolean) as string[]),
    ).join("|");
    const latency = t.observations.find(
      (o) => o.type === "GENERATION" && o.endTime,
    );
    const latencyMs = latency?.endTime
      ? latency.endTime.getTime() - latency.startTime.getTime()
      : null;
    const tokens = t.observations.reduce((s, o) => s + (o.totalTokens ?? 0), 0);
    const cost = t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    const level = t.observations.some((o) => o.level === "ERROR")
      ? "ERROR"
      : t.observations.some((o) => o.level === "WARNING")
        ? "WARNING"
        : "";
    const scores = t.scores
      .map((s) => (s.dataType === "NUMERIC" ? `${s.name}=${s.value}` : s.name))
      .join("|");
    return [
      t.name ?? "",
      t.id,
      t.timestamp.toISOString(),
      t.agentName ?? "",
      t.userId ?? "",
      t.sessionId ?? "",
      models,
      latencyMs ?? "",
      tokens || "",
      cost ? cost.toFixed(6) : "",
      t._count.observations,
      scores,
      t.environment ?? "",
      level,
    ];
  });

  const csv =
    "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="traces.csv"',
    },
  });
}
