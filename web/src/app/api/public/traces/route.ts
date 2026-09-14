import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db, trace, textSearch, hasTags } from "@machora/shared";
import {
  TRACE_COLUMNS,
  TRACE_SELECT_FIELDS,
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
const CURSOR_FIELDS = ["id", "timestamp"] as const;

// GET /api/public/traces?from&to&name&userId&sessionId&tags&limit&cursor&select
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    countOpenApiQuery("bad-request");
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

  const baseConds: SQL<unknown>[] = [...timeWindow(trace.timestamp, from, to)];
  if (name) baseConds.push(eq(trace.name, name));
  if (userId) baseConds.push(eq(trace.userId, userId));
  if (sessionId) baseConds.push(eq(trace.sessionId, sessionId));
  if (agent) baseConds.push(textSearch(trace.agentName, agent));
  if (workflow) baseConds.push(textSearch(trace.workflowName, workflow));
  if (skill) baseConds.push(textSearch(trace.skillName, skill));
  if (tags && tags.length > 0) baseConds.push(hasTags(trace.tags, tags));
  // 游标只用于取本页数据，不计入 totalCount（否则逐页递减）
  const cursorWhere = cursorCond(trace.timestamp, trace.id, cursor);
  const conds = cursorWhere ? [...baseConds, cursorWhere] : baseConds;

  let fields: string[] | undefined;
  try {
    fields = buildSelect(select, TRACE_SELECT_FIELDS);
  } catch (e: any) {
    countOpenApiQuery("bad-request");
    return Response.json({ error: e.message }, { status: 400 });
  }
  const cols = pickColumns(TRACE_COLUMNS, withCursorFields(fields, CURSOR_FIELDS));

  const [items, totalCount] = await Promise.all([
    db
      .select(cols)
      .from(trace)
      .where(and(...conds))
      // keyset 分页必须含 id 作为次序键（timestamp 可能重复）
      .orderBy(desc(trace.timestamp), desc(trace.id))
      .limit(limit + 1),
    db.select({ c: count() }).from(trace).where(and(...baseConds)),
  ]);

  const nextCursor = nextCursorOf(items, limit, "timestamp", "id");
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
