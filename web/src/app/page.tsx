import { Link } from "../components/NativeLink";
import { EmptyIcon } from "../components/EmptyIcon";
import { StatCard } from "../components/StatCard";
import { Sparkline } from "../components/Sparkline";
import { SignalList } from "../components/SignalList";
import { deltaCell } from "../components/DeltaCell";
import { formatDuration, formatCost } from "../lib/format";
import { getOverview } from "../server/overview";

export const dynamic = "force-dynamic";

const DAYS = 7;

export default async function Home() {
  const port = process.env.PORT ?? "3100";
  const days = DAYS;

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub">
            近 {days} 天 · {totals.traces} 条 Trace · {agents.length} 个 Agent
          </div>
        </div>
        <Link className="btn primary" href="/docs" prefetch={false}>
          接入文档 →
        </Link>
      </div>

      {/* 待关注：全局 + Agent + 模型 + 轨迹信号，口径统一由 signals.ts 判定 */}
      {watchlist.length > 0 && (
        <div className="card alert-danger mb-3">
          <div className="card-head">
            <div className="label text-danger">待关注</div>
            <span className="mute2 text-xs">
              {watchlist.length} 项 · 对比前 {days} 天
            </span>
          </div>
          <div className="mt-1">
            <SignalList signals={watchlist} />
          </div>
        </div>
      )}

      {/* 指标面板：数值 + 环比 + 近 7 天迷你折线（合并原 KPI 行与趋势图） */}
      <div className="grid grid-5">
        <StatCard
          label="Trace 数"
          value={totals.traces}
          hint={<>环比 {deltaCell(totals.traces, prevTotals.traces)}</>}
          icon="list"
          accent
          title="该窗口内的 trace 数（一个 trace = 一次完整链路执行）"
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
          hint={<>环比 {deltaCell(totals.calls, prevTotals.calls)}</>}
          icon="bolt"
          title="LLM / Embedding 类调用条数（一个 trace 含多次）"
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
          hint={<>环比 {deltaCell(totals.cost, prevTotals.cost)}</>}
          tone="success"
          icon="coin"
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
          hint={<>环比 {deltaCell(totals.errorRate, prevTotals.errorRate)}</>}
          tone="danger"
          icon="alert"
          title="ERROR 步骤 / 全部步骤 observation（步骤级口径）"
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
          hint={<>环比 {deltaCell(totals.p95, prevTotals.p95)}</>}
          icon="clock"
          title="全部步骤 observation 时长的 P95（含容器 span，口径接近 trace 级）"
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

      <div className="section-title">
        Agent 风险榜{" "}
        <span className="count">
          按「是否有异常」优先排序 ·{" "}
          <Link href="/agents" prefetch={false}>
            查看全部 →
          </Link>
        </span>
      </div>

      {agents.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无数据。注入的 trace / observation 带上 agentName 即可聚合。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">版本</th>
                <th scope="col">Trace 数</th>
                <th scope="col">成功率</th>
                <th scope="col">调用数</th>
                <th scope="col">成本</th>
                <th scope="col" title="ERROR 步骤 / 全部步骤（步骤级）">错误率</th>
                <th scope="col" title="全部步骤 observation 时长的 P95">P95</th>
                <th scope="col">近 {days} 天</th>
                <th scope="col">标记</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.name}>
                  <td>
                    <Link
                      href={`/agents/${encodeURIComponent(a.name)}?days=${days}`}
                      prefetch={false}
                      title={`查看 ${a.name} 详情`}
                    >
                      <span className="badge green">{a.name}</span>
                    </Link>
                  </td>
                  <td>
                    {a.version ? (
                      <span className="badge purple">{a.version}</span>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="mono">{a.traces}</td>
                  <td className="mono">
                    {a.successRate === null ? (
                      <span className="mute2">—</span>
                    ) : (
                      <span
                        className={
                          a.successRate < 0.9 ? "text-danger" : undefined
                        }
                      >
                        {(a.successRate * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    {a.calls}
                    {a.prevCalls !== null && (
                      <span className="mute2 text-xs"> /{a.prevCalls}</span>
                    )}
                  </td>
                  <td className={a.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(a.cost)}
                  </td>
                  <td>
                    <span
                      className="err-rate"
                      data-grade={
                        a.errorRate >= 0.1
                          ? "high"
                          : a.errorRate > 0
                            ? "mid"
                            : "low"
                      }
                    >
                      {(a.errorRate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="mono">{formatDuration(a.p95)}</td>
                  <td>
                    <Sparkline
                      data={a.daily}
                      title={`${a.name} 近 ${days} 天每日调用量`}
                    />
                  </td>
                  <td>
                    {a.flags.length === 0 ? (
                      <span className="mute2">—</span>
                    ) : (
                      a.flags.map((f) => (
                        <span key={f} className="badge amber">
                          {f}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">
        需要关注{" "}
        <span className="count">
          近 {days} 天 ·{" "}
          <Link href="/traces" prefetch={false}>
            查看全部 Traces →
          </Link>
        </span>
      </div>
      <div className="grid grid-3">
        <div className="card">
          <div className="label">最贵</div>
          {topCost.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无成本数据
            </div>
          ) : (
            topCost.map((x) => (
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
          <div className="label">最慢</div>
          {topLatency.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无耗时数据
            </div>
          ) : (
            topLatency.map((x) => (
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
          <div className="label">错误最多</div>
          {errorTraces.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              没有出错的 trace
            </div>
          ) : (
            errorTraces.map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id.slice(0, 8)}</span>}
                </Link>
                <span className="badge red nowrap">{x.errors} ERROR</span>
              </div>
            ))
          )}
        </div>
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
