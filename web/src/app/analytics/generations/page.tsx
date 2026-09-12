import { Link } from "../../../components/NativeLink";
import { EmptyIcon } from "../../../components/EmptyIcon";
import { Pager } from "../../../components/Pager";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db, observation, trace } from "@machora/shared";
import type { ReactNode } from "react";
import {
  formatRelative,
  formatDateTime,
  formatDuration,
  durationMs,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { levelBadge } from "../../../lib/levelBadge";
import {
  parseDays,
  parseGenerationFilters,
  buildGenerationWhere,
} from "../../../server/traceQuery";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function GenerationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const days = parseDays(sp.days, 7);
  const gf = parseGenerationFilters(sp);
  const { since, level, model } = gf;
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  const where = buildGenerationWhere(gf);

  // 模型下拉选项
  const models = await db
    .selectDistinct({ model: observation.model })
    .from(observation)
    .where(inArray(observation.type, ["LLM", "EMBEDDING"]))
    .orderBy(asc(observation.model));

  const sortKey = str(sp.sort)?.trim() || "time";
  const sortDir = str(sp.dir) === "asc" ? "asc" : "desc";
  // 排序键下推到 SQL：跨页排序必须按全量结果排，不能只排当前页。
  // 空值统一置后（SQLite 默认 NULL 最小，加一个 is null 前导键即可两种方向都置后）。
  const sortExpr =
    sortKey === "cost"
      ? observation.totalCost
      : sortKey === "token"
        ? observation.totalTokens
        : sortKey === "latency"
          ? sql`(${observation.endTime} - ${observation.startTime})`
          : observation.startTime;

  const [items, total] = await Promise.all([
    db
      .select({
        id: observation.id,
        name: observation.name,
        model: observation.model,
        startTime: observation.startTime,
        endTime: observation.endTime,
        totalTokens: observation.totalTokens,
        totalCost: observation.totalCost,
        level: observation.level,
        traceId: trace.id,
        traceName: trace.name,
      })
      .from(observation)
      .leftJoin(trace, eq(observation.traceId, trace.id))
      .where(and(...where))
      .orderBy(
        sql`${sortExpr} is null`,
        sortDir === "asc" ? asc(sortExpr) : desc(sortExpr),
      )
      .offset((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE),
    db
      .select({ c: count() })
      .from(observation)
      .where(and(...where))
      .then((r) => r[0].c),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qs = (p: number, extra?: Record<string, string>) => {
    const params = new URLSearchParams();
    params.set("days", String(days));
    if (model) params.set("model", model);
    if (level) params.set("level", level);
    if (sortKey !== "time") params.set("sort", sortKey);
    if (sortDir !== "desc") params.set("dir", sortDir);
    if (p > 1) params.set("page", String(p));
    if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
    const qsStr = params.toString();
    return `/analytics/generations${qsStr ? `?${qsStr}` : ""}`;
  };

  function sortHref(key: string): string {
    const nextDir =
      sortKey === key ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    return qs(1, { sort: key, dir: nextDir });
  }
  function sortTh(label: string, sortFor: string): ReactNode {
    const active = sortKey === sortFor;
    return (
      <th scope="col">
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Generations</h1>
          <div className="sub">全部 LLM 调用 · 共 {total} 条</div>
        </div>
        <Link
          className="btn"
          href={`/api/export/generations?days=${days}&model=${encodeURIComponent(model ?? "")}&level=${level ?? ""}`}
          prefetch={false}
          title="按当前筛选条件导出 CSV"
        >
          导出 CSV
        </Link>
      </div>

      {/* 维度导航 */}
      <div className="seg">
        <Link href="/analytics" prefetch={false} className="seg-btn">
          总览
        </Link>
        <Link href="/analytics/topology" prefetch={false} className="seg-btn">
          Agent 拓扑
        </Link>
        <Link
          href="/analytics/generations"
          prefetch={false}
          className="seg-btn active"
          aria-current="true"
        >
          Generations
        </Link>
      </div>

      {/* 快捷时间窗 seg（保留 model/level 筛选） */}
      <div className="form-inline mb-2">
        <span className="mute2 text-sm">
          快捷时间窗
        </span>
        <span className="seg">
          {[
            { key: "0", label: "全部", ms: 0 },
            { key: "24h", label: "近 24 小时", ms: 1 },
            { key: "7d", label: "近 7 天", ms: 7 },
            { key: "30d", label: "近 30 天", ms: 30 },
          ].map((r) => {
            const daysVal = r.ms === 1 ? 1 : r.ms;
            const active =
              days === daysVal ||
              (r.key === "0" && days === 0) ||
              (r.key === "24h" && days === 1);
            return (
              <Link
                key={r.key}
                href={qs(1, { days: String(daysVal) })}
                prefetch={false}
                className={active ? "seg-btn active" : "seg-btn"}
                aria-current={active ? "true" : undefined}
              >
                {r.label}
              </Link>
            );
          })}
        </span>
      </div>

      {/* 过滤表单（GET 提交，纯服务端） */}
      <form className="card filter-bar mb-3">
        <label>
          <span>模型</span>
          <select name="model" defaultValue={model ?? ""}>
            <option value="">全部</option>
            {models.map((m) => (
              <option key={m.model} value={m.model ?? ""}>
                {m.model ?? "（空）"}
              </option>
            ))}
          </select>
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
        <button type="submit" className="btn primary">
          查询
        </button>
        <Link className="btn" href="/analytics/generations" prefetch={false}>
          重置
        </Link>
      </form>

      {items.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="list" />
          该条件下没有 LLM / Embedding 调用。试试放宽筛选，或先注入一条数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {sortTh("时间", "time")}
                <th scope="col">Trace</th>
                <th scope="col">名称</th>
                <th scope="col">模型</th>
                {sortTh("耗时", "latency")}
                {sortTh("Token", "token")}
                {sortTh("成本", "cost")}
                <th scope="col">级别</th>
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id} data-level={o.level === "ERROR" || o.level === "WARNING" ? o.level : undefined}>
                  <td className="mono muted text-xs" style={{ whiteSpace: "nowrap" }}>
                    {formatRelative(o.startTime)}
                  </td>
                  <td>
                    {o.traceId ? (
                      <Link href={`/traces/${o.traceId}`} prefetch={false}>
                        {o.traceName ?? o.traceId}
                      </Link>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td>{o.name || <span className="mute2">—</span>}</td>
                  <td>
                    {o.model ? (
                      <Link
                        href={`/models/${encodeURIComponent(o.model)}`}
                        prefetch={false}
                        title={`查看模型 ${o.model} 详情`}
                      >
                        <span className="badge purple">{o.model}</span>
                      </Link>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="mono muted text-xs">
                    {o.endTime
                      ? formatDuration(durationMs(o.startTime, o.endTime))
                      : "—"}
                  </td>
                  <td className="mono text-xs">
                    {o.totalTokens != null ? formatTokens(o.totalTokens) : "—"}
                  </td>
                  <td className="mono text-xs">
                    {o.totalCost != null ? formatCost(o.totalCost) : "—"}
                  </td>
                  <td>
                    <span className={`badge ${levelBadge(o.level)}`}>{o.level}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        info={`${formatDateTime(since ?? new Date(0))} 起 · 第 ${page} / ${totalPages} 页 · 共 ${total} 条`}
        prevHref={page > 1 ? qs(page - 1) : undefined}
        nextHref={page < totalPages ? qs(page + 1) : undefined}
        jump={{
          action: "/analytics/generations",
          page,
          totalPages,
          hidden: (
            <>
              <input type="hidden" name="days" value={String(days)} />
              {model ? <input type="hidden" name="model" value={model} /> : null}
              {level ? <input type="hidden" name="level" value={level} /> : null}
              {sortKey !== "time" ? <input type="hidden" name="sort" value={sortKey} /> : null}
              {sortDir !== "desc" ? <input type="hidden" name="dir" value={sortDir} /> : null}
            </>
          ),
        }}
      />
    </>
  );
}
