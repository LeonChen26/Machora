import type { ReactNode } from "react";
import { Link } from "./NativeLink";
import { EmptyIcon } from "./EmptyIcon";
import {
  formatDateTime,
  formatRelative,
  formatDuration,
  formatTokens,
  formatCost,
} from "../lib/format";
import { levelBadge } from "../lib/levelBadge";

// analytics 下钻明细行（LLM/Embedding 观测的子集）
export type DrilldownGen = {
  id: string;
  level: string | null;
  startTime: Date;
  endTime: Date | null;
  totalTokens: number | null;
  totalCost: number | null;
  input: unknown;
  traceId: string | null;
  trace: { name: string | null } | null;
};

export type DrilldownStats = {
  count: number;
  avg: number | null;
  p95: number | null;
  errors: number;
  warnings: number;
  errorRate: number;
  tokens: number;
  cost: number;
};

// 统计聚合：延迟 avg/p95、错误率、token/成本合计
export function computeStats(list: DrilldownGen[]): DrilldownStats {
  const lat = list
    .map((g) => (g.endTime ? g.endTime.getTime() - g.startTime.getTime() : null))
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const avg = lat.length ? lat.reduce((s, x) => s + x, 0) / lat.length : null;
  const p95 = lat.length
    ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]
    : null;
  const errors = list.filter((g) => g.level === "ERROR").length;
  const warnings = list.filter((g) => g.level === "WARNING").length;
  return {
    count: list.length,
    avg,
    p95,
    errors,
    warnings,
    errorRate: list.length ? errors / list.length : 0,
    tokens: list.reduce((s, g) => s + (g.totalTokens ?? 0), 0),
    cost: list.reduce((s, g) => s + (g.totalCost ?? 0), 0),
  };
}

// 相对前窗变化率
function delta(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

function deltaHint(
  cur: number | null,
  prev: number | null,
  fmt: (v: number) => string,
): ReactNode {
  const d = delta(cur, prev);
  if (d == null) return <>前窗 —</>;
  const up = d > 0.02;
  return (
    <>
      前窗 {fmt(prev as number)} ·{" "}
      <span className={up ? "delta-up" : "delta-down"}>
        {d >= 0 ? "↑" : "↓"}
        {Math.abs(d * 100).toFixed(0)}%
      </span>
    </>
  );
}

function levelClass(level: string | null): string {
  return `badge ${levelBadge(level)}`.trim();
}

function inputSummary(input: unknown): string {
  if (input == null) return "—";
  let s: string;
  if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export type DrilldownViewProps = {
  // 维度值（agent 名 / 模型名）
  value: string;
  // 徽章颜色：agents 用 green，models 用 purple
  badgeClass: "green" | "purple";
  // 面包屑中段标签
  crumbLabel: string;
  // 空状态文案中的实体名（如 "agent" / "模型"）
  entityLabel: string;
  // 时间窗
  days: number;
  dayOptions: number[];
  // 下钻 base path + 查询参数名（name / model）
  basePath: string;
  paramKey: string;
  // 当前窗 + 前窗已取回的 gens（含前窗用于对比）
  allGens: DrilldownGen[];
  // 当前窗起算时间（用于切分 cur/prev）
  since: Date;
  // 当前窗总量（count，可能大于 allGens 长度）
  total: number;
};

export function DrilldownView({
  value,
  badgeClass,
  crumbLabel,
  entityLabel,
  days,
  dayOptions,
  basePath,
  paramKey,
  allGens,
  since,
  total,
}: DrilldownViewProps) {
  const curGens = allGens.filter((g) => g.startTime >= since);
  const prevGens = allGens.filter((g) => g.startTime < since);
  const cur = computeStats(curGens);
  const prev = computeStats(prevGens);

  function buildQuery(v: string, d: number): string {
    const params = new URLSearchParams();
    params.set(paramKey, v);
    params.set("days", String(d));
    return params.toString();
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href="/analytics" prefetch={false}>Analytics</Link>
        <span className="mute2">/</span>
        <span className="mono muted">{crumbLabel}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className={`badge ${badgeClass}`} style={{ fontSize: 16 }}>{value}</span>
          </h1>
          <div className="sub">
            近 {days} 天 · {total} 次 generation 调用
            {allGens.length < total ? ` · 显示最近 ${allGens.length} 条` : ""}
          </div>
        </div>
        <Link className="btn" href="/analytics" prefetch={false}>← 返回 Analytics</Link>
      </div>

      {/* 时间窗切换 */}
      <div className="seg">
        {dayOptions.map((d) => (
          <Link
            key={d}
            href={`${basePath}?${buildQuery(value, d)}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
      </div>

      <div className="grid grid-4">
        <div className="card">
          <div className="label">调用量</div>
          <div className="value">{total}</div>
          <div className="hint">{deltaHint(cur.count, prev.count, (v) => `${v} 次`)}</div>
        </div>
        <div className="card">
          <div className="label">平均延迟</div>
          <div className="value value-md">
            {formatDuration(cur.avg)}
          </div>
          <div className="hint">{deltaHint(cur.avg, prev.avg, (v) => formatDuration(v))}</div>
        </div>
        <div className="card">
          <div className="label">P95 延迟</div>
          <div className="value value-md">
            {formatDuration(cur.p95)}
          </div>
          <div className="hint">{deltaHint(cur.p95, prev.p95, (v) => formatDuration(v))}</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value text-danger">
            {(cur.errorRate * 100).toFixed(1)}%
          </div>
          <div className="hint">
            {cur.errors} ERROR · {cur.warnings} WARNING · 前窗{" "}
            {(prev.errorRate * 100).toFixed(1)}%
            {prev.count > 0 &&
              (() => {
                const pp = cur.errorRate - prev.errorRate;
                return pp > 0.01 ? (
                  <span className="delta-up"> · +{(pp * 100).toFixed(1)}pp</span>
                ) : (
                  <span className="delta-down"> · {(pp * 100).toFixed(1)}pp</span>
                );
              })()}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value value-md">
            {formatTokens(cur.tokens)}
          </div>
          <div className="hint">{deltaHint(cur.tokens, prev.tokens, (v) => formatTokens(v))}</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value value-md cost">
            {formatCost(cur.cost)}
          </div>
          <div className="hint">{deltaHint(cur.cost, prev.cost, (v) => formatCost(v))}</div>
        </div>
      </div>

      <div className="section-title">
        调用明细 <span className="count">最近 {curGens.length} 条</span>
      </div>
      {curGens.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          近 {days} 天该{entityLabel}暂无调用。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">Trace</th>
                <th scope="col">耗时</th>
                <th scope="col">级别</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col">输入摘要</th>
              </tr>
            </thead>
            <tbody>
              {curGens.map((g) => (
                <tr key={g.id}>
                  <td className="muted" title={formatDateTime(g.startTime)}>
                    {formatRelative(g.startTime)}
                  </td>
                  <td>
                    {g.traceId ? (
                      <Link href={`/traces/${g.traceId}`} prefetch={false}>
                        {g.trace?.name || <span className="mono muted">{g.traceId.slice(0, 8)}…</span>}
                      </Link>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="mono">
                    {g.endTime ? formatDuration(g.endTime.getTime() - g.startTime.getTime()) : <span className="mute2">—</span>}
                  </td>
                  <td>
                    <span className={levelClass(g.level)}>{g.level}</span>
                  </td>
                  <td className="mono">{formatTokens(g.totalTokens)}</td>
                  <td className={(g.totalCost ?? 0) > 0 ? "mono cost" : "mono"}>
                    {formatCost(g.totalCost)}
                  </td>
                  <td className="muted ellipsis">
                    {inputSummary(g.input)}
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
