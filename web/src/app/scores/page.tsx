import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { BarChart } from "../../components/BarChart";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Pager } from "../../components/Pager";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";

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
  await requireUser();

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

  // 按名称 × 天的时间走势（仅 NUMERIC，日均值；全部时回退最近 30 天）
  const trendStart = since ?? new Date(Date.now() - 30 * DAY_MS);
  const byNameTrend = new Map<
    string,
    Map<string, { sum: number; count: number }>
  >();
  for (const s of aggScores) {
    if (s.dataType !== "NUMERIC" || s.timestamp < trendStart) continue;
    const dayStart = new Date(
      Math.floor(s.timestamp.getTime() / DAY_MS) * DAY_MS,
    );
    const dayKey = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
    const m = byNameTrend.get(s.name) ?? new Map<string, { sum: number; count: number }>();
    const e = m.get(dayKey) ?? { sum: 0, count: 0 };
    e.sum += s.value;
    e.count++;
    m.set(dayKey, e);
    byNameTrend.set(s.name, m);
  }
  const trends = Array.from(byNameTrend.entries()).map(([name, m]) => ({
    name,
    data: Array.from(m.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([dayKey, e]) => ({
        label: dayKey,
        value: Math.round((e.sum / e.count) * 1000) / 1000,
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
      <div className="card mb-3">
        <div className="seg">
          {DAY_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`/scores?${buildQuery({ name, days: d })}`}
              prefetch={false}
              className={d === days ? "seg-btn active" : "seg-btn"}
              aria-current={d === days ? "true" : undefined}
            >
              {d === 0 ? "全部" : `${d} 天`}
            </Link>
          ))}
        </div>
        <form
          action="/scores"
          method="get"
          className="form-row mt-2"
        >
          <input type="hidden" name="days" value={days > 0 ? days : ""} />
          <label className="field">
            <span className="field-label">名称</span>
            <input
              name="name"
              defaultValue={name ?? ""}
              placeholder="评分名称模糊匹配..."
              className="input"
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
                  <div className="value text-accent">
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

          <div className="section-title">
            时间走势 <span className="count">日均值 / 天</span>
          </div>
          <div className="grid grid-4">
            {trends.map(({ name, data }) => (
              <div className="card" key={name}>
                <div className="label">{name}</div>
                <BarChart data={data} height={110} color="var(--green)" emptyText="暂无走势数据" />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">明细</div>
      {shown.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="star" />
          暂无评分数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">值</th>
                <th scope="col">类型</th>
                <th scope="col">来源</th>
                <th scope="col">Trace</th>
                <th scope="col">时间</th>
                <th scope="col">备注</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      className="score-value"
                      data-grade={
                        s.dataType === "NUMERIC"
                          ? s.value >= 0.8
                            ? "good"
                            : s.value >= 0.5
                              ? "mid"
                              : "bad"
                          : undefined
                      }
                    >
                      {s.dataType === "NUMERIC"
                        ? s.value.toFixed(3)
                        : s.dataType === "BOOLEAN"
                          ? s.value
                            ? "✓"
                            : "✗"
                          : (s.comment?.split("|")[0]?.trim() || "—")}
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

      <Pager
        info={`显示 ${shown.length} / ${total} 条`}
        firstHref={cursor ? `/scores?${buildQuery({ name, days })}` : undefined}
        nextHref={nextCursor ? `/scores?${buildQuery({ name, days, cursor: nextCursor })}` : undefined}
      />
    </>
  );
}


