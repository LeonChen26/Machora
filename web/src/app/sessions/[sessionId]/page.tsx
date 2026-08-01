import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { getCurrentProjectId } from "../../../server/project";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const projectId = await getCurrentProjectId();

  const traces = await prisma.trace.findMany({
    where: { sessionId, projectId },
    orderBy: { timestamp: "asc" },
    include: {
      observations: {
        select: {
          startTime: true,
          endTime: true,
          totalTokens: true,
          totalCost: true,
          level: true,
        },
      },
      _count: { select: { scores: true } },
    },
  });

  if (traces.length === 0) {
    notFound();
  }

  let totalTokens = 0;
  let totalCost = 0;
  let obsCount = 0;
  let errorCount = 0;
  for (const t of traces) {
    for (const o of t.observations) {
      obsCount++;
      totalTokens += o.totalTokens ?? 0;
      totalCost += o.totalCost ?? 0;
      if (o.level === "ERROR") errorCount++;
    }
  }
  const first = traces[0].timestamp;
  const last = traces[traces.length - 1].timestamp;
  const spanMs = last.getTime() - first.getTime();

  // 每条 trace 的耗时：observations 时间范围，无 obs 则取 trace 时间戳
  const rows = traces.map((t) => {
    const times: number[] = [];
    for (const o of t.observations) {
      times.push(o.startTime.getTime());
      if (o.endTime) times.push(o.endTime.getTime());
    }
    const dur = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
    const tokens = t.observations.reduce((s, o) => s + (o.totalTokens ?? 0), 0);
    const cost = t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    const hasError = t.observations.some((o) => o.level === "ERROR");
    return { t, dur, tokens, cost, hasError };
  });

  return (
    <>
      <div className="breadcrumb">
        <Link href="/sessions" prefetch={false}>Sessions</Link>
        <span className="mute2">/</span>
        <span className="mono muted">{sessionId}</span>
      </div>

      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 20 }}>{sessionId}</h1>
          <div className="sub">
            {traces.length} traces · {obsCount} obs · {formatDateTime(first)} → {formatDateTime(last)}
          </div>
        </div>
        <Link className="btn" href="/sessions" prefetch={false}>← 返回列表</Link>
      </div>

      {/* 会话总览 */}
      <div className="grid grid-4" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <div className="label">Traces</div>
          <div className="value">{traces.length}</div>
        </div>
        <div className="card">
          <div className="label">会话跨度</div>
          <div className="value" style={{ fontSize: 20 }}>{formatDuration(spanMs)}</div>
        </div>
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value" style={{ fontSize: 20 }}>{formatTokens(totalTokens)}</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 20, color: "var(--green)" }}>
            {formatCost(totalCost)}
          </div>
        </div>
      </div>

      {/* Traces 时间线 */}
      <div className="section-title">
        Traces <span className="count">{traces.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>名称</th>
              <th>耗时</th>
              <th>Obs</th>
              <th>Scores</th>
              <th>Token</th>
              <th>成本</th>
              <th>级别</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, dur, tokens, cost, hasError }) => (
              <tr key={t.id}>
                <td className="mono muted" style={{ fontSize: 11 }}>
                  {formatDateTime(t.timestamp)}
                </td>
                <td>
                  <Link href={`/traces/${t.id}`} prefetch={false}>
                    {t.name || <span className="mute2">（未命名）</span>}
                  </Link>
                  <div className="mono mute2" style={{ fontSize: 11 }}>{t.id}</div>
                </td>
                <td className="mono">{formatDuration(dur)}</td>
                <td>
                  <span className="badge blue">{t.observations.length}</span>
                </td>
                <td>
                  {t._count.scores > 0 ? (
                    <span className="badge amber">{t._count.scores}</span>
                  ) : (
                    <span className="mute2">—</span>
                  )}
                </td>
                <td className="mono">{formatTokens(tokens)}</td>
                <td className="mono" style={{ color: cost > 0 ? "var(--green)" : undefined }}>
                  {formatCost(cost)}
                </td>
                <td>
                  {hasError ? (
                    <span className="badge red">ERROR</span>
                  ) : (
                    <span className="badge">DEFAULT</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errorCount > 0 && (
        <div className="card" style={{ marginTop: "1rem", borderColor: "var(--red)" }}>
          该会话包含 <span className="badge red">{errorCount}</span> 个 ERROR observation。
        </div>
      )}
    </>
  );
}
