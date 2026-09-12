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
import {
  AGENT_DAY_OPTIONS,
  AGENT_TRACE_PAGE_SIZE,
  getAgentDetail,
} from "../../../server/agentStats";

export const dynamic = "force-dynamic";

const DAY_OPTIONS: readonly number[] = AGENT_DAY_OPTIONS;

const METRICS = [
  { key: "calls", label: "调用量", color: "var(--accent)" },
  { key: "traces", label: "Trace 数", color: "var(--sky)" },
  { key: "cost", label: "成本", color: "var(--green)" },
  { key: "errorRate", label: "错误率", color: "var(--red)" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function errGrade(rate: number): "high" | "mid" | "low" {
  return rate >= 0.1 ? "high" : rate > 0 ? "mid" : "low";
}

export default async function AgentDetailPage({
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

  const detail = await getAgentDetail(name, days, page);
  if (!detail) notFound();

  const {
    version,
    metrics,
    prev,
    daily,
    versions,
    tools,
    models,
    traces,
    traceTotal,
    sessions,
    scores,
  } = detail;

  const pageCount = Math.max(1, Math.ceil(traceTotal / AGENT_TRACE_PAGE_SIZE));
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
    `/agents/${encodeURIComponent(name)}?days=${d}&metric=${m}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      <div className="breadcrumb">
        <Link href="/agents" prefetch={false}>
          Agents
        </Link>
        <span className="mute2">/</span>
        <span className="mono muted">{name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="badge green">{name}</span>
            {version && (
              <>
                {" "}
                <span className="badge purple">{version}</span>
              </>
            )}
          </h1>
          <div className="sub">
            近 {days} 天 · {metrics.traces} 个 trace · {metrics.calls} 次模型调用 ·{" "}
            {formatTokens(metrics.tokens)} tokens ·{" "}
            <span className="cost">{formatCost(metrics.cost)}</span>
          </div>
        </div>
        <Link className="btn" href="/agents" prefetch={false}>
          ← 返回 Agents
        </Link>
      </div>

      {/* 时间窗 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/agents/${encodeURIComponent(name)}?days=${d}&metric=${metric}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      {metrics.traces === 0 && (
        <div className="card empty mt-3">
          <EmptyIcon type="grid" />
          近 {days} 天该 Agent 无 trace。切换到更长的时间窗，或确认接入方仍在上报。
        </div>
      )}

      {/* 概览指标 */}
      <div className="grid grid-4 mt-3">
        <StatCard
          label="Trace 数"
          value={metrics.traces}
          hint={<>环比 {deltaCell(metrics.traces, prev?.traces ?? null)}</>}
          icon="list"
          title="该窗口内的 trace 数（一个 trace = 一次完整链路执行）"
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
          label="模型调用"
          value={metrics.calls}
          hint={<>环比 {deltaCell(metrics.calls, prev?.calls ?? null)}</>}
          icon="bolt"
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
          label="错误率"
          value={`${(metrics.errorRate * 100).toFixed(1)}%`}
          hint={`${metrics.errors} ERROR · ${metrics.warnings} WARNING`}
          tone="danger"
          icon="alert"
          title="ERROR observation / 全部 observation（步骤级口径）"
        />
        <StatCard
          label="P95 延迟"
          value={formatDuration(metrics.p95)}
          hint={<>环比 {deltaCell(metrics.p95, prev?.p95 ?? null)}</>}
          icon="gauge"
          title="全部步骤 observation 时长的 P95（含容器 span，口径接近 trace 级）"
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
          hint={`${metrics.steps} 个步骤（observation）`}
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

      {/* 版本演进 */}
      <div className="section-title">
        版本演进{" "}
        <span className="count">按 trace.agentName.version 分组 · 当前窗口</span>
      </div>
      {versions.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          该 Agent 近期未上报运行版本（trace.agentVersion）。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">版本</th>
                <th scope="col">Trace 数</th>
                <th scope="col">成功率</th>
                <th scope="col">模型调用</th>
                <th scope="col">成本</th>
                <th scope="col" title="ERROR 步骤 / 全部步骤（步骤级）">错误率</th>
                <th scope="col">最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v, i) => (
                <tr
                  key={v.version ?? "__none__"}
                  className={i === 0 && versions.length > 1 ? "card-active" : undefined}
                >
                  <td>
                    {v.version ? (
                      <span className="badge purple">{v.version}</span>
                    ) : (
                      <span className="badge">未标注版本</span>
                    )}
                  </td>
                  <td className="mono">{v.traces}</td>
                  <td className="mono">
                    {v.successRate === null ? (
                      <span className="mute2">—</span>
                    ) : (
                      <span
                        className={v.successRate < 0.9 ? "text-danger" : undefined}
                      >
                        {(v.successRate * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="mono">{v.calls}</td>
                  <td className={v.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(v.cost)}
                  </td>
                  <td>
                    <span className="err-rate" data-grade={errGrade(v.errorRate)}>
                      {(v.errorRate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="muted" title={formatDateTime(v.last)}>
                    {formatRelative(v.last)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 工具与模型 */}
      <div className="section-title">
        工具与模型{" "}
        <span className="count">工具归属 = 轨迹分类器识别 · 模型 = LLM / Embedding 调用</span>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="label">工具调用 · {tools.length} 个</div>
          {tools.length === 0 ? (
            <div className="mute2 mt-1">该 Agent 近期无工具调用。</div>
          ) : (
            tools.slice(0, 12).map((t) => (
              <div key={t.name} className="stat-list-item">
                <span className="badge tool">{t.name}</span>
                <span className="mono nowrap">
                  {t.count} 次 · {formatDuration(t.avgDur)}
                  {t.errors > 0 && (
                    <>
                      {" "}
                      <span className="badge red">{t.errors} ERR</span>
                    </>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="label">模型调用 · {models.length} 个</div>
          {models.length === 0 ? (
            <div className="mute2 mt-1">该 Agent 近期无模型调用。</div>
          ) : (
            models.slice(0, 12).map((m) => (
              <div key={m.name} className="stat-list-item">
                <span className="badge purple">{m.name}</span>
                <span className="mono nowrap">
                  {m.count} 次 · {formatTokens(m.tokens)}
                  {m.cost > 0 && <> · <span className="cost">{formatCost(m.cost)}</span></>}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 调用明细 */}
      <div className="section-title">
        调用明细{" "}
        <span className="count">
          共 {traceTotal} 个 trace · 第 {safePage}/{pageCount} 页
        </span>
      </div>
      {traceTotal === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          近 {days} 天该 Agent 暂无 trace。
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">Trace</th>
                  <th scope="col">版本</th>
                  <th scope="col">耗时</th>
                  <th scope="col">调用</th>
                  <th scope="col">Token</th>
                  <th scope="col">成本</th>
                  <th scope="col">错误</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((t) => (
                  <tr
                    key={t.id}
                    data-level={t.errored ? "ERROR" : undefined}
                  >
                    <td className="muted" title={formatDateTime(t.timestamp)}>
                      {formatRelative(t.timestamp)}
                    </td>
                    <td>
                      <Link href={`/traces/${t.id}`} prefetch={false}>
                        {t.name || (
                          <span className="mono muted">{t.id.slice(0, 8)}…</span>
                        )}
                      </Link>
                    </td>
                    <td>
                      {t.version ? (
                        <span className="badge purple">{t.version}</span>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">{formatDuration(t.latency)}</td>
                    <td className="mono">{t.calls}</td>
                    <td className="mono">{formatTokens(t.tokens)}</td>
                    <td className={t.cost > 0 ? "mono cost" : "mono"}>
                      {formatCost(t.cost)}
                    </td>
                    <td>
                      {t.errors > 0 ? (
                        <span className="badge red">{t.errors}</span>
                      ) : (
                        <span className="mute2">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            info={`显示 ${(safePage - 1) * AGENT_TRACE_PAGE_SIZE + 1}–${
              (safePage - 1) * AGENT_TRACE_PAGE_SIZE + traces.length
            } / ${traceTotal} 条 · 第 ${safePage}/${pageCount} 页`}
            prevHref={
              safePage > 1 ? detailHref(days, metric, safePage - 1) : undefined
            }
            nextHref={
              safePage < pageCount
                ? detailHref(days, metric, safePage + 1)
                : undefined
            }
            jump={{
              action: `/agents/${encodeURIComponent(name)}`,
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
          该 Agent 的 trace 未关联 sessionId。
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
            <span className="count">挂在该 Agent trace 上的 Score · 当前窗口</span>
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
