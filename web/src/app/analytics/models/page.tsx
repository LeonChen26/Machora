import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { db, observation } from "@machora/shared";
import { getCurrentProjectId } from "../../../server/project";
import { requireUser } from "../../../server/session";
import { DrilldownView, type DrilldownGen } from "../../../components/DrilldownPage";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30];
const PAGE_SIZE = 50;

export default async function ModelDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const model = (str(sp.model) ?? "").trim();
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;
  if (!model) redirect("/analytics");

  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  const gens = (await db.query.observation.findMany({
    where: and(
      eq(observation.projectId, projectId),
      inArray(observation.type, ["LLM", "EMBEDDING"]),
      eq(observation.model, model),
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
          eq(observation.model, model),
          gte(observation.startTime, since),
        ),
      )
  )[0].c;

  return (
    <DrilldownView
      value={model}
      badgeClass="purple"
      crumbLabel={model}
      entityLabel="模型"
      days={days}
      dayOptions={DAY_OPTIONS}
      basePath="/analytics/models"
      paramKey="model"
      allGens={gens}
      since={since}
      total={total}
    />
  );
}
