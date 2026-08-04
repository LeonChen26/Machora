import { eq } from "drizzle-orm";
import { db, trace as traceTable } from "@machora/shared";
import { verifyApiKey } from "../../../../../server/auth";

// GET /api/public/traces/{id}
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const { id } = await params;

  const trace = await db.query.trace.findFirst({
    where: eq(traceTable.id, id),
    with: { observations: true, scores: true },
  });
  if (!trace || trace.projectId !== auth.projectId) {
    return Response.json({ error: "Trace not found" }, { status: 404 });
  }
  return Response.json({ data: trace });
}
