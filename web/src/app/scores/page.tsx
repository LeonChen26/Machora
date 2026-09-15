import { Link } from "../../components/NativeLink";
import { and, count, desc, gte, type SQL } from "drizzle-orm";
import { db, score, textSearch } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { BarChart } from "../../components/BarChart";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Pager } from "../../components/Pager";
import { cursorCond, encodeCursor } from "../../server/publicQuery";

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

/** 占比百分比（1 位小数）：BOOLEAN 通过率与 CATEGORICAL 类别占比共用 */
function pct(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  // 默认 7 天（不再是「全部」）：无参访问不再触发全表扫描，用户可显式选「全部」
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;
  const name = str(sp.name)?.trim();
  const cursor = str(sp.cursor);

  const since = days > 0 ? new Date(Date.now() - days * DAY_MS) : undefined;

  const conds: SQL<unknown>[] = [];
  if (name) conds.push(textSearch(score.name, name));
  if (since) conds.push(gte(score.timestamp, since));

  // 聚合集：用于汇总卡片与直方图（上限 1000 条防爆）
  const aggScores = await db
    .select()
    .from(score)
    .where(and(...conds))
    .orderBy(desc(score.timestamp))
    .limit(AGG_LIMIT);

  // 明细分页集：keyset 游标按 (timestamp, id)，避免仅按随机 id 翻页导致漏行/重行
  const rows = await db.query.score.findMany({
    where: and(...conds, cursorCond(score.timestamp, score.id, cursor)),
    orderBy: (t, { desc }) => [desc(t.timestamp), desc(t.id)],
    limit: PAGE_SIZE + 1,
    with: { trace: true },
  });
  const hasNext = rows.length > PAGE_SIZE;
  const shown = hasNext ? rows.slice(0, PAGE_SIZE) : rows;
  const lastShown = shown[shown.length - 1];
  const nextCursor =
    hasNext && lastShown ? encodeCursor(lastShown.timestamp, lastShown.id) : null;
  const total = (
    await db.select({ c: count() }).from(score).where(and(...conds))
  )[0].c;

  // 按名称聚合：NUMERIC 求均值与直方图桶；BOOLEAN 统计通过数；CATEGORICAL 统计各类别计数。
  // 此前仅 NUMERIC 参与聚合，BOOLEAN / CATEGORICAL 在汇总 / 分布 / 走势三处被静默丢弃。
  type NameAgg = {
    count: number;
    types: Map<string, number>;
    values: number[];
    boolTrue: number;
    cats: Map<string, number>;
  };
  const byName = new Map<string, NameAgg>();
  for (const s of aggScores) {
    const e = byName.get(s.name) ?? {
      count: 0,
      types: new Map<string, number>(),
      values: [],
      boolTrue: 0,
      cats: new Map<string, number>(),
    };
    e.count++;
    e.types.set(s.dataType, (e.types.get(s.dataType) ?? 0) + 1);
    if (s.dataType === "NUMERIC") {
      e.values.push(s.value);
    } else if (s.dataType === "BOOLEAN") {
      if (s.value) e.boolTrue++;
    } else {
      const cat = s.comment?.split("|")[0]?.trim() || "未分类";
      e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
    }
    byName.set(s.name, e);
  }
  // 同名评分混用类型时，取出现次数最多的类型作为展示口径
  const dominantType = (e: NameAgg): string =>
    Array.from(e.types.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "NUMERIC";
  const topCat = (e: NameAgg): [string, number] | undefined =>
    Array.from(e.cats.entries()).sort((a, b) => b[1] - a[1])[0];

  const summaries = Array.from(byName.entries()).map(([name, e]) => {
    const type = dominantType(e);
    if (type === "BOOLEAN") {
      return {
        name,
        type,
        value: `${pct(e.boolTrue, e.count)}%`,
        hint: `通过 ${e.boolTrue} / ${e.count}`,
      };
    }
    if (type === "CATEGORICAL") {
      const top = topCat(e);
      return {
        name,
        type,
        value: top ? `${pct(top[1], e.count)}%` : "—",
        hint: top
          ? `${top[0]} · ${e.cats.size} 个类别 · n=${e.count}`
          : `n=${e.count}`,
      };
    }
    const avg = e.values.length
      ? e.values.reduce((a, b) => a + b, 0) / e.values.length
      : null;
    return {
      name,
      type,
      value: avg != null ? avg.toFixed(3) : "—",
      hint:
        e.values.length > 0
          ? `n=${e.count} · min ${Math.min(...e.values).toFixed(2)} · max ${Math.max(...e.values).toFixed(2)}`
          : `n=${e.count}`,
    };
  });

  const distributions = Array.from(byName.entries()).map(([name, e]) => {
    const type = dominantType(e);
    if (type === "BOOLEAN") {
      return {
        name,
        type,
        color: "var(--green)",
        emptyText: "暂无 BOOLEAN 样本",
        data: [
          { label: "不通过 ✗", value: e.count - e.boolTrue },
          { label: "通过 ✓", value: e.boolTrue },
        ],
      };
    }
    if (type === "CATEGORICAL") {
      return {
        name,
        type,
        color: undefined as string | undefined,
        emptyText: "暂无 CATEGORICAL 样本",
        data: Array.from(e.cats.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([label, value]) => ({ label, value })),
      };
    }
    return {
      name,
      type,
      color: "var(--purple)" as string | undefined,
      emptyText: "暂无 NUMERIC 样本",
      data: BUCKETS.map((b) => ({
        label: b.label,
        value: e.values.filter((v) => v >= b.min && v < b.max).length,
      })),
    };
  });

  // 按名称 × 天走势：NUMERIC → 日均值；BOOLEAN → 每日通过率%；CATEGORICAL → 最高频类别的每日占比%
  const trendStart = since ?? new Date(Date.now() - 30 * DAY_MS);
  type DayAgg = {
    sum: number;
    count: number;
    trueN: number;
    cats: Map<string, number>;
  };
  const byNameTrend = new Map<string, Map<string, DayAgg>>();
  for (const s of aggScores) {
    if (s.timestamp < trendStart) continue;
    const dayStart = new Date(
      Math.floor(s.timestamp.getTime() / DAY_MS) * DAY_MS,
    );
    const dayKey = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
    const m = byNameTrend.get(s.name) ?? new Map<string, DayAgg>();
    const e = m.get(dayKey) ?? {
      sum: 0,
      count: 0,
      trueN: 0,
      cats: new Map<string, number>(),
    };
    e.sum += s.value;
    e.count++;
    if (s.dataType === "BOOLEAN" && s.value) e.trueN++;
    if (s.dataType !== "NUMERIC" && s.dataType !== "BOOLEAN") {
      const cat = s.comment?.split("|")[0]?.trim() || "未分类";
      e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
    }
    m.set(dayKey, e);
    byNameTrend.set(s.name, m);
  }
  const trends = Array.from(byNameTrend.entries()).map(([name, m]) => {
    const agg = byName.get(name);
    const type = agg ? dominantType(agg) : "NUMERIC";
    const base = agg && type === "CATEGORICAL" ? topCat(agg)?.[0] : undefined;
    return {
      name,
      type,
      hint:
        type === "BOOLEAN"
          ? "每日通过率（%）"
          : type === "CATEGORICAL"
            ? `${base ?? "—"} 的每日占比（%）`
            : "日均值 / 天",
      data: Array.from(m.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([dayKey, e]) => {
          if (type === "BOOLEAN") {
            return { label: dayKey, value: pct(e.trueN, e.count) };
          }
          if (type === "CATEGORICAL") {
            return {
              label: dayKey,
              value: pct(base ? e.cats.get(base) ?? 0 : 0, e.count),
            };
          }
          return {
            label: dayKey,
            value: Math.round((e.sum / e.count) * 1000) / 1000,
          };
        }),
    };
  });

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
            汇总 <span className="count">均值 / 通过率 / 类别占比</span>
          </div>
          <div className="grid grid-4">
            {summaries.map((s) => (
              <div className="card" key={s.name}>
                <div className="label">
                  {s.name} <span className="badge">{s.type}</span>
                </div>
                <div className="value text-accent">{s.value}</div>
                <div className="hint">{s.hint}</div>
              </div>
            ))}
          </div>

          <div className="section-title">
            值分布 <span className="count">区间 / 通过数 / 类别计数</span>
          </div>
          <div className="grid grid-4">
            {distributions.map((d) => (
              <div className="card" key={d.name}>
                <div className="label">
                  {d.name} <span className="badge">{d.type}</span>
                </div>
                <BarChart
                  data={d.data}
                  height={110}
                  color={d.color}
                  emptyText={d.emptyText}
                />
              </div>
            ))}
          </div>

          <div className="section-title">
            时间走势 <span className="count">按天</span>
          </div>
          <div className="grid grid-4">
            {trends.map((t) => (
              <div className="card" key={t.name}>
                <div className="label">
                  {t.name} <span className="badge">{t.type}</span>
                </div>
                <div className="hint">{t.hint}</div>
                <BarChart
                  data={t.data}
                  height={110}
                  color="var(--green)"
                  emptyText="暂无走势数据"
                />
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


