import { and, count, desc, eq, ilike, lt, type SQL } from "drizzle-orm";
import { db, observation } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import {
  OBSERVATION_COLUMNS,
  OBSERVATION_SELECT_FIELDS,
  buildSelect,
  countOpenApiQuery,
  listEnvelope,
  parseCommonQuery,
  pickColumns,
  timeWindow,
} from "../../../../server/publicQuery";

// GET /api/public/observations?traceId&from&to&type&name&level&model&limit&cursor&select
export async function GET(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    countOpenApiQuery("unauthorized");
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { limit, cursor, from, to, select } = parsed.value;

  const traceId = sp.get("traceId") || undefined;
  const type = sp.get("type") || undefined;
  const name = sp.get("name") || undefined;
  const level = sp.get("level") || undefined;
  const model = sp.get("model") || undefined;
  const agent = sp.get("agent") || undefined;
  const workflow = sp.get("workflow") || undefined;
  const skill = sp.get("skill") || undefined;

  const conds: SQL<unknown>[] = [
    eq(observation.projectId, auth.projectId),
    ...timeWindow(observation.startTime, from, to),
  ];
  if (traceId) conds.push(eq(observation.traceId, traceId));
  if (type) conds.push(eq(observation.type, type));
  if (name) conds.push(eq(observation.name, name));
  if (level) conds.push(eq(observation.level, level));
  if (model) conds.push(eq(observation.model, model));
  if (agent) conds.push(ilike(observation.agentName, `%${agent}%`));
  if (workflow) conds.push(ilike(observation.workflowName, `%${workflow}%`));
  if (skill) conds.push(ilike(observation.skillName, `%${skill}%`));
  if (cursor) conds.push(lt(observation.id, cursor));

  let fields: string[] | undefined;
  try {
    fields = buildSelect(select, OBSERVATION_SELECT_FIELDS);
  } catch (e: any) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: e.message }, { status: 400 });
  }
  const cols = pickColumns(OBSERVATION_COLUMNS, fields);

  const [items, totalCount] = await Promise.all([
    db
      .select(cols)
      .from(observation)
      .where(and(...conds))
      .orderBy(desc(observation.startTime))
      .limit(limit + 1),
    db.select({ c: count() }).from(observation).where(and(...conds)),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  countOpenApiQuery("ok");
  return Response.json(
    listEnvelope(items.slice(0, limit), {
      limit,
      nextCursor,
      totalCount: totalCount[0].c,
    }),
  );
}
