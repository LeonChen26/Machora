import { prisma } from "@machora/shared";
import { verifyApiKey } from "../../../../../server/auth";

// GET /api/public/evaluations/{id} —— 查询单个评估任务状态与结果
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const { id } = await params;

  const evaluation = await prisma.evaluation.findUnique({ where: { id } });
  if (!evaluation || evaluation.projectId !== auth.projectId) {
    return Response.json({ error: "Evaluation not found" }, { status: 404 });
  }
  return Response.json({ data: evaluation });
}
