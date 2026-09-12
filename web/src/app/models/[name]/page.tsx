import { Link } from "../../../components/NativeLink";
import { notFound } from "next/navigation";
import { EmptyIcon } from "../../../components/EmptyIcon";
import { StatCard } from "../../../components/StatCard";
import { BarChart } from "../../../components/BarChart";
import { Pager } from "../../../components/Pager";
import { deltaCell } from "../../../components/DeltaCell";
import {
  formatDateTime,
  formatRelative,
  formatDuration,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { levelBadge } from "../../../lib/levelBadge";
import {
  MODEL_CALL_PAGE_SIZE,
  MODEL_DAY_OPTIONS,
  MODEL_UNKNOWN,
  getModelDetail,
} from "../../../server/modelStats";

export const dynamic = "force-dynamic";

const DAY_OPTIONS: readonly number[] = MODEL_DAY_OPTIONS;

// 趋势可切指标：调用量 / Trace 数 / 成本 / 错误率
const METRICS = [
  { key: "calls", label: "调用量", color: "var(--purple)" },
  { key: "traces", label: "Trace 数", color: "var(--sky)" },
  { key: "cost", label: "成本", color: "var(--green)" },
  { key: "errorRate", label: "错误率", color: "var(--red)" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function errGrade(rate: number): "high" | "mid" | "low" {
  return rate >= 0.1 ? "high" : rate > 0 ? "mid" : "low";
}

export default async function ModelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { name } = await params;
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : DAY_OPTIONS[0]!;
  const rawMetric = str(sp.metric) as MetricKey | undefined;
  const metric: MetricKey = METRICS.some((m) => m.key === rawMetric)
    ? (rawMetric as MetricKey)
    : "calls";
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  const detail = await getModelDetail(name, days, page);
  if (!detail) notFound();

  const {
    metrics,
    prev,
    daily,
    agents,
    calls,
    callTotal,
    sessions,
    scores,
  } = detail;

  const pageCount = Math.max(1, Math.ceil(callTotal / MODEL_CALL_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const failures =
    metrics.successRate === null
      ? 0
      : Math.round(metrics.traces * (1 - metrics.successRate));

  const metricDef = METRICS.find((m) => m.key === metric)!;
  const trendData = daily.map((d) => ({
    label: d.label,
    value:
      metric === "calls"
        ? d.calls
        : metric === "traces"
          ? d.traces
          : metric === "cost"
            ? Number(d.cost.toFixed(4))
            : Number((d.errorRate * 100).toFixed(1)),
  }));

  const detailHref = (d: number, m: MetricKey, p = 1) =>
    `/models/${encodeURIComponent(name)}?days=${d}&metric=${m}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      <div className="breadcrumb">
        <Link href="/models" prefetch={false}>
          Models
        </Link>
        <span className="mute2">/</span>
        <span className="mono muted">{name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="badge purple">{name}</span>
          </h1>
          <div className="sub">
            近 {days} 天 · {metrics.calls} 次模型调用 · {metrics.traces} 个 trace ·{" "}
            {formatTokens(metrics.tokens)} tokens ·{" "}
            <span className="cost">{formatCost(metrics.cost)}</span>
          </div>
        </div>
        <Link className="btn" href="/models" prefetch={false}>
          ← 返回 Models
        </Link>
      </div>

      {/* 时间窗 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/models/${encodeURIComponent(name)}?days=${d}&metric=${metric}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {metrics.calls === 0 && (
        <div className="card empty mt-3">
          <EmptyIcon type="grid" />
          近 {days} 天该模型无调用。切换到更长的时间窗，或确认接入方仍在上报。
        </div>
      )}

      {/* 概览指标 */}
      <div className="grid grid-4 mt-3">
        <StatCard
          label="调用量"
          value={metrics.calls}
          hint={<>环比 {deltaCell(metrics.calls, prev?.calls ?? null)}</>}
          icon="bolt"
          title="LLM / Embedding 类调用条数"
        />
        <StatCard
          label="Trace 数"
          value={metrics.traces}
          hint={<>环比 {deltaCell(metrics.traces, prev?.traces ?? null)}</>}
          icon="list"
          title="含该模型调用的去重 trace 数"
        />
        <StatCard
          label="成功率"
          value={
            metrics.successRate === null
              ? "—"
              : `${(metrics.successRate * 100).toFixed(1)}%`
          }
          hint={`${failures} 个 trace 失败`}
          tone={
            metrics.successRate !== null && metrics.successRate < 0.9
              ? "danger"
              : "success"
          }
          icon="star"
          title="无 ERROR 的 trace 占比（trace 级口径）"
        />
        <StatCard
          label="总成本"
          value={formatCost(metrics.cost)}
          hint={<>环比 {deltaCell(metrics.cost, prev?.cost ?? null)}</>}
          tone="success"
          icon="coin"
        />
      </div>

      <div className="grid grid-4">
        <StatCard
          label="调用错误率"
          value={`${(metrics.errorRate * 100).toFixed(1)}%`}
          hint={`${metrics.errors} ERROR · ${metrics.warnings} WARNING`}
          tone="danger"
          icon="alert"
          title="ERROR 调用 / 全部模型调用（调用级口径）"
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(metrics.p95)}
          hint={<>环比 {deltaCell(metrics.p95, prev?.p95 ?? null)}</>}
          icon="gauge"
          title="模型调用时长的 P95（调用级口径）"
        />
        <StatCard
          label="平均延迟"
          value={formatDuration(metrics.avg)}
          hint={<>环比 {deltaCell(metrics.avg, prev?.avg ?? null)}</>}
          icon="clock"
        />
        <StatCard
          label="Token 用量"
          value={formatTokens(metrics.tokens)}
          hint={`平均 ${formatTokens(
            metrics.calls ? Math.round(metrics.tokens / metrics.calls) : 0,
          )} / 次调用`}
          icon="hash"
        />
      </div>

      {/* 每日趋势（可切指标） */}
      <div className="section-title">
        {metric === "errorRate" ? "错误率趋势（%）" : `${metricDef.label}趋势`}
        <span className="count">按天聚合 · 当前窗口</span>
        <span className="spacer" />
        <span className="seg">
          {METRICS.map((m) => (
            <Link
              key={m.key}
              href={detailHref(days, m.key)}
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
        <BarChart
          data={trendData}
          color={metricDef.color}
          emptyText={`近 ${days} 天暂无数据`}
          height={160}
        />
      </div>

      {/* 按 Agent 分布（模型 → Agent 交叉归因） */}
      <div className="section-title">
        按 Agent 分布{" "}
        <span className="count">
          归属 = trace.agentName ?? observation.agentName · 空值归 {MODEL_UNKNOWN}
        </span>
      </div>
      {agents.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          该模型近期无 Agent 归属数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">调用</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col" title="该 Agent 在本模型上的 ERROR 调用 / 调用数（调用级）">
                  错误率
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.name}>
                  <td>
                    {a.name === MODEL_UNKNOWN ? (
                      <span className="badge">{MODEL_UNKNOWN}</span>
                    ) : (
                      <Link
                        href={`/agents/${encodeURIComponent(a.name)}?days=${days}`}
                        prefetch={false}
                        title={`查看 Agent ${a.name} 详情`}
                      >
                        <span className="badge green">{a.name}</span>
                      </Link>
                    )}
                  </td>
                  <td className="mono">{a.calls}</td>
                  <td className="mono">{formatTokens(a.tokens)}</td>
                  <td className={a.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(a.cost)}
                  </td>
                  <td>
                    <span className="err-rate" data-grade={errGrade(a.errorRate)}>
                      {(a.errorRate * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 调用明细 */}
      <div className="section-title">
        调用明细{" "}
        <span className="count">
          共 {callTotal} 次调用 · 第 {safePage}/{pageCount} 页
        </span>
      </div>
      {callTotal === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          近 {days} 天该模型暂无调用。
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">Trace</th>
                  <th scope="col">Agent</th>
                  <th scope="col">耗时</th>
                  <th scope="col">级别</th>
                  <th scope="col">Token</th>
                  <th scope="col">成本</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr
                    key={c.id}
                    data-level={
                      c.level === "ERROR" || c.level === "WARNING"
                        ? c.level
                        : undefined
                    }
                  >
                    <td className="muted" title={formatDateTime(c.time)}>
                      {formatRelative(c.time)}
                    </td>
                    <td>
                      <Link href={`/traces/${c.traceId}`} prefetch={false}>
                        {c.traceName || (
                          <span className="mono muted">{c.traceId.slice(0, 8)}…</span>
                        )}
                      </Link>
                    </td>
                    <td>
                      {c.agent ? (
                        <Link
                          href={`/agents/${encodeURIComponent(c.agent)}?days=${days}`}
                          prefetch={false}
                        >
                          <span className="badge green">{c.agent}</span>
                        </Link>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">{formatDuration(c.latency)}</td>
                    <td>
                      <span className={`badge ${levelBadge(c.level)}`}>
                        {c.level}
                      </span>
                    </td>
                    <td className="mono">{formatTokens(c.tokens)}</td>
                    <td className={(c.cost ?? 0) > 0 ? "mono cost" : "mono"}>
                      {formatCost(c.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            info={`显示 ${(safePage - 1) * MODEL_CALL_PAGE_SIZE + 1}–${
              (safePage - 1) * MODEL_CALL_PAGE_SIZE + calls.length
            } / ${callTotal} 条 · 第 ${safePage}/${pageCount} 页`}
            prevHref={
              safePage > 1 ? detailHref(days, metric, safePage - 1) : undefined
            }
            nextHref={
              safePage < pageCount
                ? detailHref(days, metric, safePage + 1)
                : undefined
            }
            jump={{
              action: `/models/${encodeURIComponent(name)}`,
              page: safePage,
              totalPages: pageCount,
              hidden: (
                <>
                  <input type="hidden" name="days" value={days} />
                  <input type="hidden" name="metric" value={metric} />
                </>
              ),
            }}
          />
        </>
      )}

      {/* 关联会话 */}
      <div className="section-title">
        关联会话 <span className="count">{sessions.length} 个 · 当前窗口</span>
      </div>
      {sessions.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="clock" />
          该模型的 trace 未关联 sessionId。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Trace 数</th>
                <th scope="col">成本</th>
                <th scope="col">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <Link
                      href={`/sessions/${encodeURIComponent(s.sessionId)}`}
                      prefetch={false}
                    >
                      <span className="mono" title={s.sessionId}>
                        {s.sessionId.slice(0, 12)}
                        {s.sessionId.length > 12 ? "…" : ""}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="badge blue">{s.traces}</span>
                  </td>
                  <td className={s.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(s.cost)}
                  </td>
                  <td className="muted" title={formatDateTime(s.last)}>
                    {formatRelative(s.last)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 评分 */}
      {scores.length > 0 && (
        <>
          <div className="section-title">
            评分汇总{" "}
            <span className="count">挂在该模型 trace 上的 Score · 当前窗口</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">评分</th>
                  <th scope="col">类型</th>
                  <th scope="col">数量</th>
                  <th scope="col">均值</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <span className="badge amber">{s.name}</span>
                    </td>
                    <td className="muted">{s.dataType}</td>
                    <td className="mono">{s.count}</td>
                    <td className="mono">
                      {s.dataType === "BOOLEAN"
                        ? `${(s.avg * 100).toFixed(0)}%`
                        : s.avg.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
