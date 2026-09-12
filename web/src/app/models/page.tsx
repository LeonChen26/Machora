import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Sparkline } from "../../components/Sparkline";
import { StatCard } from "../../components/StatCard";
import { deltaCell } from "../../components/DeltaCell";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";
import { MODEL_DAY_OPTIONS, getModelDirectory } from "../../server/modelStats";

export const dynamic = "force-dynamic";

const DAY_OPTIONS: readonly number[] = MODEL_DAY_OPTIONS;

// 错误率色阶（与 .err-rate 的 data-grade 对应）
function errGrade(rate: number): "high" | "mid" | "low" {
  return rate >= 0.1 ? "high" : rate > 0 ? "mid" : "low";
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : DAY_OPTIONS[0]!;

  const { models, totals, prevTotals, anomalies, unattributedCalls } =
    await getModelDirectory(days);

  const failures =
    totals.successRate === null
      ? 0
      : Math.round(totals.traces * (1 - totals.successRate));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Models</h1>
          <div className="sub">
            近 {days} 天 · {models.length} 个模型 · {totals.calls} 次模型调用 ·{" "}
            {totals.traces} 个 trace · {formatTokens(totals.tokens)} tokens ·{" "}
            <span className="cost">{formatCost(totals.cost)}</span>
            {unattributedCalls > 0 && (
              <> · {unattributedCalls} 次调用未标注 model（未计入下表）</>
            )}
          </div>
        </div>
      </div>

      {/* 时间窗 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={d === DAY_OPTIONS[0] ? "/models" : `/models?days=${d}`}
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
          label="模型数"
          value={models.length}
          hint={`近 ${days} 天有调用`}
          icon="boxes"
        />
        <StatCard
          label="模型调用"
          value={totals.calls}
          hint={<>环比 {deltaCell(totals.calls, prevTotals.calls)}</>}
          icon="bolt"
          title="LLM / Embedding 类调用条数（一个 trace 含多次）"
        />
        <StatCard
          label="Trace 数"
          value={totals.traces}
          hint={<>环比 {deltaCell(totals.traces, prevTotals.traces)}</>}
          icon="list"
          title="含该模型调用的去重 trace 数"
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
          label="调用错误率"
          value={`${(totals.errorRate * 100).toFixed(1)}%`}
          hint={`${totals.errors} ERROR · ${totals.warnings} WARNING`}
          tone="danger"
          icon="alert"
          title="ERROR 调用 / 全部模型调用（调用级口径）"
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(totals.p95)}
          hint={<>环比 {deltaCell(totals.p95, prevTotals.p95)}</>}
          icon="gauge"
          title="模型调用时长的 P95（调用级口径）"
        />
        <StatCard
          label="Token 用量"
          value={formatTokens(totals.tokens)}
          hint={`近 ${days} 天模型调用输入 + 输出`}
          icon="hash"
        />
      </div>

      <div className="section-title">
        按模型汇总{" "}
        <span className="count">
          归属 = observation.model · 点击进入详情
        </span>
      </div>
      {models.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无模型调用数据。注入的 LLM / Embedding observation 带上 model 即可聚合。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">模型</th>
                <th scope="col">调用</th>
                <th scope="col">Trace 数</th>
                <th scope="col">成功率</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col" title="ERROR 调用 / 全部模型调用（调用级）">错误率</th>
                <th scope="col" title="模型调用时长的 P95（调用级）">P95</th>
                <th scope="col">近 {days} 天</th>
                <th scope="col">标记</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={m.name}
                  className={m.flags.length > 0 ? "is-anomaly" : undefined}
                >
                  <td>
                    <Link
                      href={`/models/${encodeURIComponent(m.name)}?days=${days}`}
                      prefetch={false}
                      title={`查看 ${m.name} 详情`}
                    >
                      <span className="badge purple">{m.name}</span>
                    </Link>
                  </td>
                  <td className="mono">
                    {m.calls}
                    {m.prev !== null && (
                      <span className="mute2 text-xs"> /{m.prev.calls}</span>
                    )}
                  </td>
                  <td className="mono">
                    {m.traces}
                    {m.prev !== null && (
                      <span className="mute2 text-xs"> /{m.prev.traces}</span>
                    )}
                  </td>
                  <td className="mono">
                    {m.successRate === null ? (
                      <span className="mute2">—</span>
                    ) : (
                      <span
                        className={m.successRate < 0.9 ? "text-danger" : undefined}
                      >
                        {(m.successRate * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="mono">{formatTokens(m.tokens)}</td>
                  <td className={m.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(m.cost)}
                  </td>
                  <td>
                    <span className="err-rate" data-grade={errGrade(m.errorRate)}>
                      {(m.errorRate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="mono">{formatDuration(m.p95)}</td>
                  <td>
                    <Sparkline
                      data={m.daily}
                      title={`${m.name} 近 ${days} 天每日调用量`}
                    />
                  </td>
                  <td>
                    {m.flags.length === 0 ? (
                      <span className="mute2">—</span>
                    ) : (
                      m.flags.map((f) => (
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
