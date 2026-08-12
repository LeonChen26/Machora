import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { db, trace } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  formatCost,
} from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [0, 7, 30]; // 0 = 全部

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 0;
  const since = days > 0 ? new Date(Date.now() - days * DAY_MS) : undefined;

  const projectId = await getCurrentProjectId();
  const traces = await db.query.trace.findMany({
    where: and(
      eq(trace.projectId, projectId),
      isNotNull(trace.sessionId),
      ...(since ? [gte(trace.timestamp, since)] : []),
    ),
    columns: {
      id: true,
      sessionId: true,
      name: true,
      timestamp: true,
      environment: true,
    },
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

  // 按 sessionId 聚合
  const bySession = new Map<
    string,
    {
      traces: (typeof traces)[number][];
      first: Date;
      last: Date;
      obsCount: number;
      tokens: number;
      cost: number;
      errors: number;
    }
  >();
  for (const t of traces) {
    const sid = t.sessionId!;
    const s = bySession.get(sid) ?? {
      traces: [],
      first: t.timestamp,
      last: t.timestamp,
      obsCount: 0,
      tokens: 0,
      cost: 0,
      errors: 0,
    };
    s.traces.push(t);
    if (t.timestamp < s.first) s.first = t.timestamp;
    if (t.timestamp > s.last) s.last = t.timestamp;
    for (const o of t.observations) {
      s.obsCount++;
      s.tokens += o.totalTokens ?? 0;
      s.cost += o.totalCost ?? 0;
      if (o.level === "ERROR") s.errors++;
    }
    bySession.set(sid, s);
  }

  const sessions = Array.from(bySession.entries())
    .map(([sessionId, s]) => ({
      sessionId,
      traceCount: s.traces.length,
      first: s.first,
      last: s.last,
      spanMs: s.last.getTime() - s.first.getTime(),
      obsCount: s.obsCount,
      tokens: s.tokens,
      cost: s.cost,
      errors: s.errors,
    }))
    .sort((a, b) => b.last.getTime() - a.last.getTime());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <div className="sub">
            按 sessionId 聚合的会话 · 共 {sessions.length} 个
            {since ? ` · 近 ${days} 天有活动` : ""}
          </div>
        </div>
      </div>

      {/* 时间窗筛选：仅统计近 N 天有活动的会话（与 metrics/system 等页一致：seg 包在卡片内） */}
      <div className="card mb-3">
        <div className="seg">
          {DAY_OPTIONS.map((d) => (
            <Link
              key={d}
              href={d === 0 ? "/sessions" : `/sessions?days=${d}`}
              prefetch={false}
              className={d === days ? "seg-btn active" : "seg-btn"}
              aria-current={d === days ? "true" : undefined}
            >
              {d === 0 ? "全部" : `${d} 天`}
            </Link>
          ))}
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="clock" />
          暂无会话数据。注入 trace 时带上 sessionId 即可聚合。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Traces</th>
                <th scope="col">时间范围</th>
                <th scope="col">跨度</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col">ERROR</th>
                <th scope="col">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <Link href={`/sessions/${encodeURIComponent(s.sessionId)}`} prefetch={false}>
                      <span className="mono" title={s.sessionId}>
                        {s.sessionId.slice(0, 10)}
                        {s.sessionId.length > 10 ? "…" : ""}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="badge blue">{s.traceCount}</span>
                  </td>
                  <td className="mono muted text-xs">
                    {formatDateTime(s.first)}
                    <br />
                    {formatDateTime(s.last)}
                  </td>
                  <td className="mono">{formatDuration(s.spanMs)}</td>
                  <td className="mono">{formatTokens(s.tokens)}</td>
                  <td className={s.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(s.cost)}
                  </td>
                  <td>
                    {s.errors > 0 ? (
                      <span className="badge red">{s.errors}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
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
    </>
  );
}
