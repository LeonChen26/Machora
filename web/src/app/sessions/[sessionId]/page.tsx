import { Link } from "../../../components/NativeLink";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db, trace } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { getCurrentProjectId } from "../../../server/project";
import { requireUser } from "../../../server/session";

export const dynamic = "force-dynamic";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  await requireUser();

  const { sessionId } = await params;
  const projectId = await getCurrentProjectId();

  const traces = await db.query.trace.findMany({
    where: and(eq(trace.sessionId, sessionId), eq(trace.projectId, projectId)),
    orderBy: (t, { asc }) => [asc(t.timestamp)],
    with: {
      observations: {
        columns: {
          startTime: true,
          endTime: true,
          totalTokens: true,
          totalCost: true,
          level: true,
        },
      },
      scores: { columns: { id: true } },
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
          <h1 className="mono">{sessionId}</h1>
          <div className="sub">
            {traces.length} traces · {obsCount} obs · {formatDateTime(first)} → {formatDateTime(last)}
          </div>
        </div>
        <Link className="btn" href="/sessions" prefetch={false}>← 返回列表</Link>
      </div>

      {/* 会话总览 */}
      <div className="grid grid-4 mb-3">
        <div className="card">
          <div className="label">Traces</div>
          <div className="value">{traces.length}</div>
        </div>
        <div className="card">
          <div className="label">会话跨度</div>
          <div className="value">{formatDuration(spanMs)}</div>
        </div>
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value">{formatTokens(totalTokens)}</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value cost">
            {formatCost(totalCost)}
          </div>
        </div>
      </div>

      {/* Traces 时间线串联 */}
      <div className="section-title">
        Traces <span className="count">{traces.length}</span>
      </div>
      <div className="card tl">
        {rows.map(({ t, dur, tokens, cost, hasError }, i) => {
          const prev = i > 0 ? rows[i - 1].t.timestamp : null;
          const gapMs = prev ? t.timestamp.getTime() - prev.getTime() : null;
          return (
            <div className="tl-item" key={t.id}>
              <div
                className={hasError ? "tl-node danger" : "tl-node"}
              />
              <div className="tl-body">
                <div className="tl-head">
                  <span className="mono muted text-xs">
                    {formatDateTime(t.timestamp)}
                  </span>
                  <Link href={`/traces/${t.id}`} prefetch={false}>
                    {t.name || <span className="mute2">（未命名）</span>}
                  </Link>
                  {hasError && <span className="badge red">ERROR</span>}
                </div>
                <div className="tl-meta">
                  <span className={dur != null ? "mono" : "mono muted"}>
                    耗时 {formatDuration(dur)}
                  </span>
                  <span className="badge blue">{t.observations.length} obs</span>
                  {t.scores.length > 0 && (
                    <span className="badge amber">{t.scores.length} score</span>
                  )}
                  <span className="mono">{formatTokens(tokens)}</span>
                  <span className={cost > 0 ? "mono cost" : "mono muted"}>
                    {formatCost(cost)}
                  </span>
                  {gapMs != null && (
                    <span className="mute2 text-xs">
                      距上一条 +{formatDuration(gapMs)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {errorCount > 0 && (
        <div className="card alert-danger mt-3">
          该会话包含 <span className="badge red">{errorCount}</span> 个 ERROR observation。
        </div>
      )}
    </>
  );
}
