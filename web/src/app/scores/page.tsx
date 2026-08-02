import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { BarChart } from "../../components/BarChart";
import { getCurrentProjectId } from "../../server/project";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const AGG_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// NUMERIC 值分布桶
const BUCKETS = [
  { label: "0–0.2", min: 0, max: 0.2 },
  { label: "0.2–0.4", min: 0.2, max: 0.4 },
  { label: "0.4–0.6", min: 0.4, max: 0.6 },
  { label: "0.6–0.8", min: 0.6, max: 0.8 },
  { label: "0.8–1", min: 0.8, max: 1.001 },
];
const DAY_OPTIONS = [0, 7, 30]; // 0 = 全部

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 0;
  const name = str(sp.name)?.trim();
  const cursor = str(sp.cursor);

  const projectId = await getCurrentProjectId();
  const since = days > 0 ? new Date(Date.now() - days * DAY_MS) : undefined;

  const where = {
    projectId,
    ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    ...(since ? { timestamp: { gte: since } } : {}),
  };

  // 聚合集：用于汇总卡片与直方图（上限 1000 条防爆）
  const aggScores = await prisma.score.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: AGG_LIMIT,
  });

  // 明细分页集
  const rows = await prisma.score.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: PAGE_SIZE + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    include: { trace: { select: { name: true } } },
  });
  const hasNext = rows.length > PAGE_SIZE;
  const shown = hasNext ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasNext ? rows[rows.length - 1].id : null;
  const total = await prisma.score.count({ where });

  // 按名称聚合（仅 NUMERIC）
  const byName = new Map<string, { count: number; sum: number; values: number[] }>();
  for (const s of aggScores) {
    if (s.dataType !== "NUMERIC") continue;
    const entry = byName.get(s.name) ?? { count: 0, sum: 0, values: [] };
    entry.count++;
    entry.sum += s.value;
    entry.values.push(s.value);
    byName.set(s.name, entry);
  }

  const distributions = Array.from(byName.entries()).map(([name, e]) => ({
    name,
    data: BUCKETS.map((b) => ({
      label: b.label,
      value: e.values.filter((v) => v >= b.min && v < b.max).length,
    })),
  }));

  function buildQuery(opts: { name?: string; days: number; cursor?: string }): string {
    const params = new URLSearchParams();
    if (opts.days > 0) params.set("days", String(opts.days));
    if (opts.name) params.set("name", opts.name);
    if (opts.cursor) params.set("cursor", opts.cursor);
    return params.toString();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scores</h1>
          <div className="sub">
            {total} 条评分
            {since ? ` · 近 ${days} 天` : ""}
            {name ? ` · 名称含 "${name}"` : ""}
          </div>
        </div>
      </div>

      {/* 过滤（时间窗 + 名称） */}
      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="seg">
          {DAY_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`/scores?${buildQuery({ name, days: d })}`}
              prefetch={false}
              className={d === days ? "seg-btn active" : "seg-btn"}
            >
              {d === 0 ? "全部" : `${d} 天`}
            </Link>
          ))}
        </div>
        <form
          action="/scores"
          method="get"
          style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem", alignItems: "flex-end" }}
        >
          <input type="hidden" name="days" value={days > 0 ? days : ""} />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="mute2" style={{ fontSize: 12 }}>名称</span>
            <input
              name="name"
              defaultValue={name ?? ""}
              placeholder="评分名称模糊匹配..."
              style={inputStyle}
            />
          </label>
          <button type="submit" className="btn primary">查询</button>
          <Link className="btn" href="/scores" prefetch={false}>重置</Link>
        </form>
      </div>

      {byName.size > 0 && (
        <>
          <div className="section-title">
            汇总 <span className="count">仅 NUMERIC 类型</span>
          </div>
          <div className="grid grid-4">
            {Array.from(byName.entries()).map(([name, e]) => {
              const avg = e.sum / e.count;
              const min = Math.min(...e.values);
              const max = Math.max(...e.values);
              return (
                <div className="card" key={name}>
                  <div className="label">{name}</div>
                  <div className="value" style={{ color: "var(--accent)" }}>
                    {avg.toFixed(3)}
                  </div>
                  <div className="hint">
                    n={e.count} · min {min.toFixed(2)} · max {max.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="section-title">
            值分布 <span className="count">样本数 / 区间</span>
          </div>
          <div className="grid grid-4">
            {distributions.map(({ name, data }) => (
              <div className="card" key={name}>
                <div className="label">{name}</div>
                <BarChart data={data} height={110} emptyText="暂无 NUMERIC 样本" />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">明细</div>
      {shown.length === 0 ? (
        <div className="card empty">
          <div className="icon">★</div>
          暂无评分数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>值</th>
                <th>类型</th>
                <th>来源</th>
                <th>Trace</th>
                <th>时间</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      style={{
                        color:
                          s.dataType === "NUMERIC"
                            ? s.value >= 0.8
                              ? "var(--green)"
                              : s.value >= 0.5
                                ? "var(--amber)"
                                : "var(--red)"
                            : "var(--text)",
                        fontFamily: "var(--mono)",
                        fontWeight: 600,
                      }}
                    >
                      {s.dataType === "NUMERIC"
                        ? s.value.toFixed(3)
                        : s.dataType === "BOOLEAN"
                          ? s.value
                            ? "✓"
                            : "✗"
                          : String(s.value)}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{s.dataType}</span>
                  </td>
                  <td>
                    <span className="badge blue">{s.source}</span>
                  </td>
                  <td>
                    {s.traceId ? (
                      <Link href={`/traces/${s.traceId}`} prefetch={false}>
                        {s.trace?.name || <span className="mono muted">{s.traceId.slice(0, 8)}…</span>}
                      </Link>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="muted" title={formatDateTime(s.timestamp)}>
                    {formatRelative(s.timestamp)}
                  </td>
                  <td className="muted">{s.comment || <span className="mute2">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <span className="info">
          显示 {shown.length} / {total} 条
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {cursor && (
            <Link className="btn" href={`/scores?${buildQuery({ name, days })}`} prefetch={false}>
              ← 首页
            </Link>
          )}
          {nextCursor && (
            <Link
              className="btn primary"
              href={`/scores?${buildQuery({ name, days, cursor: nextCursor })}`}
              prefetch={false}
            >
              下一页 →
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elev-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.35rem 0.6rem",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--mono)",
};
