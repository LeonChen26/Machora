import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Pager } from "../../components/Pager";
import { and, asc, count, desc, eq, exists, inArray, sql } from "drizzle-orm";
import { db, trace, observation, score } from "@machora/shared";
import type { ReactNode } from "react";
import {
  formatRelative,
  formatDateTime,
  formatTokens,
  formatCost,
} from "../../lib/format";
import {
  parseTraceFilters,
  buildTraceWhere,
} from "../../server/traceQuery";
import { getTraceSignalMap } from "../../server/signals";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const f = parseTraceFilters(sp);
  const { from, to } = f;
  const { q, userId, sessionId, model, tags, level, env, agent } = f;
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  // 排序：time / cost / latency / token。
  // 排序键是 trace 级聚合值，必须下推到 SQL 对「全量结果」排序后再取当前页，
  // 否则只排当前页会出错（例如第 2 页出现比第 1 页更大的成本）。
  const sortKey = str(sp.sort)?.trim() || "time";
  const sortDir = str(sp.dir) === "asc" ? "asc" : "desc";
  // 耗时口径 = trace 总跨度（max(endTime ?? startTime) − min(startTime)），
  // 与 Trace 详情页「总跨度」一致，不再是「首个 generation 的耗时」。
  const spanExpr = sql`(max(coalesce(${observation.endTime}, ${observation.startTime})) - min(${observation.startTime}))`;
  const sortExpr =
    sortKey === "cost"
      ? sql`coalesce(sum(${observation.totalCost}), 0)`
      : sortKey === "token"
        ? sql`coalesce(sum(${observation.totalTokens}), 0)`
        : sortKey === "latency"
          ? spanExpr
          : null;

  const where = buildTraceWhere(f);

  // 环境下拉选项
  const envs = await db
    .selectDistinct({ environment: trace.environment })
    .from(trace)
    .orderBy(asc(trace.environment));

  // 非时间排序：先在全量结果上按聚合排序键分页，拿到有序的 trace id 列表
  let pageIds: string[] | null = null;
  if (sortExpr) {
    const keyRows = await db
      .select({ id: trace.id })
      .from(trace)
      .leftJoin(observation, eq(observation.traceId, trace.id))
      .where(and(...where))
      .groupBy(trace.id)
      .orderBy(
        sql`${sortExpr} is null`,
        sortDir === "asc" ? asc(sortExpr) : desc(sortExpr),
      )
      .offset((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE);
    pageIds = keyRows.map((r) => r.id);
  }

  const emptyPage = pageIds !== null && pageIds.length === 0;

  const rows = emptyPage
    ? []
    : await db.query.trace.findMany({
        where: and(...where, ...(pageIds ? [inArray(trace.id, pageIds)] : [])),
        // 固定按时间序取行；pageIds 路径随后会按聚合排序键重排
        orderBy: (t, { desc }) => [desc(t.timestamp)],
        ...(pageIds ? {} : { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        with: {
          observations: {
            columns: {
              model: true,
              type: true,
              level: true,
              startTime: true,
              endTime: true,
              totalTokens: true,
              totalCost: true,
            },
            orderBy: (o, { asc }) => [asc(o.startTime)],
          },
          scores: {
            columns: { id: true, name: true, value: true, dataType: true },
            orderBy: (s, { desc }) => [desc(s.timestamp)],
            limit: 3,
          },
        },
      });

  // _count：与 Prisma include._count 等价的两条聚合查询
  const ids = rows.map((r) => r.id);
  const [obsCounts, scoreCounts, signalMap] = await Promise.all([
    ids.length > 0
      ? db
          .select({ traceId: observation.traceId, c: count() })
          .from(observation)
          .where(inArray(observation.traceId, ids))
          .groupBy(observation.traceId)
      : Promise.resolve([]),
    ids.length > 0
      ? db
          .select({ traceId: score.traceId, c: count() })
          .from(score)
          .where(inArray(score.traceId, ids))
          .groupBy(score.traceId)
      : Promise.resolve([]),
    getTraceSignalMap(ids),
  ]);
  const obsCountMap = new Map(obsCounts.map((r) => [r.traceId, r.c]));
  const scoreCountMap = new Map(scoreCounts.map((r) => [r.traceId, r.c]));
  const items = rows.map((r) => ({
    ...r,
    _count: {
      observations: obsCountMap.get(r.id) ?? 0,
      scores: scoreCountMap.get(r.id) ?? 0,
    },
  }));

  const total = (
    await db
      .select({ c: count() })
      .from(trace)
      .where(and(...where))
  )[0].c;
  // 健康摘要：当前筛选条件下含 ERROR observation 的 trace 数
  const errorTotal = (
    await db
      .select({ c: count() })
      .from(trace)
      .where(and(
        ...where,
        exists(
          db
            .select({ x: sql`1` })
            .from(observation)
            .where(
              and(
                eq(observation.traceId, trace.id),
                eq(observation.level, "ERROR"),
              ),
            ),
        ),
      ))
  )[0]?.c ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // pageIds 路径已按聚合排序键在「全量结果」上排好序，按其顺序重排展示行
  const byId = new Map(items.map((it) => [it.id, it]));
  const shown = pageIds
    ? pageIds
        .map((id) => byId.get(id))
        .filter((it): it is (typeof items)[number] => it != null)
    : items;
  // 表头排序链接
  function sortHref(key: string): string {
    const nextDir =
      sortKey === key ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    return `/traces?${buildQuery({
      from,
      to,
      q,
      userId,
      sessionId,
      model,
      tags,
      level,
      env,
      agent,
      sort: key,
      dir: nextDir,
      page: 1,
    })}`;
  }
  function sortTh(label: string, sortFor: string, title?: string): ReactNode {
    const active = sortKey === sortFor;
    return (
      <th scope="col" title={title}>
        <Link
          href={sortHref(sortFor)}
          prefetch={false}
          className="sort-th"
          style={{
            color: active ? "var(--accent)" : "inherit",
            fontWeight: active ? 600 : 500,
          }}
        >
          {label}{" "}
          {active ? (sortDir === "desc" ? "↓" : "↑") : <span className="sort-hint">↕</span>}
        </Link>
      </th>
    );
  }

  // 快捷时间窗：当前 from/to 落在预设区间（±10min）内时高亮
  const RANGES: { key: string; label: string; ms: number }[] = [
    { key: "1h", label: "近 1 小时", ms: 60 * 60 * 1000 },
    { key: "24h", label: "近 24 小时", ms: 24 * 60 * 60 * 1000 },
    { key: "7d", label: "近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
    { key: "30d", label: "近 30 天", ms: 30 * 24 * 60 * 60 * 1000 },
  ];
  const isRange = (fromD: Date, toD: Date, ms: number): boolean => {
    const now = Date.now();
    return (
      Math.abs(toD.getTime() - now) < 10 * 60 * 1000 &&
      Math.abs(fromD.getTime() - (now - ms)) < 10 * 60 * 1000
    );
  };
  const activeRange = RANGES.find((r) => isRange(from, to, r.ms));

  // trace 耗时 = 总跨度（其 observation 的最晚结束 − 最早开始），
  // 与 Trace 详情页「总跨度」同口径（原实现取「首个 generation 的耗时」，与详情页不一致）
  function traceSpan(t: (typeof shown)[number]): number | null {
    if (t.observations.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const o of t.observations) {
      const s = o.startTime.getTime();
      if (s < min) min = s;
      const e = (o.endTime ?? o.startTime).getTime();
      if (e > max) max = e;
    }
    return max >= min ? max - min : null;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Traces</h1>
          <div className="sub">
            时间窗 {formatDateTime(from)} → {formatDateTime(to)} · 共 {total} 条
            {errorTotal > 0 && (
              <>
                {" · "}
                <span className="text-danger">{errorTotal} 条 ERROR</span>
              </>
            )}
          </div>
        </div>
        <div className="btn-group">
          <Link
            className="btn"
            href={`/api/export/traces?${buildQuery({
              from,
              to,
              q,
              userId,
              sessionId,
              model,
              tags,
              level,
              env,
              agent,
            })}`}
            prefetch={false}
            title="按当前筛选条件导出 CSV"
          >
            导出 CSV
          </Link>
          <Link className="btn" href="/docs" prefetch={false}>
            如何接入？
          </Link>
        </div>
      </div>

      {/* 快捷时间窗 seg（点击重置其他筛选，仅设 from/to） */}
      <div className="form-inline mb-2">
        <span className="mute2 text-sm">
          快捷时间窗
        </span>
        <span className="seg">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`/traces?${buildQuery({
                from: new Date(Date.now() - r.ms),
                to: new Date(),
                page: 1,
              })}`}
              prefetch={false}
              className={activeRange?.key === r.key ? "seg-btn active" : "seg-btn"}
              aria-current={activeRange?.key === r.key ? "true" : undefined}
            >
              {r.label}
            </Link>
          ))}
        </span>
      </div>

      {/* 过滤表单（GET 提交，纯服务端） */}
      <form className="card filter-bar mb-3">
        <label>
          <span>名称搜索</span>
          <input name="q" defaultValue={q ?? ""} placeholder="trace 名称..." />
        </label>
        <label>
          <span>用户</span>
          <input name="user" defaultValue={userId ?? ""} placeholder="userId 模糊匹配..." />
        </label>
        <label>
          <span>会话</span>
          <input name="session" defaultValue={sessionId ?? ""} placeholder="sessionId 模糊匹配..." />
        </label>
        <label>
          <span>模型</span>
          <input name="model" defaultValue={model ?? ""} placeholder="模型名，如 deepseek" />
        </label>
        <label>
          <span>Agent</span>
          <input name="agent" defaultValue={agent ?? ""} placeholder="agentName 模糊匹配..." />
        </label>
        <label>
          <span>标签</span>
          <input name="tag" defaultValue={tags.join(",")} placeholder="逗号分隔，全部命中" />
        </label>
        <label>
          <span>级别</span>
          <select name="level" defaultValue={level ?? ""}>
            <option value="">全部</option>
            <option value="ERROR">ERROR</option>
            <option value="WARNING">WARNING</option>
            <option value="DEFAULT">DEFAULT</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </label>
        <label>
          <span>环境</span>
          <select name="env" defaultValue={env ?? ""}>
            <option value="">全部</option>
            {envs.map((e) => (
              <option key={e.environment} value={e.environment}>
                {e.environment}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>起始时间</span>
          <input type="datetime-local" name="from" defaultValue={toLocalInput(from)} />
        </label>
        <label>
          <span>结束时间</span>
          <input type="datetime-local" name="to" defaultValue={toLocalInput(to)} />
        </label>
        <button type="submit" className="btn primary">
          查询
        </button>
        <Link className="btn" href="/traces" prefetch={false}>
          重置
        </Link>
      </form>

      {/* 当前筛选回显：每个 tag 点击即移除该筛选条件 */}
      {(q || userId || sessionId || model || agent || tags.length > 0 || level || env) && (
        <div className="form-inline mb-2">
          <span className="mute2 text-sm">当前筛选</span>
          {q && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, model, tags, level, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：名称搜索"
            >
              名称: {q} ✕
            </Link>
          )}
          {userId && (
            <Link
              href={`/traces?${buildQuery({ from, to, sessionId, model, tags, level, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：用户"
            >
              用户: {short(userId)} ✕
            </Link>
          )}
          {sessionId && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, model, tags, level, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：会话"
            >
              会话: {short(sessionId)} ✕
            </Link>
          )}
          {model && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, tags, level, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：模型"
            >
              模型: {model} ✕
            </Link>
          )}
          {agent && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, model, tags, level, env, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：Agent"
            >
              Agent: {agent} ✕
            </Link>
          )}
          {tags.length > 0 && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, model, level, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：标签"
            >
              标签: {tags.join(", ")} ✕
            </Link>
          )}
          {level && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, model, tags, env, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：级别"
            >
              级别: {level} ✕
            </Link>
          )}
          {env && (
            <Link
              href={`/traces?${buildQuery({ from, to, userId, sessionId, model, tags, level, agent, sort: sortKey !== "time" ? sortKey : undefined, dir: sortDir !== "desc" ? sortDir : undefined, page: 1 })}`}
              prefetch={false}
              className="badge"
              title="移除：环境"
            >
              环境: {env} ✕
            </Link>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="list" />
          该时间窗内没有 Trace。试试放宽时间范围，或先注入一条数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col" className="col-narrow">信号</th>
                <th scope="col" className="col-narrow">Agent</th>
                <th scope="col">Trace ID</th>
                {sortTh("时间", "time")}
                <th scope="col" className="col-narrow">用户</th>
                <th scope="col" className="col-narrow">模型</th>
                {sortTh("耗时", "latency", "trace 总跨度（最晚结束 − 最早开始），与详情页一致")}
                {sortTh("Token", "token")}
                {sortTh("成本", "cost")}
                <th scope="col">Obs</th>
                <th scope="col">Score</th>
                <th scope="col">环境</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const latency = traceSpan(t);
                const sig = signalMap.get(t.id);
                const hasError = t.observations.some(
                  (o) => o.level === "ERROR",
                );
                const hasWarn = !hasError && t.observations.some(
                  (o) => o.level === "WARNING",
                );
                const models = Array.from(
                  new Set(
                    t.observations
                      .map((o) => o.model)
                      .filter(Boolean) as string[],
                  ),
                );
                return (
                  <tr
                    key={t.id}
                    data-level={hasError ? "ERROR" : hasWarn ? "WARNING" : undefined}
                  >
                    <td>
                      <Link href={`/traces/${t.id}`} prefetch={false}>
                        {hasError && (
                          <span
                            className="text-danger mr-1"
                            title="该 trace 含 ERROR observation"
                          >
                            ●
                          </span>
                        )}
                        {!hasError && hasWarn && (
                          <span
                            className="text-warn mr-1"
                            title="该 trace 含 WARNING observation"
                          >
                            ●
                          </span>
                        )}
                        {t.name || <span className="mute2">（未命名）</span>}
                      </Link>
                      {t.tags.length > 0 && (
                        <div className="mt-2px">
                          {t.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="badge mr-1">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {t.sessionId && (
                        <div className="mt-2px">
                          <Link
                            href={`/sessions/${encodeURIComponent(t.sessionId)}`}
                            prefetch={false}
                            title={`会话 ${t.sessionId}`}
                          >
                            <span className="badge blue">
                              会话 {short(t.sessionId, 8)}
                            </span>
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="col-narrow">
                      {sig ? (
                        <>
                          {sig.ineffectiveStreak > 0 && (
                            <span
                              className="badge red mr-1"
                              title="同名工具连续调用且段内含无进展信号（ERROR / 空输出）"
                            >
                              无效循环 ×{sig.ineffectiveStreak}
                            </span>
                          )}
                          {sig.repeatStreak > 0 && (
                            <span
                              className="badge amber mr-1"
                              title="同名工具在决策序列中连续调用 ≥3 次"
                            >
                              重复调用 ×{sig.repeatStreak}
                            </span>
                          )}
                          {sig.longTask && (
                            <span
                              className="badge amber mr-1"
                              title="STEP 思考节点 ≥ 8"
                            >
                              长任务
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="col-narrow">
                      {t.agentName ? (
                        <Link
                          href={`/agents/${encodeURIComponent(t.agentName)}`}
                          prefetch={false}
                          title={`查看 ${t.agentName} 详情`}
                        >
                          <span className="badge green">{t.agentName}</span>
                        </Link>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                      {t.skillName ? (
                        <span className="badge ml-1">
                          {t.skillName}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono muted" title={t.id}>{t.id.slice(0, 8)}</td>
                    <td className="muted" title={formatDateTime(t.timestamp)}>
                      {formatRelative(t.timestamp)}
                    </td>
                    <td className="mono muted col-narrow">
                      {t.userId ? short(t.userId) : <span className="mute2">—</span>}
                    </td>
                    <td className="col-narrow">
                      {models.length > 0 ? (
                        models.map((m) => (
                          <Link
                            key={m}
                            href={`/models/${encodeURIComponent(m)}`}
                            prefetch={false}
                            title={`查看模型 ${m} 详情`}
                          >
                            <span className="badge purple mr-1">{m}</span>
                          </Link>
                        ))
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">
                      {latency != null ? (
                        <span
                          className={
                            latency < 5000
                              ? "latency-low"
                              : latency < 20000
                                ? "latency-mid"
                                : "latency-high"
                          }
                        >
                          {fmtMs(latency)}
                        </span>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">
                      {formatTokens(
                        t.observations.reduce((s, o) => s + (o.totalTokens ?? 0), 0),
                      )}
                    </td>
                    <td className="mono cost">
                      {formatCost(
                        t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0),
                      )}
                    </td>
                    <td>
                      <span className="badge blue">{t._count.observations}</span>
                    </td>
                    <td>
                      {t.scores.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {t.scores.slice(0, 2).map((s) => (
                            <span
                              key={s.id}
                              className="badge amber"
                              title={`${s.name}: ${formatScoreValue(s.value, s.dataType)}`}
                            >
                              {short(s.name, 8)}: {formatScoreValue(s.value, s.dataType)}
                            </span>
                          ))}
                          {t._count.scores > 2 && (
                            <span className="badge">+{t._count.scores - 2}</span>
                          )}
                        </div>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td>
                      <span className="badge">{t.environment}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        info={
          shown.length === 0
            ? `0 / ${total} 条 · 第 ${page}/${totalPages} 页`
            : `显示 ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown.length} / ${total} 条 · 第 ${page}/${totalPages} 页`
        }
        firstHref={
          page > 1
            ? `/traces?${buildQuery({
                from,
                to,
                q,
                userId,
                sessionId,
                model,
                tags,
                level,
                env,
                agent,
                sort: sortKey,
                dir: sortDir,
                page: 1,
              })}`
            : undefined
        }
        prevHref={
          page > 1
            ? `/traces?${buildQuery({
                from,
                to,
                q,
                userId,
                sessionId,
                model,
                tags,
                level,
                env,
                agent,
                sort: sortKey,
                dir: sortDir,
                page: page - 1,
              })}`
            : undefined
        }
        nextHref={
          page < totalPages
            ? `/traces?${buildQuery({
                from,
                to,
                q,
                userId,
                sessionId,
                model,
                tags,
                level,
                env,
                agent,
                sort: sortKey,
                dir: sortDir,
                page: page + 1,
              })}`
            : undefined
        }
        jump={{
          action: "/traces",
          page,
          totalPages,
          hidden: (
            <>
              <input type="hidden" name="from" value={from.toISOString()} />
              <input type="hidden" name="to" value={to.toISOString()} />
              {q ? <input type="hidden" name="q" value={q} /> : null}
              {userId ? <input type="hidden" name="user" value={userId} /> : null}
              {sessionId ? <input type="hidden" name="session" value={sessionId} /> : null}
              {model ? <input type="hidden" name="model" value={model} /> : null}
              {tags.length > 0 ? <input type="hidden" name="tag" value={tags.join(",")} /> : null}
              {level ? <input type="hidden" name="level" value={level} /> : null}
              {env ? <input type="hidden" name="env" value={env} /> : null}
              {agent ? <input type="hidden" name="agent" value={agent} /> : null}
              {sortKey !== "time" ? <input type="hidden" name="sort" value={sortKey} /> : null}
              {sortDir !== "desc" ? <input type="hidden" name="dir" value={sortDir} /> : null}
            </>
          ),
        }}
      />
    </>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function short(s: string, len = 10): string {
  return s.length <= len ? s : `${s.slice(0, len)}…`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatScoreValue(value: number, dataType: string): string {
  if (dataType === "NUMERIC") return value.toFixed(3);
  if (dataType === "BOOLEAN") return value ? "✓" : "✗";
  return String(value);
}

function buildQuery(p: {
  from: Date;
  to: Date;
  q?: string;
  userId?: string;
  sessionId?: string;
  model?: string;
  tags?: string[];
  level?: string;
  env?: string;
  agent?: string;
  sort?: string;
  dir?: string;
  page?: number;
}): string {
  const params = new URLSearchParams();
  params.set("from", p.from.toISOString());
  params.set("to", p.to.toISOString());
  if (p.q) params.set("q", p.q);
  if (p.userId) params.set("user", p.userId);
  if (p.sessionId) params.set("session", p.sessionId);
  if (p.model) params.set("model", p.model);
  if (p.tags && p.tags.length > 0) params.set("tag", p.tags.join(","));
  if (p.level) params.set("level", p.level);
  if (p.env) params.set("env", p.env);
  if (p.agent) params.set("agent", p.agent);
  if (p.sort && p.sort !== "time") params.set("sort", p.sort);
  if (p.dir && p.dir !== "desc") params.set("dir", p.dir);
  if (p.page && p.page > 1) params.set("page", String(p.page));
  return params.toString();
}
