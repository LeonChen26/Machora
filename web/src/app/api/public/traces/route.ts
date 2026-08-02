import { prisma } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import {
  TRACE_SELECT_FIELDS,
  buildSelect,
  listEnvelope,
  parseCommonQuery,
  timeWindow,
} from "../../../../server/publicQuery";

// GET /api/public/traces?from&to&name&userId&sessionId&tags&limit&cursor&select
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

  const name = sp.get("name") || undefined;
  const userId = sp.get("userId") || undefined;
  const sessionId = sp.get("sessionId") || undefined;
  const agent = sp.get("agent") || undefined;
  const workflow = sp.get("workflow") || undefined;
  const skill = sp.get("skill") || undefined;
  const tags = sp.get("tags")
    ? sp.get("tags")!.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  const where = {
    projectId: auth.projectId,
    timestamp: timeWindow(from, to),
    ...(name ? { name } : {}),
    ...(userId ? { userId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agent
      ? { agentName: { contains: agent, mode: "insensitive" as const } }
      : {}),
    ...(workflow
      ? { workflowName: { contains: workflow, mode: "insensitive" as const } }
      : {}),
    ...(skill
      ? { skillName: { contains: skill, mode: "insensitive" as const } }
      : {}),
    ...(tags && tags.length > 0 ? { tags: { hasEvery: tags } } : {}),
  };

  let prismaSelect;
  try {
    prismaSelect = buildSelect(select, TRACE_SELECT_FIELDS);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  const [items, totalCount] = await Promise.all([
    prisma.trace.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
    prisma.trace.count({ where }),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  return Response.json(
    listEnvelope(items.slice(0, limit), { limit, nextCursor, totalCount }),
  );
}
