// 内部评分 API（UI 标注用）
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, observation, score, trace, ScoreCreateSchema } from "@machora/shared";

// Annotation 提交：source 强制 ANNOTATION，traceId/observationId 至少一个
const AnnotationScoreSchema = ScoreCreateSchema.extend({
  source: ScoreCreateSchema.shape.source.default("ANNOTATION"),
}).refine((d) => d.traceId ?? d.observationId, {
  message: "traceId or observationId required",
});

export async function POST(req: NextRequest) {
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

  return Response.json({ data: scoreRow }, { status: 201 });
}
