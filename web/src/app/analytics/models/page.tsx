import { redirect } from "next/navigation";
import { prisma } from "@machora/shared";
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

  const gens = (await prisma.observation.findMany({
    where: {
      projectId,
      type: "GENERATION",
      model,
      startTime: { gte: prevSince },
    },
    orderBy: { startTime: "desc" },
    take: PAGE_SIZE,
    include: { trace: { select: { name: true } } },
  })) as DrilldownGen[];

  const total = await prisma.observation.count({
    where: { projectId, type: "GENERATION", model, startTime: { gte: since } },
  });

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
