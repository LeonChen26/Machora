import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, observation, textSearch } from "@machora/shared";
import {
  OBSERVATION_COLUMNS,
  OBSERVATION_SELECT_FIELDS,
  buildSelect,
  countOpenApiQuery,
  cursorCond,
  listEnvelope,
  nextCursorOf,
  omitCursorFields,
  parseCommonQuery,
  pickColumns,
  timeWindow,
  withCursorFields,
} from "../../../../server/publicQuery";

/** 游标必需列：即使未在 select 中请求也要取回，返回前裁掉 */
const CURSOR_FIELDS = ["id", "startTime"] as const;

// GET /api/public/observations?traceId&from&to&type&name&level&model&limit&cursor&select
export async function GET(req: Request) {
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
    ...timeWindow(observation.startTime, from, to),
  ];
  if (traceId) conds.push(eq(observation.traceId, traceId));
  if (type) conds.push(eq(observation.type, type));
  if (name) conds.push(eq(observation.name, name));
  if (level) conds.push(eq(observation.level, level));
  if (model) conds.push(eq(observation.model, model));
  if (agent) conds.push(textSearch(observation.agentName, agent));
  if (workflow) conds.push(textSearch(observation.workflowName, workflow));
  if (skill) conds.push(textSearch(observation.skillName, skill));
  const cursorWhere = cursorCond(observation.startTime, observation.id, cursor);
  if (cursorWhere) conds.push(cursorWhere);

  let fields: string[] | undefined;
  try {
    fields = buildSelect(select, OBSERVATION_SELECT_FIELDS);
  } catch (e: any) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: e.message }, { status: 400 });
  }
  const cols = pickColumns(
    OBSERVATION_COLUMNS,
    withCursorFields(fields, CURSOR_FIELDS),
  );

  const [items, totalCount] = await Promise.all([
    db
      .select(cols)
      .from(observation)
      .where(and(...conds))
      .orderBy(desc(observation.startTime), desc(observation.id))
      .limit(limit + 1),
    db.select({ c: count() }).from(observation).where(and(...conds)),
  ]);

  const nextCursor = nextCursorOf(items, limit, "startTime", "id");
  countOpenApiQuery("ok");
  return Response.json(
    listEnvelope(
      items
        .slice(0, limit)
        .map((r) => omitCursorFields(r, fields, CURSOR_FIELDS)),
      {
        limit,
        nextCursor,
        totalCount: totalCount[0].c,
      },
    ),
  );
}
