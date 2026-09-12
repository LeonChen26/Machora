import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Pager } from "../../components/Pager";
import { StatCard } from "../../components/StatCard";
import { and, gte, isNotNull } from "drizzle-orm";
import { db, textSearch, trace } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  formatCost,
} from "../../lib/format";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [0, 7, 30]; // 0 = 全部
const PAGE_SIZE = 25;

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 0;
  const since = days > 0 ? new Date(Date.now() - days * DAY_MS) : undefined;
  const q = str(sp.q)?.trim();
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  const traces = await db.query.trace.findMany({
    where: and(
      isNotNull(trace.sessionId),
      ...(since ? [gte(trace.timestamp, since)] : []),
      ...(q ? [textSearch(trace.sessionId, q)] : []),
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
      erroredTraces: number;
      durSum: number;
      durCount: number;
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
      erroredTraces: 0,
      durSum: 0,
      durCount: 0,
    };
    s.traces.push(t);
    if (t.timestamp < s.first) s.first = t.timestamp;
    if (t.timestamp > s.last) s.last = t.timestamp;

    // 单条 trace 的耗时：其 observation 时间跨度（无 obs 则不计入平均）
    let tStart = Infinity;
    let tEnd = -Infinity;
    let tHasError = false;
    for (const o of t.observations) {
      s.obsCount++;
      s.tokens += o.totalTokens ?? 0;
      s.cost += o.totalCost ?? 0;
      if (o.level === "ERROR") {
        s.errors++;
        tHasError = true;
      }
      const st = o.startTime.getTime();
      if (st < tStart) tStart = st;
      const et = (o.endTime ?? o.startTime).getTime();
      if (et > tEnd) tEnd = et;
    }
    if (tEnd >= tStart) {
      s.durSum += tEnd - tStart;
      s.durCount++;
    }
    if (tHasError) s.erroredTraces++;

    bySession.set(sid, s);
  }

  const sessions = Array.from(bySession.entries())
    .map(([sessionId, s]) => ({
      sessionId,
      traceCount: s.traces.length,
      erroredTraces: s.erroredTraces,
      // 成功率 = 无 ERROR observation 的 trace 占比
      successRate:
        s.traces.length > 0
          ? (s.traces.length - s.erroredTraces) / s.traces.length
          : null,
      avgDurMs: s.durCount > 0 ? s.durSum / s.durCount : null,
      first: s.first,
      last: s.last,
      spanMs: s.last.getTime() - s.first.getTime(),
      obsCount: s.obsCount,
      tokens: s.tokens,
      cost: s.cost,
      errors: s.errors,
    }))
    .sort((a, b) => b.last.getTime() - a.last.getTime());

  const total = sessions.length;
  // 全局聚合（口径与行内一致：成功率 = 无 ERROR 的 trace 占比，trace 级）
  const totalTraces = sessions.reduce((s, x) => s + x.traceCount, 0);
  const totalErrored = sessions.reduce((s, x) => s + x.erroredTraces, 0);
  const overallSuccessRate =
    totalTraces > 0 ? (totalTraces - totalErrored) / totalTraces : null;
  const abnormalSessions = sessions.filter((s) => s.erroredTraces > 0).length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shown = sessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // 保留 days/q 的分页链接
  function pageHref(p: number): string {
    const params = new URLSearchParams();
    if (days > 0) params.set("days", String(days));
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/sessions?${qs}` : "/sessions";
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <div className="sub">
            按 sessionId 聚合的会话
            {since ? ` · 近 ${days} 天有活动` : ""}
            {q ? ` · 匹配「${q}」` : ""}
          </div>
        </div>
      </div>

      {/* 时间窗筛选：仅统计近 N 天有活动的会话（与 metrics/system 等页一致：seg 包在卡片内） */}
      <div className="card mb-3">
        <div className="seg">
          {DAY_OPTIONS.map((d) => {
            const params = new URLSearchParams();
            if (d > 0) params.set("days", String(d));
            if (q) params.set("q", q);
            const qs = params.toString();
            return (
              <Link
                key={d}
                href={qs ? `/sessions?${qs}` : "/sessions"}
                prefetch={false}
                className={d === days ? "seg-btn active" : "seg-btn"}
                aria-current={d === days ? "true" : undefined}
              >
                {d === 0 ? "全部" : `${d} 天`}
              </Link>
            );
          })}
        </div>
      </div>

      {/* 首屏聚合：当前时间窗内全量会话的全局口径（不随分页变化） */}
      <div className="grid grid-4 mb-3">
        <StatCard
          label="会话数"
          value={total}
          hint={since ? `近 ${days} 天有活动` : "全部时间"}
          icon="folder"
          accent
          title="按 sessionId 聚合出的会话数"
        />
        <StatCard
          label="Trace 总数"
          value={totalTraces}
          hint={`${total} 个会话聚合`}
          icon="list"
          title="全部会话包含的 trace 数之和"
        />
        <StatCard
          label="整体成功率"
          value={
            overallSuccessRate == null
              ? "—"
              : `${(overallSuccessRate * 100).toFixed(1)}%`
          }
          hint={`${totalErrored} 个 trace 含 ERROR`}
          tone={
            overallSuccessRate != null && overallSuccessRate < 0.9
              ? "danger"
              : "success"
          }
          icon="star"
          title="无 ERROR 的 trace 占比（trace 级口径）"
        />
        <StatCard
          label="异常会话"
          value={abnormalSessions}
          hint={
            total > 0
              ? `${abnormalSessions} / ${total} 个会话有 ERROR`
              : "暂无会话"
          }
          tone={abnormalSessions > 0 ? "danger" : "success"}
          icon="alert"
          title="至少含 1 个 ERROR trace 的会话数"
        />
      </div>

      {/* 搜索（GET 提交，纯服务端） */}
      <form className="card filter-bar mb-3">
        {days > 0 ? <input type="hidden" name="days" value={days} /> : null}
        <label>
          <span>会话搜索</span>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="sessionId 模糊匹配..."
          />
        </label>
        <button type="submit" className="btn primary">
          查询
        </button>
        <Link className="btn" href="/sessions" prefetch={false}>
          重置
        </Link>
      </form>

      {shown.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="clock" />
          {q
            ? `没有匹配「${q}」的会话。`
            : "暂无会话数据。注入 trace 时带上 sessionId 即可聚合。"}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col" className="col-narrow">Trace 数</th>
                <th scope="col" className="col-narrow" title="无 ERROR 的 trace 占比（trace 级口径）">
                  成功率
                </th>
                <th scope="col">平均 Trace 耗时</th>
                <th scope="col">时间范围</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col" className="col-narrow">ERROR</th>
                <th scope="col">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <Link href={`/sessions/${encodeURIComponent(s.sessionId)}`} prefetch={false}>
                      <span className="mono" title={s.sessionId}>
                        {s.sessionId.slice(0, 10)}
                        {s.sessionId.length > 10 ? "…" : ""}
                      </span>
                    </Link>
                  </td>
                  <td className="col-narrow">
                    <span className="badge blue">{s.traceCount}</span>
                    {s.errors > 0 && (
                      <span className="mute2 text-xs" title={`${s.errors} 个 ERROR observation`}>
                        {" "}
                        {s.errors} err
                      </span>
                    )}
                  </td>
                  <td className="col-narrow">
                    {s.successRate == null ? (
                      <span className="mute2">—</span>
                    ) : s.successRate === 1 ? (
                      <span className="badge green">100%</span>
                    ) : (
                      <span
                        className={s.successRate >= 0.8 ? "badge amber" : "badge red"}
                        title={`${s.erroredTraces} / ${s.traceCount} 个 trace 含 ERROR`}
                      >
                        {Math.round(s.successRate * 100)}%
                      </span>
                    )}
                  </td>
                  <td className="mono">{formatDuration(s.avgDurMs)}</td>
                  <td className="mono muted text-xs">
                    {formatDateTime(s.first)}
                    <br />
                    {formatDateTime(s.last)}
                    <span className="mute2"> · 跨度 {formatDuration(s.spanMs)}</span>
                  </td>
                  <td className="mono">{formatTokens(s.tokens)}</td>
                  <td className={s.cost > 0 ? "mono cost" : "mono"}>
                    {formatCost(s.cost)}
                  </td>
                  <td className="col-narrow">
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

      {total > 0 && (
        <Pager
          info={`显示 ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown.length} / ${total} 个会话 · 第 ${page}/${totalPages} 页`}
          prevHref={page > 1 ? pageHref(page - 1) : undefined}
          nextHref={page < totalPages ? pageHref(page + 1) : undefined}
          jump={{
            action: "/sessions",
            page,
            totalPages,
            hidden: (
              <>
                {days > 0 ? <input type="hidden" name="days" value={days} /> : null}
                {q ? <input type="hidden" name="q" value={q} /> : null}
              </>
            ),
          }}
        />
      )}
    </>
  );
}
