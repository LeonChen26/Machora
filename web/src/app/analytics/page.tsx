import { Link } from "../../components/NativeLink";
import { and, gte, inArray } from "drizzle-orm";
import { db, observation } from "@machora/shared";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";
import { StackedBarChart } from "../../components/StackedBarChart";
import { BarChart } from "../../components/BarChart";
import { StatCard } from "../../components/StatCard";
import {
  emptyStat,
  summarize,
  type ModelStat,
} from "../../server/agentStats";
import {
  detectMetricSignals,
  formatSignalDetails,
} from "../../server/signals";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30];
const METRICS = [
  { key: "count", label: "调用量" },
  { key: "tokens", label: "Token" },
  { key: "cost", label: "成本" },
  { key: "latency", label: "延迟(avg)" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function buildQuery(days: number, metric: MetricKey): string {
  const params = new URLSearchParams();
  params.set("days", String(days));
  params.set("metric", metric);
  return params.toString();
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;
  const rawMetric = str(sp.metric) as MetricKey | undefined;
  const metric: MetricKey = METRICS.some((m) => m.key === rawMetric)
    ? (rawMetric as MetricKey)
    : "count";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 当前窗口（含今天）与等长的前窗口，用于趋势与异常对比
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  const gens = await db
    .select({
      model: observation.model,
      startTime: observation.startTime,
      endTime: observation.endTime,
      level: observation.level,
      totalTokens: observation.totalTokens,
      totalCost: observation.totalCost,
    })
    .from(observation)
    .where(
      and(
        inArray(observation.type, ["LLM", "EMBEDDING"]),
        gte(observation.startTime, prevSince),
      ),
    );

  // 按窗口拆解
  const cur = new Map<string, ModelStat>();
  const prev = new Map<string, ModelStat>();
  // 每日 × 模型 趋势（仅当前窗口）
  const perDay = new Map<string, Map<string, ModelStat>>();
  for (const g of gens) {
    const model = g.model ?? "unknown";
    if (g.startTime >= since) {
      const s = cur.get(model) ?? emptyStat();
      s.count++;
      if (g.endTime) s.latencies.push(g.endTime.getTime() - g.startTime.getTime());
      if (g.level === "ERROR") s.errors++;
      if (g.level === "WARNING") s.warnings++;
      s.tokens += g.totalTokens ?? 0;
      s.cost += g.totalCost ?? 0;
      cur.set(model, s);

      const dayIdx = Math.floor((g.startTime.getTime() - since.getTime()) / DAY_MS);
      const dayStart = new Date(since.getTime() + Math.max(dayIdx, 0) * DAY_MS);
      const key = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
      const dayMap = perDay.get(key) ?? new Map<string, ModelStat>();
      const ds = dayMap.get(model) ?? emptyStat();
      ds.count++;
      if (g.endTime) ds.latencies.push(g.endTime.getTime() - g.startTime.getTime());
      ds.tokens += g.totalTokens ?? 0;
      ds.cost += g.totalCost ?? 0;
      dayMap.set(model, ds);
      perDay.set(key, dayMap);
    } else {
      const s = prev.get(model) ?? emptyStat();
      s.count++;
      if (g.endTime) s.latencies.push(g.endTime.getTime() - g.startTime.getTime());
      if (g.level === "ERROR") s.errors++;
      if (g.level === "WARNING") s.warnings++;
      s.tokens += g.totalTokens ?? 0;
      s.cost += g.totalCost ?? 0;
      prev.set(model, s);
    }
  }

  // 当前窗口汇总（保留全部分量用于对比）
  const curSummary = new Map(
    Array.from(cur.entries()).map(([name, s]) => [name, summarize(s)]),
  );
  const prevSummary = new Map(
    Array.from(prev.entries()).map(([name, s]) => [name, summarize(s)]),
  );

  // 异常检测：当前窗口 vs 前窗口（阈值统一由 signals.ts 提供）
  const anomalies = new Map<string, string[]>();
  for (const [name, c] of curSummary) {
    const p = prevSummary.get(name);
    if (!p || p.count === 0) continue;
    const flags = formatSignalDetails(
      detectMetricSignals({
        scope: "model",
        name,
        cur: { cost: c.cost, steps: c.count, errorRate: c.errorRate, p95: c.p95 },
        prev: { cost: p.cost, steps: p.count, errorRate: p.errorRate, p95: p.p95 },
        days,
      }),
    );
    if (flags.length > 0) anomalies.set(name, flags);
  }

  const models = Array.from(curSummary.entries())
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.count - a.count);

  // 总体统计（当前窗口）
  const total = models.reduce((s, m) => s + m.count, 0);
  const totalLatencies = Array.from(cur.values()).flatMap((m) => m.latencies).sort((a, b) => a - b);
  const totalAvg = totalLatencies.length
    ? totalLatencies.reduce((s, x) => s + x, 0) / totalLatencies.length
    : null;
  const totalP95 = totalLatencies.length
    ? totalLatencies[Math.min(totalLatencies.length - 1, Math.floor(totalLatencies.length * 0.95))]
    : null;
  const totalErrors = Array.from(cur.values()).reduce((s, m) => s + m.errors, 0);
  const totalWarnings = Array.from(cur.values()).reduce((s, m) => s + m.warnings, 0);
  const totalErrorRate = total ? totalErrors / total : 0;
  const totalTokens = Array.from(cur.values()).reduce((s, m) => s + m.tokens, 0);
  const totalCost = Array.from(cur.values()).reduce((s, m) => s + m.cost, 0);
  const costModels = models.filter((m) => m.cost > 0).length;

  // 趋势图：按天 × 模型，值随 metric
  const trend = Array.from({ length: days }, (_, i) => {
    const dayStart = new Date(since.getTime() + i * DAY_MS);
    const key = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
    const dayMap = perDay.get(key) ?? new Map<string, ModelStat>();
    return {
      label: key,
      series: Array.from(dayMap.entries())
        .map(([name, s]) => ({
          name,
          value:
            metric === "count"
              ? s.count
              : metric === "tokens"
                ? s.tokens
                : metric === "latency"
                  ? s.latencies.length
                    ? Math.round(
                        s.latencies.reduce((x, y) => x + y, 0) /
                          s.latencies.length,
                      )
                    : 0
                  : s.cost,
        }))
        .filter((x) => x.value > 0),
    };
  });

  // 延迟直方图（当前窗口，分桶）
  const LATENCY_BUCKETS: { label: string; max: number }[] = [
    { label: "<100ms", max: 100 },
    { label: "<250ms", max: 250 },
    { label: "<500ms", max: 500 },
    { label: "<1s", max: 1000 },
    { label: "<2s", max: 2000 },
    { label: "<5s", max: 5000 },
    { label: "≥5s", max: Infinity },
  ];
  const histData = LATENCY_BUCKETS.map((b, i) => {
    const prevMax = i === 0 ? 0 : LATENCY_BUCKETS[i - 1].max;
    const count = totalLatencies.filter(
      (l) => l > prevMax && l <= b.max,
    ).length;
    return { label: b.label, value: count };
  });

  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "调用量";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <div className="sub">
            近 {days} 天 · {total} 次 generation 调用 · {models.length} 个模型 ·{" "}
            {formatTokens(totalTokens)} tokens · <span className="cost">{formatCost(totalCost)}</span>
          </div>
        </div>
      </div>

      {/* 维度导航 */}
      <div className="seg">
        <Link href="/analytics" prefetch={false} className="seg-btn active" aria-current="true">
          总览
        </Link>
        <Link href="/analytics/topology" prefetch={false} className="seg-btn">
          Agent 拓扑
        </Link>
        <Link href="/analytics/generations" prefetch={false} className="seg-btn">
          Generations
        </Link>
      </div>

      {/* 时间窗切换 */}
      <div className="seg mt-1">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/analytics?${buildQuery(d, metric)}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {/* 趋势维度切换 */}
      <div className="seg mt-1">
        {METRICS.map((m) => (
          <Link
            key={m.key}
            href={`/analytics?${buildQuery(days, m.key)}`}
            prefetch={false}
            className={m.key === metric ? "seg-btn active" : "seg-btn"}
            aria-current={m.key === metric ? "true" : undefined}
          >
            {m.label}
          </Link>
        ))}
      </div>

      {/* 异常告警（模型级环比；对象视角收敛到 /models） */}
      {anomalies.size > 0 && (
        <div className="card alert-danger mt-3">
          <div className="label text-danger">
            异常检测（对比前 {days} 天）
          </div>
          {Array.from(anomalies.entries()).map(([name, flags]) => (
            <div key={name} className="text-md mt-1">
              <Link
                href={`/models/${encodeURIComponent(name)}?days=${days}`}
                prefetch={false}
                title={`查看模型 ${name} 详情`}
              >
                <span className="badge purple">{name}</span>
              </Link>{" "}
              {flags.map((f) => (
                <span key={f} className="badge red ml-2">
                  {f}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-4">
        <StatCard label="调用量" value={total} hint={`近 ${days} 天 generation 总数`} icon="bolt" />
        <StatCard
          label="平均延迟"
          value={formatDuration(totalAvg)}
          hint="endTime − startTime"
          size="md"
          icon="clock"
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(totalP95)}
          hint="全部 generation 调用时长的 P95（调用级）"
          size="md"
          icon="gauge"
        />
        <StatCard
          label="错误率"
          value={`${(totalErrorRate * 100).toFixed(1)}%`}
          hint={`${totalErrors} ERROR · ${totalWarnings} WARNING`}
          tone="danger"
          icon="alert"
          title="ERROR generation 调用 / 全部 generation 调用（调用级口径）"
        />
      </div>

      <div className="grid grid-2">
        <StatCard
          label="Token 用量"
          value={formatTokens(totalTokens)}
          hint={`近 ${days} 天 generation 输入 + 输出`}
          size="md"
          icon="hash"
        />
        <StatCard
          label="总成本"
          value={formatCost(totalCost)}
          hint={`${costModels} 个模型有定价记录，按每百万 token 单价估算`}
          size="md"
          tone="success"
          icon="coin"
        />
      </div>

      <div className="section-title">
        {metricLabel}趋势（按模型堆叠）
      </div>
      <div className="card">
        <StackedBarChart data={trend} emptyText={`近 ${days} 天暂无 generation 调用`} />
      </div>

      <div className="section-title">
        延迟分布 <span className="count">当前窗口 · {totalLatencies.length} 次调用</span>
      </div>
      <div className="card">
        <BarChart data={histData} color="var(--purple)" emptyText="暂无延迟数据" />
      </div>

      {/* 归因入口：模型 / Agent 的对象视角已收敛到实体页，本页只做全局指标与趋势 */}
      <div className="section-title">
        归因入口{" "}
        <span className="count">对象视角收敛到实体页，避免同一对象多套口径</span>
      </div>
      <div className="card">
        <div className="muted">
          模型与 Agent 的调用量、Trace 数、成功率、错误率、P95、成本、分布与调用明细，
          已分别收敛到 <span className="mono">/models</span> 与{" "}
          <span className="mono">/agents</span>；本页专注全局指标、趋势与延迟分布。
          跳转后沿用同一时间窗（{days} 天）。
        </div>
        <div className="btn-group mt-2">
          <Link className="btn primary" href={`/models?days=${days}`} prefetch={false}>
            打开 Models 目录 →
          </Link>
          <Link className="btn" href={`/agents?days=${days}`} prefetch={false}>
            打开 Agents 目录 →
          </Link>
          <Link className="btn" href={`/analytics/topology?days=${days}`} prefetch={false}>
            Agent 拓扑 →
          </Link>
        </div>
        {models.length > 0 && (
          <div className="mt-2">
            <span className="mute2 text-sm">
              近 {days} 天模型（按调用量）：
            </span>{" "}
            {models.slice(0, 12).map((m) => (
              <Link
                key={m.name}
                href={`/models/${encodeURIComponent(m.name)}?days=${days}`}
                prefetch={false}
                className="mr-1"
                title={`查看 ${m.name} 详情`}
              >
                <span className="badge purple">{m.name}</span>
              </Link>
            ))}
            {models.length > 12 && (
              <span className="mute2 text-xs"> 等 {models.length} 个</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
