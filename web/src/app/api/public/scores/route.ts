import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, observation, score, trace, ScoreCreateSchema, selfMetrics } from "@machora/shared";
import {
  SCORE_COLUMNS,
  SCORE_SELECT_FIELDS,
  buildSelect,
  countOpenApiQuery,
  cursorCond,
  listEnvelope,
  nextCursorOf,
  omitCursorFields,
  parseCommonQuery,
  pickColumns,
  timeWindow,
  withCursorFields,
} from "../../../../server/publicQuery";

/** 游标必需列：即使未在 select 中请求也要取回，返回前裁掉 */
const CURSOR_FIELDS = ["id", "timestamp"] as const;

// 查询参数（GET）：from&to&traceId&observationId&name&limit&cursor&select
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { limit, cursor, from, to, select } = parsed.value;

  const traceId = sp.get("traceId") || undefined;
  const observationId = sp.get("observationId") || undefined;
  const name = sp.get("name") || undefined;

  const conds: SQL<unknown>[] = [
    ...timeWindow(score.timestamp, from, to),
  ];
  if (traceId) conds.push(eq(score.traceId, traceId));
  if (observationId) conds.push(eq(score.observationId, observationId));
  if (name) conds.push(eq(score.name, name));
  const cursorWhere = cursorCond(score.timestamp, score.id, cursor);
  if (cursorWhere) conds.push(cursorWhere);

  let fields: string[] | undefined;
  try {
    fields = buildSelect(select, SCORE_SELECT_FIELDS);
  } catch (e: any) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: e.message }, { status: 400 });
  }
  const cols = pickColumns(SCORE_COLUMNS, withCursorFields(fields, CURSOR_FIELDS));

  const [items, totalCount] = await Promise.all([
    db
      .select(cols)
      .from(score)
      .where(and(...conds))
      .orderBy(desc(score.timestamp), desc(score.id))
      .limit(limit + 1),
    db.select({ c: count() }).from(score).where(and(...conds)),
  ]);

  const nextCursor = nextCursorOf(items, limit, "timestamp", "id");
  countOpenApiQuery("ok");
  return Response.json(
    listEnvelope(
      items
        .slice(0, limit)
        .map((r) => omitCursorFields(r, fields, CURSOR_FIELDS)),
      {
        limit,
        nextCursor,
        totalCount: totalCount[0].c,
      },
    ),
  );
}

// Annotation 提交（POST）：source 强制 ANNOTATION
export async function POST(req: Request) {
  const AnnotationScoreSchema = ScoreCreateSchema.extend({
    source: ScoreCreateSchema.shape.source.default("ANNOTATION"),
  }).refine((d) => d.traceId ?? d.observationId, {
    message: "traceId or observationId required",
  });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    selfMetrics.inc("machora.scores.requests", 1, { status: "bad-json" });
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AnnotationScoreSchema.safeParse(body);
  if (!parsed.success) {
    selfMetrics.inc("machora.scores.requests", 1, { status: "bad-payload" });
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // 校验：trace/observation 必须存在
  if (d.traceId) {
    const traceRow = await db.query.trace.findFirst({
      where: eq(trace.id, d.traceId),
      columns: { id: true },
    });
    if (!traceRow) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
  }
  if (d.observationId) {
    const obsRow = await db.query.observation.findFirst({
      where: eq(observation.id, d.observationId),
      columns: { id: true },
    });
    if (!obsRow) {
      return Response.json({ error: "Observation not found" }, { status: 404 });
    }
  }

  const [scoreRow] = await db
    .insert(score)
    .values({
      id: d.id ?? undefined,
      traceId: d.traceId ?? null,
      observationId: d.observationId ?? null,
      name: d.name,
      value: d.value,
      dataType: d.dataType,
      source: d.source,
      comment: d.comment ?? null,
    })
    .returning();

  selfMetrics.inc("machora.scores.requests", 1, { status: "ok" });
  return Response.json({ data: scoreRow }, { status: 201 });
}
