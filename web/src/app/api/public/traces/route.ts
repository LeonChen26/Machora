import { and, arrayContains, count, desc, eq, ilike, lt, type SQL } from "drizzle-orm";
import { db, trace } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import {
  TRACE_COLUMNS,
  TRACE_SELECT_FIELDS,
  buildSelect,
  listEnvelope,
  parseCommonQuery,
  pickColumns,
  timeWindow,
} from "../../../../server/publicQuery";

// GET /api/public/traces?from&to&name&userId&sessionId&tags&limit&cursor&select
export async function GET(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { limit, cursor, from, to, select } = parsed.value;

  const name = sp.get("name") || undefined;
  const userId = sp.get("userId") || undefined;
  const sessionId = sp.get("sessionId") || undefined;
  const agent = sp.get("agent") || undefined;
  const workflow = sp.get("workflow") || undefined;
  const skill = sp.get("skill") || undefined;
  const tags = sp.get("tags")
    ? sp.get("tags")!.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  const conds: SQL<unknown>[] = [
    eq(trace.projectId, auth.projectId),
    ...timeWindow(trace.timestamp, from, to),
  ];
  if (name) conds.push(eq(trace.name, name));
  if (userId) conds.push(eq(trace.userId, userId));
  if (sessionId) conds.push(eq(trace.sessionId, sessionId));
  if (agent) conds.push(ilike(trace.agentName, `%${agent}%`));
  if (workflow) conds.push(ilike(trace.workflowName, `%${workflow}%`));
  if (skill) conds.push(ilike(trace.skillName, `%${skill}%`));
  if (tags && tags.length > 0) conds.push(arrayContains(trace.tags, tags));
  if (cursor) conds.push(lt(trace.id, cursor));

  let fields: string[] | undefined;
  try {
    fields = buildSelect(select, TRACE_SELECT_FIELDS);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }
  const cols = pickColumns(TRACE_COLUMNS, fields);

  const [items, totalCount] = await Promise.all([
    db
      .select(cols)
      .from(trace)
      .where(and(...conds))
      .orderBy(desc(trace.timestamp))
      .limit(limit + 1),
    db.select({ c: count() }).from(trace).where(and(...conds)),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  return Response.json(
    listEnvelope(items.slice(0, limit), {
      limit,
      nextCursor,
      totalCount: totalCount[0].c,
    }),
  );
}
