import { Link } from "../components/NativeLink";
import { StatCard } from "../components/StatCard";
import { Sparkline } from "../components/Sparkline";
import { SignalList } from "../components/SignalList";
import { deltaCell } from "../components/DeltaCell";
import { StackedBarChart } from "../components/StackedBarChart";
import { BarChart } from "../components/BarChart";
import { formatDuration, formatCost, formatTokens } from "../lib/format";
import { getOverview } from "../server/overview";
import { emptyStat, type ModelStat } from "../server/agentStats";
import { and, gte, inArray } from "drizzle-orm";
import { db, observation } from "@machora/shared";

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

/** 延迟直方图分桶（调用级，与 Models / Agents 详情的口径一致） */
const LATENCY_BUCKETS: { label: string; max: number }[] = [
  { label: "<100ms", max: 100 },
  { label: "<250ms", max: 250 },
  { label: "<500ms", max: 500 },
  { label: "<1s", max: 1000 },
  { label: "<2s", max: 2000 },
  { label: "<5s", max: 5000 },
  { label: "≥5s", max: Infinity },
];

/**
 * Overview：唯一回答「现在健不健康、有什么要处理」的页面。
 * 区域固定为：页头结论 → 时间窗 → 健康条 → 待处理 → 趋势主轴 → 延迟分布 → 资源聚焦 → 下钻入口 → 接入指引。
 * 对象级明细不在此重复，统一收敛到 /agents、/models、/generations、/topology。
 */
export default async function Home({
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

  const port = process.env.PORT ?? "3100";

  const {
    totals,
    prevTotals,
    watchlist,
    daily,
    agents,
    topCost,
    topLatency,
    errorTraces,
  } = await getOverview(days);

  // 趋势主轴 + 延迟分布：按模型归集的 generation 调用（原 /analytics 总览内容）
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);

  const gens = await db
    .select({
      model: observation.model,
      startTime: observation.startTime,
      endTime: observation.endTime,
      totalTokens: observation.totalTokens,
      totalCost: observation.totalCost,
    })
    .from(observation)
    .where(
      and(
        inArray(observation.type, ["LLM", "EMBEDDING"]),
        gte(observation.startTime, since),
      ),
    );

  const perDay = new Map<string, Map<string, ModelStat>>();
  const modelTotals = new Map<string, ModelStat>();
  for (const g of gens) {
    const model = g.model ?? "unknown";
    const dur = g.endTime ? g.endTime.getTime() - g.startTime.getTime() : null;

    const dayIdx = Math.floor((g.startTime.getTime() - since.getTime()) / DAY_MS);
    const dayStart = new Date(since.getTime() + Math.max(dayIdx, 0) * DAY_MS);
    const key = `${dayStart.getMonth() + 1}/${dayStart.getDate()}`;
    const dayMap = perDay.get(key) ?? new Map<string, ModelStat>();
    const ds = dayMap.get(model) ?? emptyStat();
    ds.count++;
    if (dur != null) ds.latencies.push(dur);
    ds.tokens += g.totalTokens ?? 0;
    ds.cost += g.totalCost ?? 0;
    dayMap.set(model, ds);
    perDay.set(key, dayMap);

    const ms = modelTotals.get(model) ?? emptyStat();
    ms.count++;
    if (dur != null) ms.latencies.push(dur);
    ms.tokens += g.totalTokens ?? 0;
    ms.cost += g.totalCost ?? 0;
    modelTotals.set(model, ms);
  }

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

  const totalLatencies = Array.from(modelTotals.values())
    .flatMap((m) => m.latencies)
    .sort((a, b) => a - b);
  const histData = LATENCY_BUCKETS.map((b, i) => {
    const prevMax = i === 0 ? 0 : LATENCY_BUCKETS[i - 1].max;
    return {
      label: b.label,
      value: totalLatencies.filter((l) => l > prevMax && l <= b.max).length,
    };
  });

  const genTokens = Array.from(modelTotals.values()).reduce(
    (s, m) => s + m.tokens,
    0,
  );
  const modelNames = Array.from(modelTotals.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name]) => name);
  const riskyAgents = agents.filter((a) => a.flags.length > 0).slice(0, 3);
  const highCount = watchlist.filter((s) => s.severity === "high").length;
  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "调用量";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub">
            近 {days} 天 · {totals.traces} 条 Trace · {totals.calls} 次模型调用 ·{" "}
            {formatTokens(genTokens)} tokens ·{" "}
            {watchlist.length > 0 ? (
              <span className="text-danger">
                {watchlist.length} 项待处理
                {highCount > 0 ? `（${highCount} 项高优）` : ""}
              </span>
            ) : (
              <span className="text-success">未检测到异常</span>
            )}
          </div>
        </div>
        <Link className="btn" href="/docs" prefetch={false}>
          接入文档 →
        </Link>
      </div>

      <div className="seg mb-3">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/?${buildQuery(d, metric)}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {/* 健康条：窗口总量 + 明确的基线对比（前一等长窗口）+ 窗口内每日迷你折线 */}
      <div className="grid grid-5">
        <StatCard
          label="Trace 数"
          value={totals.traces}
          hint={<>对比前 {days} 天 {deltaCell(totals.traces, prevTotals.traces)}</>}
          icon="list"
          accent
          title={`该窗口内的 trace 数（一个 trace = 一次完整链路执行）；前一窗口 ${prevTotals.traces} 条`}
          chart={
            <Sparkline
              fit
              data={daily.map((d) => d.traces)}
              title={`近 ${days} 天每日 Trace 数`}
            />
          }
        />
        <StatCard
          label="模型调用"
          value={totals.calls}
          hint={<>对比前 {days} 天 {deltaCell(totals.calls, prevTotals.calls)}</>}
          icon="bolt"
          title={`LLM / Embedding 类调用条数（一个 trace 含多次）；前一窗口 ${prevTotals.calls} 次`}
          chart={
            <Sparkline
              fit
              color="var(--purple)"
              data={daily.map((d) => d.calls)}
              title={`近 ${days} 天每日模型调用`}
            />
          }
        />
        <StatCard
          label="总成本"
          value={formatCost(totals.cost)}
          hint={<>对比前 {days} 天 {deltaCell(totals.cost, prevTotals.cost)}</>}
          tone="success"
          icon="coin"
          title={`窗口内 observation.totalCost 合计；前一窗口 ${formatCost(prevTotals.cost)}`}
          chart={
            <Sparkline
              fit
              color="var(--green)"
              data={daily.map((d) => d.cost)}
              title={`近 ${days} 天每日成本`}
            />
          }
        />
        <StatCard
          label="错误率"
          value={`${(totals.errorRate * 100).toFixed(1)}%`}
          hint={<>对比前 {days} 天 {deltaCell(totals.errorRate, prevTotals.errorRate)}</>}
          tone="danger"
          icon="alert"
          title={`ERROR 步骤 / 全部步骤 observation（步骤级口径）；前一窗口 ${(prevTotals.errorRate * 100).toFixed(1)}%`}
          chart={
            <Sparkline
              fit
              color="var(--red)"
              data={daily.map((d) => d.errorRate)}
              title={`近 ${days} 天每日错误率`}
            />
          }
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(totals.p95)}
          hint={<>对比前 {days} 天 {deltaCell(totals.p95, prevTotals.p95)}</>}
          icon="clock"
          title={`全部步骤 observation 时长的 P95（含容器 span，口径接近 trace 级）；前一窗口 ${formatDuration(prevTotals.p95)}`}
          chart={
            <Sparkline
              fit
              color="var(--amber)"
              data={daily.map((d) => d.p95 ?? 0)}
              title={`近 ${days} 天每日 P95 延迟`}
            />
          }
        />
      </div>

      {/* 待处理：全局 / Agent / 模型 / 轨迹信号合并呈现，阈值统一由 signals.ts 判定 */}
      <div className="section-title">
        待处理{" "}
        <span className="count">对比前 {days} 天 · 阈值统一由 signals.ts 判定</span>
      </div>
      {watchlist.length === 0 ? (
        <div className="card mb-3">
          <span className="badge green">✓ 未检测到异常</span>{" "}
          <span className="mute2 text-sm">
            成本、延迟、错误率与轨迹信号均未出现显著恶化。
          </span>
        </div>
      ) : (
        <div className="card alert-danger mb-3">
          <SignalList signals={watchlist} dismissKey="machora:dismissed-signals" />
        </div>
      )}

      {/* 趋势主轴：Overview 的核心区域，按模型堆叠，可切换指标 */}
      <div className="section-title">
        {metricLabel}趋势 <span className="count">按模型堆叠 · 近 {days} 天</span>
        <span className="spacer" />
        <span className="seg">
          {METRICS.map((m) => (
            <Link
              key={m.key}
              href={`/?${buildQuery(days, m.key)}`}
              prefetch={false}
              className={m.key === metric ? "seg-btn active" : "seg-btn"}
              aria-current={m.key === metric ? "true" : undefined}
            >
              {m.label}
            </Link>
          ))}
        </span>
      </div>
      <div className="card">
        <StackedBarChart data={trend} emptyText={`近 ${days} 天暂无 generation 调用`} />
      </div>

      <div className="section-title">
        延迟分布{" "}
        <span className="count">当前窗口 · {totalLatencies.length} 次调用（调用级）</span>
      </div>
      <div className="card">
        <BarChart data={histData} color="var(--purple)" emptyText="暂无延迟数据" />
      </div>

      {/* 资源聚焦：只看 Top 3，完整榜单与对象明细收敛到实体页 */}
      <div className="section-title">
        资源聚焦 <span className="count">近 {days} 天 · Top 3 与异常 Agent</span>
      </div>
      <div className="grid grid-4">
        <div className="card">
          <div className="label">最贵 Trace</div>
          {topCost.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无成本数据
            </div>
          ) : (
            topCost.slice(0, 3).map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id.slice(0, 8)}</span>}
                </Link>
                <span className="mono cost nowrap">{formatCost(x.cost)}</span>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="label">最慢 Trace</div>
          {topLatency.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无耗时数据
            </div>
          ) : (
            topLatency.slice(0, 3).map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id.slice(0, 8)}</span>}
                </Link>
                <span
                  className={`mono nowrap ${
                    (x.latency ?? 0) >= 8000
                      ? "latency-high"
                      : (x.latency ?? 0) >= 2000
                        ? "latency-mid"
                        : "latency-low"
                  }`}
                >
                  {formatDuration(x.latency)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="label">错误最多 Trace</div>
          {errorTraces.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              没有出错的 trace
            </div>
          ) : (
            errorTraces.slice(0, 3).map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id.slice(0, 8)}</span>}
                </Link>
                <span className="badge red nowrap">{x.errors} ERROR</span>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="label">异常 Agent</div>
          {riskyAgents.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              没有带标记的 Agent
            </div>
          ) : (
            riskyAgents.map((a) => (
              <div key={a.name} className="stat-list-item">
                <Link
                  href={`/agents/${encodeURIComponent(a.name)}?days=${days}`}
                  prefetch={false}
                >
                  {a.name}
                </Link>
                <span className="nowrap">
                  {a.flags.map((f) => (
                    <span key={f} className="badge amber">
                      {f}
                    </span>
                  ))}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="section-title">
        下钻入口 <span className="count">对象级明细收敛到实体页，避免同一对象多套口径</span>
      </div>
      <div className="card">
        <div className="btn-group">
          <Link className="btn primary" href={`/models?days=${days}`} prefetch={false}>
            打开 Models 目录 →
          </Link>
          <Link className="btn" href={`/agents?days=${days}`} prefetch={false}>
            打开 Agents 目录 →
          </Link>
          <Link className="btn" href={`/generations?days=${days}`} prefetch={false}>
            Generations 明细 →
          </Link>
          <Link className="btn" href={`/topology?days=${days}`} prefetch={false}>
            Agent 拓扑 →
          </Link>
        </div>
        {modelNames.length > 0 && (
          <div className="mt-2">
            <span className="mute2 text-sm">近 {days} 天模型（按调用量）：</span>{" "}
            {modelNames.slice(0, 12).map((m) => (
              <Link
                key={m}
                href={`/models/${encodeURIComponent(m)}?days=${days}`}
                prefetch={false}
                className="mr-1"
                title={`查看 ${m} 详情`}
              >
                <span className="badge purple">{m}</span>
              </Link>
            ))}
            {modelNames.length > 12 && (
              <span className="mute2 text-xs"> 等 {modelNames.length} 个</span>
            )}
          </div>
        )}
      </div>

      <details className="card mt-3">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          快速接入（OTLP）
        </summary>
        <div className="muted mt-2">
          把任意 OTel SDK 的 traces 端点指向本服务即可：
        </div>
        <pre className="code">
{`export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:${port}/api/public/otel/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf

# 带上 agent 语义属性即可聚合到 Agent 维度：
#   gen_ai.agent.name / gen_ai.agent.version
#   machora.agent.name / machora.agent.version`}
        </pre>
        <div className="muted mt-2">
          <Link href="/docs" prefetch={false}>完整接入文档 →</Link> ·{" "}
          <Link href="/api/public/health" prefetch={false}>健康检查</Link> ·{" "}
          <Link href="/traces" prefetch={false}>查看全部 Traces →</Link>
        </div>
      </details>
    </>
  );
}
