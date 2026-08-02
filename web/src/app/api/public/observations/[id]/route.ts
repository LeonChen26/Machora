import { prisma } from "@machora/shared";
import { verifyApiKey } from "../../../../../server/auth";

// GET /api/public/observations/{id}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const { id } = await params;

  const observation = await prisma.observation.findUnique({ where: { id } });
  if (!observation || observation.projectId !== auth.projectId) {
    return Response.json({ error: "Observation not found" }, { status: 404 });
  }
  return Response.json({ data: observation });
}
