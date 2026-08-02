import { prisma, ScoreCreateSchema } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import {
  SCORE_SELECT_FIELDS,
  buildSelect,
  listEnvelope,
  parseCommonQuery,
  timeWindow,
} from "../../../../server/publicQuery";

// 查询参数（GET）：from&to&traceId&observationId&name&limit&cursor&select
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
  const observationId = sp.get("observationId") || undefined;
  const name = sp.get("name") || undefined;

  const where = {
    projectId: auth.projectId,
    timestamp: timeWindow(from, to),
    ...(traceId ? { traceId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(name ? { name } : {}),
  };

  let prismaSelect;
  try {
    prismaSelect = buildSelect(select, SCORE_SELECT_FIELDS);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  const [items, totalCount] = await Promise.all([
    prisma.score.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    }),
    prisma.score.count({ where }),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  return Response.json(
    listEnvelope(items.slice(0, limit), { limit, nextCursor, totalCount }),
  );
}

// Annotation 提交（POST）：source 强制 ANNOTATION
export async function POST(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const AnnotationScoreSchema = ScoreCreateSchema.extend({
    source: ScoreCreateSchema.shape.source.default("ANNOTATION"),
  }).refine((d) => d.traceId ?? d.observationId, {
    message: "traceId or observationId required",
  });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AnnotationScoreSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // 归属校验：trace/observation 必须属于当前 project
  if (d.traceId) {
    const trace = await prisma.trace.findUnique({
      where: { id: d.traceId },
      select: { id: true },
    });
    if (!trace) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
  }
  if (d.observationId) {
    const obs = await prisma.observation.findUnique({
      where: { id: d.observationId },
      select: { id: true },
    });
    if (!obs) {
      return Response.json({ error: "Observation not found" }, { status: 404 });
    }
  }

  const score = await prisma.score.create({
    data: {
      id: d.id ?? undefined,
      traceId: d.traceId ?? null,
      observationId: d.observationId ?? null,
      projectId: auth.projectId,
      name: d.name,
      value: d.value,
      dataType: d.dataType,
      source: d.source,
      comment: d.comment ?? null,
    },
  });

  return Response.json({ data: score }, { status: 201 });
}
