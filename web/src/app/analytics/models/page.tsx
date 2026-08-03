import { Link } from "../../../components/NativeLink";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@machora/shared";
import {
  formatDateTime,
  formatRelative,
  formatDuration,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { getCurrentProjectId } from "../../../server/project";
import { requireUser } from "../../../server/session";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30];
const PAGE_SIZE = 50;

function buildQuery(model: string, days: number): string {
  const params = new URLSearchParams();
  params.set("model", model);
  params.set("days", String(days));
  return params.toString();
}

export default async function ModelDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const model = (str(sp.model) ?? "").trim();
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;
  if (!model) redirect("/analytics");

  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  // 前一等长窗口，用于对比
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  const where = {
    projectId,
    type: "GENERATION" as const,
    model,
    startTime: { gte: prevSince },
  };

  const gens = await prisma.observation.findMany({
    where,
    orderBy: { startTime: "desc" },
    take: PAGE_SIZE,
    include: { trace: { select: { name: true } } },
  });
  const curGens = gens.filter((g) => g.startTime >= since);
  const prevGens = gens.filter((g) => g.startTime < since);
  const total = await prisma.observation.count({
    where: { projectId, type: "GENERATION", model, startTime: { gte: since } },
  });

  // 统计聚合（当前窗 + 前窗）
  function stats(list: typeof gens) {
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
  const cur = stats(curGens);
  const prev = stats(prevGens);

  // 变化率渲染（相对前窗）
  function delta(cur: number | null, prev: number | null): number | null {
    if (cur == null || prev == null || prev === 0) return null;
    return (cur - prev) / prev;
  }
  function deltaHint(cur: number | null, prev: number | null, fmt: (v: number) => string): ReactNode {
    const d = delta(cur, prev);
    if (d == null) return <>前窗 —</>;
    const up = d > 0.02;
    return (
      <>
        前窗 {fmt(prev as number)} ·{" "}
        <span style={{ color: up ? "var(--red)" : "var(--green)" }}>
          {d >= 0 ? "↑" : "↓"}
          {Math.abs(d * 100).toFixed(0)}%
        </span>
      </>
    );
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href="/analytics" prefetch={false}>Analytics</Link>
        <span className="mute2">/</span>
        <span className="mono muted">{model}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>
            <span className="badge purple" style={{ fontSize: 16 }}>{model}</span>
          </h1>
          <div className="sub">
            近 {days} 天 · {total} 次 generation 调用
            {gens.length < total ? ` · 显示最近 ${gens.length} 条` : ""}
          </div>
        </div>
        <Link className="btn" href="/analytics" prefetch={false}>← 返回 Analytics</Link>
      </div>

      {/* 时间窗切换 */}
      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/analytics/models?${buildQuery(model, d)}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
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
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(cur.avg)}
          </div>
          <div className="hint">{deltaHint(cur.avg, prev.avg, (v) => formatDuration(v))}</div>
        </div>
        <div className="card">
          <div className="label">P95 延迟</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(cur.p95)}
          </div>
          <div className="hint">{deltaHint(cur.p95, prev.p95, (v) => formatDuration(v))}</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: "var(--red)" }}>
            {(cur.errorRate * 100).toFixed(1)}%
          </div>
          <div className="hint">
            {cur.errors} ERROR · {cur.warnings} WARNING · 前窗{" "}
            {(prev.errorRate * 100).toFixed(1)}%
            {prev.count > 0 &&
              (() => {
                const pp = cur.errorRate - prev.errorRate;
                return pp > 0.01 ? (
                  <span style={{ color: "var(--red)" }}> · +{(pp * 100).toFixed(1)}pp</span>
                ) : (
                  <span style={{ color: "var(--green)" }}> · {(pp * 100).toFixed(1)}pp</span>
                );
              })()}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatTokens(cur.tokens)}
          </div>
          <div className="hint">{deltaHint(cur.tokens, prev.tokens, (v) => formatTokens(v))}</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 20, color: "var(--green)" }}>
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
          <div className="icon">▦</div>
          近 {days} 天该模型暂无调用。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>Trace</th>
                <th>耗时</th>
                <th>级别</th>
                <th>Token</th>
                <th>成本</th>
                <th>输入摘要</th>
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
                  <td className="mono" style={{ color: (g.totalCost ?? 0) > 0 ? "var(--green)" : undefined }}>
                    {formatCost(g.totalCost)}
                  </td>
                  <td className="muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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

function levelClass(level: string): string {
  if (level === "ERROR") return "badge red";
  if (level === "WARNING") return "badge amber";
  if (level === "DEBUG") return "badge";
  return "badge";
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
