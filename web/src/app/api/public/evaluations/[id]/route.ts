import { eq } from "drizzle-orm";
import { db, evaluation } from "@machora/shared";
import { countOpenApiQuery } from "../../../../../server/publicQuery";

// GET /api/public/evaluations/{id} —— 查询单个评估任务状态与结果
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const evaluationRow = await db.query.evaluation.findFirst({
    where: eq(evaluation.id, id),
  });
  if (!evaluationRow) {
    countOpenApiQuery("ok");
    return Response.json({ error: "Evaluation not found" }, { status: 404 });
  }
  countOpenApiQuery("ok");
  return Response.json({ data: evaluationRow });
}
