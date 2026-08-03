import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import type { ReactNode } from "react";
import {
  formatRelative,
  formatDateTime,
  formatDuration,
  durationMs,
  formatTokens,
  formatCost,
} from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";
import {
  parseGenerationFilters,
  buildGenerationWhere,
} from "../../server/traceQuery";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function levelBadge(level: string): string {
  if (level === "ERROR") return "red";
  if (level === "WARNING") return "amber";
  if (level === "DEBUG") return "blue";
  return "green";
}

export default async function GenerationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const projectId = await getCurrentProjectId();

  const daysRaw = str(sp.days);
  const days = daysRaw ? Number.parseInt(daysRaw, 10) : 7;
  const gf = parseGenerationFilters(sp);
  const { since, level, model } = gf;
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  const where = buildGenerationWhere(projectId, gf);

  // 模型下拉选项（当前项目去重）
  const models = await prisma.observation.findMany({
    where: { projectId, type: "GENERATION" },
    select: { model: true },
    distinct: ["model"],
    orderBy: { model: "asc" },
  });

  const [items, total] = await Promise.all([
    prisma.observation.findMany({
      where,
      orderBy: { startTime: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        model: true,
        startTime: true,
        endTime: true,
        totalTokens: true,
        totalCost: true,
        level: true,
        trace: { select: { id: true, name: true } },
      },
    }),
    prisma.observation.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 排序：time / cost / latency / token（JS 层排序当前页）
  const sortKey = str(sp.sort)?.trim() || "time";
  const sortDir = str(sp.dir) === "asc" ? "asc" : "desc";
  function sortValue(
    o: (typeof items)[number],
    key: string,
  ): number | null {
    if (key === "cost") return o.totalCost ?? null;
    if (key === "token") return o.totalTokens ?? null;
    if (key === "latency")
      return o.endTime ? o.endTime.getTime() - o.startTime.getTime() : null;
    return o.startTime.getTime();
  }
  const sortedShown = [...items].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sortDir === "asc" ? va - vb : vb - va;
  });

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
    return `/generations${qsStr ? `?${qsStr}` : ""}`;
  };

  function sortHref(key: string): string {
    const nextDir =
      sortKey === key ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    return qs(1, { sort: key, dir: nextDir });
  }
  function sortTh(label: string, sortFor: string): ReactNode {
    const active = sortKey === sortFor;
    return (
      <th>
        <Link
          href={sortHref(sortFor)}
          prefetch={false}
          style={{
            color: active ? "var(--accent)" : "inherit",
            fontWeight: active ? 600 : 500,
          }}
        >
          {label} {active ? (sortDir === "desc" ? "↓" : "↑") : ""}
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

      {/* 快捷时间窗 seg（保留 model/level 筛选） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <span className="mute2" style={{ fontSize: 12 }}>
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
              >
                {r.label}
              </Link>
            );
          })}
        </span>
      </div>

      {/* 过滤表单（GET 提交，纯服务端） */}
      <form className="card filter-bar" style={{ marginBottom: "1rem" }}>
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
        <Link className="btn" href="/generations" prefetch={false}>
          重置
        </Link>
      </form>

      {items.length === 0 ? (
        <div className="card empty">
          <div className="icon">◆</div>
          该条件下没有 GENERATION 调用。试试放宽筛选，或先注入一条数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {sortTh("时间", "time")}
                <th>Trace</th>
                <th>名称</th>
                <th>模型</th>
                {sortTh("耗时", "latency")}
                {sortTh("Token", "token")}
                {sortTh("成本", "cost")}
                <th>级别</th>
              </tr>
            </thead>
            <tbody>
              {sortedShown.map((o) => (
                <tr key={o.id} data-level={o.level === "ERROR" || o.level === "WARNING" ? o.level : undefined}>
                  <td className="mono muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                    {formatRelative(o.startTime)}
                  </td>
                  <td>
                    <Link href={`/traces/${o.trace.id}`} prefetch={false}>
                      {o.trace.name ?? o.trace.id}
                    </Link>
                  </td>
                  <td>{o.name || <span className="mute2">—</span>}</td>
                  <td>
                    {o.model ? (
                      <span className="badge purple">{o.model}</span>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {o.endTime
                      ? formatDuration(durationMs(o.startTime, o.endTime))
                      : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {o.totalTokens != null ? formatTokens(o.totalTokens) : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
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

      <div className="pager">
        <span className="info">
          {formatDateTime(since ?? new Date(0))} 起 · 第 {page} / {totalPages} 页 · 共{" "}
          {total} 条
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {page > 1 ? (
            <Link className="btn-sm" href={qs(page - 1)} prefetch={false}>
              ← 上一页
            </Link>
          ) : (
            <span className="btn-sm" style={{ opacity: 0.35 }}>
              ← 上一页
            </span>
          )}
          {/* 跳页（GET 表单保留筛选与排序） */}
          <form
            action="/generations"
            method="get"
            style={{ display: "flex", gap: 4, alignItems: "center" }}
          >
            <input type="hidden" name="days" value={String(days)} />
            {model ? <input type="hidden" name="model" value={model} /> : null}
            {level ? <input type="hidden" name="level" value={level} /> : null}
            {sortKey !== "time" ? <input type="hidden" name="sort" value={sortKey} /> : null}
            {sortDir !== "desc" ? <input type="hidden" name="dir" value={sortDir} /> : null}
            <input
              type="number"
              name="page"
              min={1}
              max={totalPages}
              defaultValue={page}
              style={{
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0.35rem 0.5rem",
                color: "var(--text)",
                fontSize: 13,
                width: 60,
              }}
              aria-label="跳转到页码"
            />
            <button type="submit" className="btn-sm">
              跳转
            </button>
          </form>
          <Link className="btn-sm" href={qs(page + 1)} prefetch={false}>
            下一页 →
          </Link>
        </span>
      </div>
    </>
  );
}
