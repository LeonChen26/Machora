import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Sparkline } from "../../components/Sparkline";
import { StatCard } from "../../components/StatCard";
import { deltaCell } from "../../components/DeltaCell";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";
import { AGENT_DAY_OPTIONS, getAgentDirectory } from "../../server/agentStats";

export const dynamic = "force-dynamic";

const DAY_OPTIONS: readonly number[] = AGENT_DAY_OPTIONS;

// 错误率色阶（与 .err-rate 的 data-grade 对应）
function errGrade(rate: number): "high" | "mid" | "low" {
  return rate >= 0.1 ? "high" : rate > 0 ? "mid" : "low";
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : DAY_OPTIONS[0]!;

  const { agents, totals, prevTotals, anomalies } =
    await getAgentDirectory(days);

  const failures =
    totals.successRate === null
      ? 0
      : Math.round(totals.traces * (1 - totals.successRate));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <div className="sub">
            近 {days} 天 · {agents.length} 个 Agent · {totals.traces} 个 trace ·{" "}
            {totals.calls} 次模型调用 · {formatTokens(totals.tokens)} tokens ·{" "}
            <span className="cost">{formatCost(totals.cost)}</span>
          </div>
        </div>
      </div>

      {/* 时间窗 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={d === DAY_OPTIONS[0] ? "/agents" : `/agents?days=${d}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {/* 全局环比异常（整体口径，非按维度） */}
      {anomalies.length > 0 && (
        <div className="card alert-danger mt-3">
          <div className="label text-danger">异常检测（对比前 {days} 天）</div>
          <div className="text-md mt-1">{anomalies.join(" · ")}</div>
        </div>
      )}

      <div className="grid grid-4 mt-3">
        <StatCard
          label="Agent 数"
          value={agents.length}
          hint={`近 ${days} 天有活动`}
          icon="boxes"
        />
        <StatCard
          label="Trace 数"
          value={totals.traces}
          hint={<>环比 {deltaCell(totals.traces, prevTotals.traces)}</>}
          icon="list"
          title="该窗口内的 trace 数（一个 trace = 一次完整链路执行）"
        />
        <StatCard
          label="成功率"
          value={
            totals.successRate === null
              ? "—"
              : `${(totals.successRate * 100).toFixed(1)}%`
          }
          hint={`${failures} 个 trace 失败（trace ERROR 或含 ERROR 步骤）`}
          tone={
            totals.successRate !== null && totals.successRate < 0.9
              ? "danger"
              : "success"
          }
          icon="star"
          title="无 ERROR 的 trace 占比（trace 级口径）"
        />
        <StatCard
          label="模型调用"
          value={totals.calls}
          hint={<>环比 {deltaCell(totals.calls, prevTotals.calls)}</>}
          icon="bolt"
          title="LLM / Embedding 类调用条数（一个 trace 含多次）"
        />
      </div>

      <div className="grid grid-4">
        <StatCard
          label="总成本"
          value={formatCost(totals.cost)}
          hint={<>环比 {deltaCell(totals.cost, prevTotals.cost)}</>}
          tone="success"
          icon="coin"
        />
        <StatCard
          label="错误率"
          value={`${(totals.errorRate * 100).toFixed(1)}%`}
          hint={`${totals.errors} ERROR · ${totals.warnings} WARNING`}
          tone="danger"
          icon="alert"
          title="ERROR observation / 全部 observation（步骤级口径）"
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(totals.p95)}
          hint={<>环比 {deltaCell(totals.p95, prevTotals.p95)}</>}
          icon="gauge"
          title="全部步骤 observation 时长的 P95（含容器 span，口径接近 trace 级）"
        />
        <StatCard
          label="Token 用量"
          value={formatTokens(totals.tokens)}
          hint={`近 ${days} 天 observation 输入 + 输出`}
          icon="hash"
        />
      </div>

      <div className="section-title">
        按 Agent 汇总{" "}
        <span className="count">
          trace.agentName ?? observation.agentName · 空值归 unknown · 点击进入详情
        </span>
      </div>
      {agents.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无 Agent 数据。注入的 trace / observation 带上 agentName 即可聚合。
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
                <th scope="col">模型调用</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col" title="ERROR 步骤 / 全部步骤（步骤级）">错误率</th>
                <th scope="col" title="全部步骤 observation 时长的 P95">P95</th>
                <th scope="col">近 {days} 天</th>
                <th scope="col">标记</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr
                  key={a.name}
                  className={a.flags.length > 0 ? "is-anomaly" : undefined}
                >
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
                  <td className="mono">
                    {a.traces}
                    {a.prev !== null && (
                      <span className="mute2 text-xs"> /{a.prev.traces}</span>
                    )}
                  </td>
                  <td className="mono">
                    {a.successRate === null ? (
                      <span className="mute2">—</span>
                    ) : (
                      <span
                        className={a.successRate < 0.9 ? "text-danger" : undefined}
                      >
                        {(a.successRate * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    {a.calls}
                    {a.prev !== null && (
                      <span className="mute2 text-xs"> /{a.prev.calls}</span>
                    )}
                  </td>
                  <td className="mono">{formatTokens(a.tokens)}</td>
                  <td className={a.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(a.cost)}
                  </td>
                  <td>
                    <span className="err-rate" data-grade={errGrade(a.errorRate)}>
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
    </>
  );
}
