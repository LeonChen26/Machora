import { Link } from "../../components/NativeLink";
import type { ReactNode } from "react";
import { prisma } from "@machora/shared";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";
import { StackedBarChart } from "../../components/StackedBarChart";
import { getCurrentProjectId } from "../../server/project";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30];
const METRICS = [
  { key: "count", label: "调用量" },
  { key: "tokens", label: "Token" },
  { key: "cost", label: "成本" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

interface ModelStat {
  count: number;
  latencies: number[];
  errors: number;
  warnings: number;
  tokens: number;
  cost: number;
}

function emptyStat(): ModelStat {
  return { count: 0, latencies: [], errors: 0, warnings: 0, tokens: 0, cost: 0 };
}

function summarize(m: ModelStat) {
  const sorted = [...m.latencies].sort((a, b) => a - b);
  const avg = sorted.length
    ? sorted.reduce((s, x) => s + x, 0) / sorted.length
    : null;
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : null;
  return {
    count: m.count,
    avg,
    p95,
    errors: m.errors,
    warnings: m.warnings,
    errorRate: m.count ? m.errors / m.count : 0,
    tokens: m.tokens,
    cost: m.cost,
  };
}

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

  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 当前窗口（含今天）与等长的前窗口，用于趋势与异常对比
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevEnd = since;
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  const gens = await prisma.observation.findMany({
    where: {
      projectId,
      type: "GENERATION",
      startTime: { gte: prevSince },
    },
    select: {
      model: true,
      agentName: true,
      startTime: true,
      endTime: true,
      level: true,
      totalTokens: true,
      totalCost: true,
    },
  });

  // 按窗口拆解
  const cur = new Map<string, ModelStat>();
  const prev = new Map<string, ModelStat>();
  // 每日 × 模型 趋势（仅当前窗口）
  const perDay = new Map<string, Map<string, ModelStat>>();
  for (const g of gens) {
    const model = g.model ?? "unknown";
    const isCur = g.startTime >= since;
    if (isCur) {
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

  // 按 Agent 聚合（agentName 为空归 "unknown"），当前 + 前窗口
  const agentCur = new Map<string, ModelStat>();
  const agentPrev = new Map<string, ModelStat>();
  for (const g of gens) {
    const agent = g.agentName ?? "unknown";
    const target = g.startTime >= since ? agentCur : agentPrev;
    const s = target.get(agent) ?? emptyStat();
    s.count++;
    if (g.endTime) s.latencies.push(g.endTime.getTime() - g.startTime.getTime());
    if (g.level === "ERROR") s.errors++;
    if (g.level === "WARNING") s.warnings++;
    s.tokens += g.totalTokens ?? 0;
    s.cost += g.totalCost ?? 0;
    target.set(agent, s);
  }
  const agentSummary = new Map(
    Array.from(agentCur.entries()).map(([name, s]) => [name, summarize(s)]),
  );
  const agentPrevSummary = new Map(
    Array.from(agentPrev.entries()).map(([name, s]) => [name, summarize(s)]),
  );
  const agents = Array.from(agentSummary.entries())
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => b.count - a.count);

  // 异常检测：当前窗口 vs 前窗口
  const anomalies = new Map<string, string[]>();
  for (const [name, c] of curSummary) {
    const p = prevSummary.get(name);
    if (!p || p.count === 0) continue;
    const flags: string[] = [];
    // 成本突增：>1.5 倍且增量 ≥ $0.005
    if (p.cost >= 0.005 && c.cost >= p.cost * 1.5 && c.cost - p.cost >= 0.005) {
      flags.push(
        `成本 ${formatCost(p.cost)} → ${formatCost(c.cost)}（↑${Math.round((c.cost / p.cost - 1) * 100)}%）`,
      );
    }
    // 错误率上升：样本 ≥3，绝对上升 ≥10 个百分点
    if (
      p.count >= 3 &&
      c.count >= 3 &&
      c.errorRate >= p.errorRate + 0.1 &&
      c.errorRate >= 0.1
    ) {
      flags.push(
        `错误率 ${(p.errorRate * 100).toFixed(0)}% → ${(c.errorRate * 100).toFixed(0)}%`,
      );
    }
    // 延迟恶化：P95 放大 1.5 倍且增量 ≥500ms
    if (
      p.count >= 3 &&
      c.count >= 3 &&
      p.p95 != null &&
      c.p95 != null &&
      c.p95 >= p.p95 * 1.5 &&
      c.p95 - p.p95 >= 500
    ) {
      flags.push(
        `P95 ${formatDuration(p.p95)} → ${formatDuration(c.p95)}`,
      );
    }
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
                : s.cost,
        }))
        .filter((x) => x.value > 0),
    };
  });

  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "调用量";

  // 变化率渲染 helper
  function delta(a: number | null, b: number | null): number | null {
    if (a == null || b == null) return null;
    if (a === 0) return null;
    return (b - a) / a;
  }
  function pct(v: number): string {
    const r = v * 100;
    return `${r >= 0 ? "↑" : "↓"}${Math.abs(r).toFixed(0)}%`;
  }
  function deltaCell(cur: number | null, prev: number | null): ReactNode {
    const d = delta(prev, cur);
    if (d == null) return <span className="mute2">—</span>;
    return (
      <span style={{ color: d > 0.05 ? "var(--red)" : d < -0.05 ? "var(--green)" : "var(--text-dim)", fontFamily: "var(--mono)" }} title="相对前一窗口">
        {pct(d)}
      </span>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>模型分析</h1>
          <div className="sub">
            近 {days} 天 · {total} 次 generation 调用 · {models.length} 个模型 ·{" "}
            {formatTokens(totalTokens)} tokens · <span style={{ color: "var(--green)" }}>{formatCost(totalCost)}</span>
          </div>
        </div>
      </div>

      {/* 时间窗切换 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/analytics?${buildQuery(d, metric)}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {/* 趋势维度切换 */}
      <div className="seg" style={{ marginTop: "0.5rem" }}>
        {METRICS.map((m) => (
          <Link
            key={m.key}
            href={`/analytics?${buildQuery(days, m.key)}`}
            prefetch={false}
            className={m.key === metric ? "seg-btn active" : "seg-btn"}
          >
            {m.label}
          </Link>
        ))}
      </div>

      {/* 异常告警 */}
      {anomalies.size > 0 && (
        <div
          className="card"
          style={{ marginTop: "1rem", borderColor: "var(--red)" }}
        >
          <div className="label" style={{ color: "var(--red)" }}>
            异常检测（对比前 {days} 天）
          </div>
          {Array.from(anomalies.entries()).map(([name, flags]) => (
            <div key={name} style={{ marginTop: 6, fontSize: 13 }}>
              <span className="badge purple">{name}</span>{" "}
              {flags.map((f) => (
                <span key={f} className="badge red" style={{ marginLeft: 6 }}>
                  {f}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-4">
        <div className="card">
          <div className="label">调用量</div>
          <div className="value">{total}</div>
          <div className="hint">近 {days} 天 generation 总数</div>
        </div>
        <div className="card">
          <div className="label">平均延迟</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(totalAvg)}
          </div>
          <div className="hint">endTime − startTime</div>
        </div>
        <div className="card">
          <div className="label">P95 延迟</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(totalP95)}
          </div>
          <div className="hint">95% 调用在此之内</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: "var(--red)" }}>
            {(totalErrorRate * 100).toFixed(1)}%
          </div>
          <div className="hint">
            {totalErrors} ERROR · {totalWarnings} WARNING
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatTokens(totalTokens)}
          </div>
          <div className="hint">近 {days} 天 generation 输入 + 输出</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 20, color: "var(--green)" }}>
            {formatCost(totalCost)}
          </div>
          <div className="hint">
            {costModels} 个模型有定价记录，按每百万 token 单价估算
          </div>
        </div>
      </div>

      <div className="section-title">
        {metricLabel}趋势（按模型堆叠）
      </div>
      <div className="card">
        <StackedBarChart data={trend} emptyText={`近 ${days} 天暂无 generation 调用`} />
      </div>

      <div className="section-title">
        按模型汇总 <span className="count">对比列 = 相对前 {days} 天的变化</span>
      </div>
      {models.length === 0 ? (
        <div className="card empty">
          <div className="icon">▦</div>
          暂无数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>调用数</th>
                <th>变化</th>
                <th>Token</th>
                <th>成本</th>
                <th>成本变化</th>
                <th>平均延迟</th>
                <th>P95</th>
                <th>P95 变化</th>
                <th>ERROR</th>
                <th>WARNING</th>
                <th>错误率</th>
                <th>错误率变化</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const p = prevSummary.get(m.name);
                const flagged = anomalies.has(m.name);
                return (
                  <tr key={m.name} style={flagged ? { background: "color-mix(in srgb, var(--red) 6%, transparent)" } : undefined}>
                    <td>
                      <Link
                        href={`/analytics/models?model=${encodeURIComponent(m.name)}&days=${days}`}
                        prefetch={false}
                        title={`查看 ${m.name} 明细`}
                      >
                        <span className="badge purple">{m.name}</span>
                      </Link>
                      {flagged && <span className="badge red" style={{ marginLeft: 6 }}>!</span>}
                    </td>
                    <td className="mono">{m.count}</td>
                    <td>{deltaCell(m.count, p?.count ?? null)}</td>
                    <td className="mono">{formatTokens(m.tokens)}</td>
                    <td className="mono" style={{ color: m.cost > 0 ? "var(--green)" : undefined }}>
                      {formatCost(m.cost)}
                    </td>
                    <td>{deltaCell(m.cost, p?.cost ?? null)}</td>
                    <td className="mono">{formatDuration(m.avg)}</td>
                    <td className="mono">{formatDuration(m.p95)}</td>
                    <td>{deltaCell(m.p95, p?.p95 ?? null)}</td>
                    <td>
                      {m.errors > 0 ? (
                        <span className="badge red">{m.errors}</span>
                      ) : (
                        <span className="mute2">0</span>
                      )}
                    </td>
                    <td>
                      {m.warnings > 0 ? (
                        <span className="badge amber">{m.warnings}</span>
                      ) : (
                        <span className="mute2">0</span>
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          color:
                            m.errorRate >= 0.1
                              ? "var(--red)"
                              : m.errorRate > 0
                                ? "var(--amber)"
                                : "var(--green)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {(m.errorRate * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td>{deltaCell(m.errorRate, p?.errorRate ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="section-title" style={{ marginTop: "1.5rem" }}>
        按 Agent 汇总 <span className="count">gen_ai.agent.name 维度 · 空值归 unknown</span>
      </div>
      {agents.length === 0 ? (
        <div className="card empty">
          <div className="icon">▦</div>
          暂无数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>调用数</th>
                <th>变化</th>
                <th>Token</th>
                <th>成本</th>
                <th>成本变化</th>
                <th>平均延迟</th>
                <th>ERROR</th>
                <th>WARNING</th>
                <th>错误率</th>
                <th>错误率变化</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const p = agentPrevSummary.get(a.name);
                return (
                  <tr key={a.name}>
                    <td>
                      <Link
                        href={`/analytics/agents?name=${encodeURIComponent(a.name)}&days=${days}`}
                        prefetch={false}
                        title={`查看 ${a.name} 明细`}
                      >
                        <span className="badge green">{a.name}</span>
                      </Link>
                    </td>
                    <td className="mono">{a.count}</td>
                    <td>{deltaCell(a.count, p?.count ?? null)}</td>
                    <td className="mono">{formatTokens(a.tokens)}</td>
                    <td className="mono" style={{ color: a.cost > 0 ? "var(--green)" : undefined }}>
                      {formatCost(a.cost)}
                    </td>
                    <td>{deltaCell(a.cost, p?.cost ?? null)}</td>
                    <td className="mono">{formatDuration(a.avg)}</td>
                    <td>
                      {a.errors > 0 ? (
                        <span className="badge red">{a.errors}</span>
                      ) : (
                        <span className="mute2">0</span>
                      )}
                    </td>
                    <td>
                      {a.warnings > 0 ? (
                        <span className="badge amber">{a.warnings}</span>
                      ) : (
                        <span className="mute2">0</span>
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          color:
                            a.errorRate >= 0.1
                              ? "var(--red)"
                              : a.errorRate > 0
                                ? "var(--amber)"
                                : "var(--green)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        {(a.errorRate * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td>{deltaCell(a.errorRate, p?.errorRate ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
