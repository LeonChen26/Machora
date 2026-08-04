import { Link } from "../components/NativeLink";
import { EmptyIcon } from "../components/EmptyIcon";
import { and, count, desc, eq, gte } from "drizzle-orm";
import {
  db,
  trace,
  observation,
  score,
  project as projectTable,
} from "@machora/shared";
import {
  formatRelative,
  formatDateTime,
  formatDuration,
  formatTokens,
  formatCost,
} from "../lib/format";
import { BarChart } from "../components/BarChart";
import { getCurrentProjectId } from "../server/project";
import { requireUser } from "../server/session";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

export default async function Home() {
  await requireUser();

  const port = process.env.PORT ?? "3000";
  const projectId = await getCurrentProjectId();

  // 近 7 天起点（当天 00:00）
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const trendSince = new Date(today.getTime() - (TREND_DAYS - 1) * DAY_MS);

  const [
    project,
    projectCount,
    traceCount,
    obsCount,
    scoreCount,
    recentTraces,
    trendTraces,
    gens7d,
    topTraces,
  ] = await Promise.all([
    projectId
      ? db.query.project.findFirst({ where: eq(projectTable.id, projectId) })
      : Promise.resolve(null),
    (await db.select({ c: count() }).from(projectTable))[0].c,
    (await db
      .select({ c: count() })
      .from(trace)
      .where(eq(trace.projectId, projectId)))[0].c,
    (await db
      .select({ c: count() })
      .from(observation)
      .where(eq(observation.projectId, projectId)))[0].c,
    (await db
      .select({ c: count() })
      .from(score)
      .where(eq(score.projectId, projectId)))[0].c,
    db.query.trace.findMany({
      where: eq(trace.projectId, projectId),
      orderBy: (t, { desc }) => [desc(t.timestamp)],
      limit: 6,
      with: {
        observations: { columns: { id: true } },
        scores: { columns: { id: true } },
      },
    }),
    db
      .select({ timestamp: trace.timestamp, environment: trace.environment })
      .from(trace)
      .where(and(eq(trace.projectId, projectId), gte(trace.timestamp, trendSince))),
    db
      .select({
        startTime: observation.startTime,
        endTime: observation.endTime,
        totalTokens: observation.totalTokens,
        totalCost: observation.totalCost,
        level: observation.level,
        model: observation.model,
      })
      .from(observation)
      .where(
        and(
          eq(observation.projectId, projectId),
          eq(observation.type, "GENERATION"),
          gte(observation.startTime, trendSince),
        ),
      ),
    db.query.trace.findMany({
      where: and(eq(trace.projectId, projectId), gte(trace.timestamp, trendSince)),
      orderBy: (t, { desc }) => [desc(t.timestamp)],
      limit: 200,
      with: {
        observations: {
          columns: {
            totalCost: true,
            totalTokens: true,
            startTime: true,
            endTime: true,
            level: true,
          },
        },
      },
    }),
  ]);

  // 按天分桶
  const trendData = Array.from({ length: TREND_DAYS }, (_, i) => {
    const dayStart = new Date(trendSince.getTime() + i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const dayCount = trendTraces.filter(
      (t) => t.timestamp >= dayStart && t.timestamp < dayEnd,
    ).length;
    return {
      label: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
      value: dayCount,
    };
  });

  // generation 延迟统计
  const latencies = gens7d
    .map((g) => (g.endTime ? g.endTime.getTime() - g.startTime.getTime() : null))
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const latencyAvg = latencies.length
    ? latencies.reduce((s, x) => s + x, 0) / latencies.length
    : null;
  const latencyP95 = latencies.length
    ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
    : null;

  // 近 7 天聚合：token / 成本 / 错误率
  const totalTokens7d = gens7d.reduce((s, g) => s + (g.totalTokens ?? 0), 0);
  const totalCost7d = gens7d.reduce((s, g) => s + (g.totalCost ?? 0), 0);
  const errors7d = gens7d.filter((g) => g.level === "ERROR").length;
  const errorRate7d = gens7d.length ? errors7d / gens7d.length : 0;

  // 按模型分布（近 7 天 generation 调用数）
  const modelCounts = new Map<string, number>();
  for (const g of gens7d) {
    const m = g.model ?? "unknown";
    modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
  }
  const modelDist = Array.from(modelCounts.entries())
    .map(([label, value]) => ({ label: label.length > 14 ? `${label.slice(0, 14)}…` : label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 按环境分布（近 7 天 trace 数）
  const envCounts = new Map<string, number>();
  for (const t of trendTraces) {
    const e = t.environment ?? "unknown";
    envCounts.set(e, (envCounts.get(e) ?? 0) + 1);
  }
  const envDist = Array.from(envCounts.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  // Top N：近 7 天最贵 / 最慢 traces
  const topStats = topTraces.map((t) => {
    const cost = t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    const starts = t.observations.map((o) => o.startTime.getTime());
    const ends = t.observations.map((o) =>
      o.endTime ? o.endTime.getTime() : o.startTime.getTime(),
    );
    const latency = starts.length
      ? Math.max(...ends) - Math.min(...starts)
      : null;
    return { t, cost, latency };
  });
  const topCost = topStats
    .filter((x) => x.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);
  const topLatency = topStats
    .filter((x) => x.latency != null)
    .sort((a, b) => (b.latency ?? 0) - (a.latency ?? 0))
    .slice(0, 5);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="sub">
            {project ? `项目：${project.name}` : "未配置项目"} · standalone 模式
          </div>
        </div>
        <Link className="btn primary" href="/docs" prefetch={false}>
          接入文档 →
        </Link>
      </div>

      <div className="grid grid-4">
        <div className="card" style={{ borderLeft: "3px solid var(--accent)" }}>
          <div className="label">Traces</div>
          <div className="value">{traceCount}</div>
          <div className="hint">总记录数</div>
        </div>
        <div className="card">
          <div className="label">Observations</div>
          <div className="value">{obsCount}</div>
          <div className="hint">span / generation / event</div>
        </div>
        <div className="card">
          <div className="label">Scores</div>
          <div className="value">{scoreCount}</div>
          <div className="hint">人工 / 自动评分</div>
        </div>
        <div className="card">
          <div className="label">Projects</div>
          <div className="value">{projectCount}</div>
          <div className="hint">{project?.name ?? "—"}</div>
        </div>
      </div>

      <div className="section-title">近 {TREND_DAYS} 天聚合</div>
      <div className="grid grid-4">
        <div className="card">
          <div className="label">Generation 调用</div>
          <div className="value">{gens7d.length}</div>
          <div className="hint">近 {TREND_DAYS} 天</div>
        </div>
        <div className="card">
          <div className="label">Token 总量</div>
          <div className="value value-md">
            {formatTokens(totalTokens7d)}
          </div>
          <div className="hint">近 {TREND_DAYS} 天</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value value-md text-success">
            {formatCost(totalCost7d)}
          </div>
          <div className="hint">近 {TREND_DAYS} 天</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value text-danger">
            {(errorRate7d * 100).toFixed(1)}%
          </div>
          <div className="hint">{errors7d} ERROR · 近 {TREND_DAYS} 天</div>
        </div>
      </div>

      <div className="section-title">近 {TREND_DAYS} 天分布</div>
      <div className="grid grid-2">
        <div className="card">
          <div className="label">按模型（调用数）</div>
          <BarChart data={modelDist} color="var(--purple)" />
        </div>
        <div className="card">
          <div className="label">按环境（trace 数）</div>
          <BarChart data={envDist} color="var(--accent)" />
        </div>
      </div>

      <div className="section-title">近 {TREND_DAYS} 天趋势</div>
      <div className="grid grid-2">
        <div className="card">
          <div className="label">Traces / 天</div>
          <BarChart data={trendData} />
        </div>
        <div className="card">
          <div className="label">Generation 延迟（近 {TREND_DAYS} 天 · {gens7d.length} 次调用）</div>
          <div className="grid grid-3 mt-1">
            <div>
              <div className="mute2 text-xs">
                平均
              </div>
              <div className="value value-sm">
                {formatDuration(latencyAvg)}
              </div>
            </div>
            <div>
              <div className="mute2 text-xs">
                P95
              </div>
              <div className="value value-sm">
                {formatDuration(latencyP95)}
              </div>
            </div>
            <div>
              <div className="mute2 text-xs">
                最高
              </div>
              <div className="value value-sm">
                {formatDuration(latencies.length ? latencies[latencies.length - 1] : null)}
              </div>
            </div>
          </div>
          <div className="hint">基于 generation 类型 observation 的 endTime − startTime</div>
        </div>
      </div>

      <div className="section-title">Top 5（近 {TREND_DAYS} 天）</div>
      <div className="grid grid-2">
        <div className="card">
          <div className="label">最贵</div>
          {topCost.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无成本数据
            </div>
          ) : (
            topCost.map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id}</span>}
                </Link>
                <span className="mono cost" style={{ whiteSpace: "nowrap" }}>
                  {formatCost(x.cost)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="card">
          <div className="label">最慢</div>
          {topLatency.length === 0 ? (
            <div className="mute2" style={{ padding: "0.5rem 0" }}>
              暂无耗时数据
            </div>
          ) : (
            topLatency.map((x) => (
              <div key={x.t.id} className="stat-list-item">
                <Link href={`/traces/${x.t.id}`} prefetch={false}>
                  {x.t.name || <span className="mute2">{x.t.id}</span>}
                </Link>
                <span
                  className={`mono ${
                    (x.latency ?? 0) >= 8000
                      ? "latency-high"
                      : (x.latency ?? 0) >= 2000
                        ? "latency-mid"
                        : "latency-low"
                  }`}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {formatDuration(x.latency)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="section-title">
        最近 Traces <span className="count">{recentTraces.length > 0 ? "最新 6 条" : ""}</span>
      </div>

      {recentTraces.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="list" />
          暂无 Trace 数据，先用下方命令注入一条试试。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">Trace ID</th>
                <th scope="col">时间</th>
                <th scope="col">Obs</th>
                <th scope="col">Score</th>
                <th scope="col">环境</th>
              </tr>
            </thead>
            <tbody>
              {recentTraces.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link href={`/traces/${t.id}`} prefetch={false}>
                      {t.name || <span className="mute2">（未命名）</span>}
                    </Link>
                  </td>
                  <td className="mono muted" title={t.id}>{t.id.slice(0, 8)}</td>
                  <td className="muted" title={formatDateTime(t.timestamp)}>
                    {formatRelative(t.timestamp)}
                  </td>
                  <td>
                    <span className="badge blue">{t.observations.length}</span>
                  </td>
                  <td>
                    {t.scores.length > 0 ? (
                      <span className="badge amber">{t.scores.length}</span>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td>
                    <span className="badge">{t.environment}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">快速接入</div>
      <div className="card">
        <div className="muted mb-1">
          向 ingestion 端点批量推送事件，Basic Auth 用 public key : secret key：
        </div>
        <pre className="code">
{`curl -X POST http://localhost:${port}/api/public/ingestion \\
  -u "pk-machora-dev-000000000000000000000:sk-machora-dev-000000000000000000000" \\
  -H "Content-Type: application/json" \\
  -d '{
    "batch": [
      {
        "type": "trace-create",
        "body": {
          "id": "trace-1",
          "name": "my-trace",
          "timestamp": "${new Date().toISOString()}"
        }
      },
      {
        "type": "observation-create",
        "body": {
          "id": "obs-1",
          "traceId": "trace-1",
          "type": "generation",
          "name": "chat-completion",
          "startTime": "${new Date().toISOString()}",
          "model": "gpt-4o-mini",
          "input": {"role": "user", "content": "hello"},
          "output": {"role": "assistant", "content": "hi there"}
        }
      },
      {
        "type": "score-create",
        "body": {
          "id": "score-1",
          "traceId": "trace-1",
          "name": "quality",
          "value": 0.92,
          "dataType": "NUMERIC",
          "source": "HUMAN"
        }
      }
    ]
  }'`}
        </pre>
        <div className="muted" style={{ marginTop: "0.75rem" }}>
          <Link href="/api/public/health" prefetch={false}>健康检查</Link> ·{" "}
          <Link href="/traces" prefetch={false}>查看全部 Traces →</Link>
        </div>
      </div>
    </>
  );
}
