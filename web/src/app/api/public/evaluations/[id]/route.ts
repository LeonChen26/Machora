import { eq } from "drizzle-orm";
import { db, evaluation } from "@machora/shared";
import { verifyApiKey } from "../../../../../server/auth";
import { countOpenApiQuery } from "../../../../../server/publicQuery";

// GET /api/public/evaluations/{id} —— 查询单个评估任务状态与结果
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    countOpenApiQuery("unauthorized");
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const { id } = await params;

  const evaluationRow = await db.query.evaluation.findFirst({
    where: eq(evaluation.id, id),
  });
  if (!evaluationRow || evaluationRow.projectId !== auth.projectId) {
    countOpenApiQuery("ok");
    return Response.json({ error: "Evaluation not found" }, { status: 404 });
  }
  countOpenApiQuery("ok");
  return Response.json({ data: evaluationRow });
}
