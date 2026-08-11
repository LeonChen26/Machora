import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, observation } from "@machora/shared";
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

  const agentCond =
    nameFilter === null ? isNull(observation.agentName) : eq(observation.agentName, nameFilter);

  const gens = (await db.query.observation.findMany({
    where: and(
      eq(observation.projectId, projectId),
      inArray(observation.type, ["LLM", "EMBEDDING"]),
      agentCond,
      gte(observation.startTime, prevSince),
    ),
    orderBy: (t, { desc }) => [desc(t.startTime)],
    limit: PAGE_SIZE,
    with: { trace: true },
  })) as unknown as DrilldownGen[];

  const total = (
    await db
      .select({ c: count() })
      .from(observation)
      .where(
        and(
          eq(observation.projectId, projectId),
          inArray(observation.type, ["LLM", "EMBEDDING"]),
          agentCond,
          gte(observation.startTime, since),
        ),
      )
  )[0].c;

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
