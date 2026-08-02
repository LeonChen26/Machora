import { prisma } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import {
  OBSERVATION_SELECT_FIELDS,
  buildSelect,
  listEnvelope,
  parseCommonQuery,
  timeWindow,
} from "../../../../server/publicQuery";

// GET /api/public/observations?traceId&from&to&type&name&level&model&limit&cursor&select
export async function GET(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { limit, cursor, from, to, select } = parsed.value;

  const traceId = sp.get("traceId") || undefined;
  const type = sp.get("type") || undefined;
  const name = sp.get("name") || undefined;
  const level = sp.get("level") || undefined;
  const model = sp.get("model") || undefined;
  const agent = sp.get("agent") || undefined;
  const workflow = sp.get("workflow") || undefined;
  const skill = sp.get("skill") || undefined;

  const where = {
    projectId: auth.projectId,
    startTime: timeWindow(from, to),
    ...(traceId ? { traceId } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(level ? { level } : {}),
    ...(model ? { model } : {}),
    ...(agent
      ? { agentName: { contains: agent, mode: "insensitive" as const } }
      : {}),
    ...(workflow
      ? { workflowName: { contains: workflow, mode: "insensitive" as const } }
      : {}),
    ...(skill
      ? { skillName: { contains: skill, mode: "insensitive" as const } }
      : {}),
  };

  let prismaSelect;
  try {
    prismaSelect = buildSelect(select, OBSERVATION_SELECT_FIELDS);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  const [items, totalCount] = await Promise.all([
    prisma.observation.findMany({
      where,
      orderBy: { startTime: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
    prisma.observation.count({ where }),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  return Response.json(
    listEnvelope(items.slice(0, limit), { limit, nextCursor, totalCount }),
  );
}
