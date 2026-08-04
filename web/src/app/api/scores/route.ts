// 内部评分 API（UI 标注用）：session 鉴权，归属校验到当前项目
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, observation, score, trace, ScoreCreateSchema } from "@machora/shared";
import { getApiUser } from "../../../server/session";
import { getCurrentProjectId } from "../../../server/project";

// Annotation 提交：source 强制 ANNOTATION，traceId/observationId 至少一个
const AnnotationScoreSchema = ScoreCreateSchema.extend({
  source: ScoreCreateSchema.shape.source.default("ANNOTATION"),
}).refine((d) => d.traceId ?? d.observationId, {
  message: "traceId or observationId required",
});

export async function POST(req: NextRequest) {
  if (!(await getApiUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) {
    return Response.json({ error: "No project" }, { status: 400 });
  }

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

  // 归属校验：trace/observation 必须属于当前项目
  if (d.traceId) {
    const traceRow = await db.query.trace.findFirst({
      where: and(eq(trace.id, d.traceId), eq(trace.projectId, projectId)),
      columns: { id: true },
    });
    if (!traceRow) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }
  }
  if (d.observationId) {
    const obsRow = await db.query.observation.findFirst({
      where: and(
        eq(observation.id, d.observationId),
        eq(observation.projectId, projectId),
      ),
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
      projectId,
      name: d.name,
      value: d.value,
      dataType: d.dataType,
      source: d.source,
      comment: d.comment ?? null,
    })
    .returning();

  return Response.json({ data: scoreRow }, { status: 201 });
}
