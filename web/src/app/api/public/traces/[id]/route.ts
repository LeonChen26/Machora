import { eq } from "drizzle-orm";
import { db, trace as traceTable } from "@machora/shared";
import { countOpenApiQuery } from "../../../../../server/publicQuery";

// GET /api/public/traces/{id}
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const trace = await db.query.trace.findFirst({
    where: eq(traceTable.id, id),
    with: { observations: true, scores: true },
  });
  if (!trace) {
    countOpenApiQuery("ok");
    return Response.json({ error: "Trace not found" }, { status: 404 });
  }
  countOpenApiQuery("ok");
  return Response.json({ data: trace });
}
