import { eq } from "drizzle-orm";
import { db, observation as observationTable } from "@machora/shared";
import { countOpenApiQuery } from "../../../../../server/publicQuery";

// GET /api/public/observations/{id}
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const observation = await db.query.observation.findFirst({
    where: eq(observationTable.id, id),
  });
  if (!observation) {
    countOpenApiQuery("ok");
    return Response.json({ error: "Observation not found" }, { status: 404 });
  }
  countOpenApiQuery("ok");
  return Response.json({ data: observation });
}
