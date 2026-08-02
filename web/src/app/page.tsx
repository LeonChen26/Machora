import { Link } from "../components/NativeLink";
import { prisma } from "@machora/shared";
import {
  formatRelative,
  formatDateTime,
  formatDuration,
  formatTokens,
  formatCost,
} from "../lib/format";
import { BarChart } from "../components/BarChart";
import { getCurrentProjectId } from "../server/project";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 7;

export default async function Home() {
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
  ] = await Promise.all([
    projectId
      ? prisma.project.findUnique({ where: { id: projectId } })
      : Promise.resolve(null),
    prisma.project.count(),
    prisma.trace.count({ where: { projectId } }),
    prisma.observation.count({ where: { projectId } }),
    prisma.score.count({ where: { projectId } }),
    prisma.trace.findMany({
      where: { projectId },
      orderBy: { timestamp: "desc" },
      take: 6,
      include: { _count: { select: { observations: true, scores: true } } },
    }),
    prisma.trace.findMany({
      where: { projectId, timestamp: { gte: trendSince } },
      select: { timestamp: true, environment: true },
    }),
    prisma.observation.findMany({
      where: {
        projectId,
        type: "GENERATION",
        startTime: { gte: trendSince },
      },
      select: {
        startTime: true,
        endTime: true,
        totalTokens: true,
        totalCost: true,
        level: true,
        model: true,
      },
    }),
  ]);

  // 按天分桶
  const trendData = Array.from({ length: TREND_DAYS }, (_, i) => {
    const dayStart = new Date(trendSince.getTime() + i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const count = trendTraces.filter(
      (t) => t.timestamp >= dayStart && t.timestamp < dayEnd,
    ).length;
    return {
      label: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
      value: count,
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>概览</h1>
          <div className="sub">
            {project ? `项目：${project.name}` : "未配置项目"} · standalone 模式
          </div>
        </div>
        <Link className="btn primary" href="/docs" prefetch={false}>
          接入文档 →
        </Link>
      </div>

      <div className="grid grid-4">
        <div className="card">
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
          <div className="value" style={{ fontSize: 20 }}>
            {formatTokens(totalTokens7d)}
          </div>
          <div className="hint">近 {TREND_DAYS} 天</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 20, color: "var(--green)" }}>
            {formatCost(totalCost7d)}
          </div>
          <div className="hint">近 {TREND_DAYS} 天</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: "var(--red)" }}>
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
          <div className="grid grid-3" style={{ marginTop: 8 }}>
            <div>
              <div className="mute2" style={{ fontSize: 11 }}>
                平均
              </div>
              <div className="value" style={{ fontSize: 18 }}>
                {formatDuration(latencyAvg)}
              </div>
            </div>
            <div>
              <div className="mute2" style={{ fontSize: 11 }}>
                P95
              </div>
              <div className="value" style={{ fontSize: 18 }}>
                {formatDuration(latencyP95)}
              </div>
            </div>
            <div>
              <div className="mute2" style={{ fontSize: 11 }}>
                最高
              </div>
              <div className="value" style={{ fontSize: 18 }}>
                {formatDuration(latencies.length ? latencies[latencies.length - 1] : null)}
              </div>
            </div>
          </div>
          <div className="hint">基于 generation 类型 observation 的 endTime − startTime</div>
        </div>
      </div>

      <div className="section-title">
        最近 Traces <span className="count">{recentTraces.length > 0 ? "最新 6 条" : ""}</span>
      </div>

      {recentTraces.length === 0 ? (
        <div className="card empty">
          <div className="icon">≡</div>
          暂无 Trace 数据，先用下方命令注入一条试试。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Trace ID</th>
                <th>时间</th>
                <th>Obs</th>
                <th>Score</th>
                <th>环境</th>
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
                  <td className="mono muted">{t.id}</td>
                  <td className="muted" title={formatDateTime(t.timestamp)}>
                    {formatRelative(t.timestamp)}
                  </td>
                  <td>
                    <span className="badge blue">{t._count.observations}</span>
                  </td>
                  <td>
                    {t._count.scores > 0 ? (
                      <span className="badge amber">{t._count.scores}</span>
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
        <div className="muted" style={{ marginBottom: "0.5rem" }}>
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
