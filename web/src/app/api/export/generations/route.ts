// 导出 generations 列表为 CSV（复用列表页筛选条件，session 鉴权）
import { NextRequest } from "next/server";
import { and } from "drizzle-orm";
import { db, observation } from "@machora/shared";
import { getApiUser } from "../../../../server/session";
import { getCurrentProjectId } from "../../../../server/project";
import {
  parseGenerationFilters,
  buildGenerationWhere,
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
  const f = parseGenerationFilters(sp);

  const items = await db.query.observation.findMany({
    where: and(...buildGenerationWhere(projectId, f)),
    orderBy: (o, { desc }) => [desc(o.startTime)],
    limit: LIMIT,
    columns: {
      id: true,
      name: true,
      model: true,
      startTime: true,
      endTime: true,
      totalTokens: true,
      totalCost: true,
      level: true,
    },
    with: {
      trace: { columns: { id: true, name: true } },
    },
  });

  const header = [
    "时间",
    "Trace 名称",
    "Trace ID",
    "名称",
    "模型",
    "耗时(ms)",
    "Token",
    "成本",
    "级别",
  ];
  const rows = items.map((o) => [
    o.startTime.toISOString(),
    o.trace.name ?? "",
    o.trace.id,
    o.name ?? "",
    o.model ?? "",
    o.endTime ? String(o.endTime.getTime() - o.startTime.getTime()) : "",
    o.totalTokens ?? "",
    o.totalCost != null ? o.totalCost.toFixed(6) : "",
    o.level,
  ]);

  const csv =
    "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="generations.csv"',
    },
  });
}
