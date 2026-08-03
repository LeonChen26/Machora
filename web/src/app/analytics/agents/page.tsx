import { redirect } from "next/navigation";
import { prisma } from "@machora/shared";
import { getCurrentProjectId } from "../../../server/project";
import { requireUser } from "../../../server/session";
import { DrilldownView, type DrilldownGen } from "../../../components/DrilldownPage";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30];
const PAGE_SIZE = 50;
const UNKNOWN = "unknown";

export default async function AgentDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const agent = (str(sp.name) ?? "").trim();
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;
  if (!agent) redirect("/analytics");

  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  // analytics 汇总表中 agentName 空值归 "unknown"，此处还原为 null 查询
  const nameFilter = agent === UNKNOWN ? null : agent;

  const gens = (await prisma.observation.findMany({
    where: {
      projectId,
      type: "GENERATION",
      agentName: nameFilter,
      startTime: { gte: prevSince },
    },
    orderBy: { startTime: "desc" },
    take: PAGE_SIZE,
    include: { trace: { select: { name: true } } },
  })) as DrilldownGen[];

  const total = await prisma.observation.count({
    where: {
      projectId,
      type: "GENERATION",
      agentName: nameFilter,
      startTime: { gte: since },
    },
  });

  return (
    <DrilldownView
      value={agent}
      badgeClass="green"
      crumbLabel="agents"
      entityLabel="agent"
      days={days}
      dayOptions={DAY_OPTIONS}
      basePath="/analytics/agents"
      paramKey="name"
      allGens={gens}
      since={since}
      total={total}
    />
  );
}
