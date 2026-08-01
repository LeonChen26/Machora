import { prisma } from "@machora/shared";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";
import { StackedBarChart } from "../../components/StackedBarChart";
import { getCurrentProjectId } from "../../server/project";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 7;

export default async function AnalyticsPage() {
  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (DAYS - 1) * DAY_MS);

  const gens = await prisma.observation.findMany({
    where: { projectId, type: "GENERATION", startTime: { gte: since } },
    select: {
      model: true,
      startTime: true,
      endTime: true,
      level: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      totalCost: true,
    },
  });

  // 按模型聚合
  const perModel = new Map<
    string,
    {
      count: number;
      latencies: number[];
      errors: number;
      warnings: number;
      tokens: number;
      cost: number;
    }
  >();
  for (const g of gens) {
    const model = g.model ?? "unknown";
    const m = perModel.get(model) ?? {
      count: 0,
      latencies: [],
      errors: 0,
      warnings: 0,
      tokens: 0,
      cost: 0,
    };
    m.count++;
    if (g.endTime) m.latencies.push(g.endTime.getTime() - g.startTime.getTime());
    if (g.level === "ERROR") m.errors++;
    if (g.level === "WARNING") m.warnings++;
    m.tokens += g.totalTokens ?? 0;
    m.cost += g.totalCost ?? 0;
    perModel.set(model, m);
  }

  const models = Array.from(perModel.entries())
    .map(([name, m]) => {
      const sorted = [...m.latencies].sort((a, b) => a - b);
      const avg = sorted.length
        ? sorted.reduce((s, x) => s + x, 0) / sorted.length
        : null;
      const p95 = sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        : null;
      return {
        name,
        count: m.count,
        avg,
        p95,
        errors: m.errors,
        warnings: m.warnings,
        errorRate: m.count ? m.errors / m.count : 0,
        tokens: m.tokens,
        cost: m.cost,
      };
    })
    .sort((a, b) => b.count - a.count);

  // 总体统计
  const total = gens.length;
  const totalLatencies = gens
    .filter((g) => g.endTime)
    .map((g) => g.endTime!.getTime() - g.startTime.getTime())
    .sort((a, b) => a - b);
  const totalAvg = totalLatencies.length
    ? totalLatencies.reduce((s, x) => s + x, 0) / totalLatencies.length
    : null;
  const totalP95 = totalLatencies.length
    ? totalLatencies[Math.min(totalLatencies.length - 1, Math.floor(totalLatencies.length * 0.95))]
    : null;
  const totalErrors = gens.filter((g) => g.level === "ERROR").length;
  const totalWarnings = gens.filter((g) => g.level === "WARNING").length;
  const totalErrorRate = total ? totalErrors / total : 0;
  const totalTokens = gens.reduce((s, g) => s + (g.totalTokens ?? 0), 0);
  const totalCost = gens.reduce((s, g) => s + (g.totalCost ?? 0), 0);
  const costModels = models.filter((m) => m.cost > 0).length;

  // 按天 × 模型堆叠趋势
  const trend = Array.from({ length: DAYS }, (_, i) => {
    const dayStart = new Date(since.getTime() + i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const counts = new Map<string, number>();
    for (const g of gens) {
      if (g.startTime >= dayStart && g.startTime < dayEnd) {
        const model = g.model ?? "unknown";
        counts.set(model, (counts.get(model) ?? 0) + 1);
      }
    }
    return {
      label: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
      series: Array.from(counts.entries()).map(([name, value]) => ({ name, value })),
    };
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>模型分析</h1>
          <div className="sub">
            近 {DAYS} 天 · {total} 次 generation 调用 · {models.length} 个模型 ·{" "}
            {formatTokens(totalTokens)} tokens · <span style={{ color: "var(--green)" }}>{formatCost(totalCost)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-4">
        <div className="card">
          <div className="label">调用量</div>
          <div className="value">{total}</div>
          <div className="hint">近 {DAYS} 天 generation 总数</div>
        </div>
        <div className="card">
          <div className="label">平均延迟</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(totalAvg)}
          </div>
          <div className="hint">endTime − startTime</div>
        </div>
        <div className="card">
          <div className="label">P95 延迟</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatDuration(totalP95)}
          </div>
          <div className="hint">95% 调用在此之内</div>
        </div>
        <div className="card">
          <div className="label">错误率</div>
          <div className="value" style={{ color: "var(--red)" }}>
            {(totalErrorRate * 100).toFixed(1)}%
          </div>
          <div className="hint">
            {totalErrors} ERROR · {totalWarnings} WARNING
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="label">Token 用量</div>
          <div className="value" style={{ fontSize: 20 }}>
            {formatTokens(totalTokens)}
          </div>
          <div className="hint">近 {DAYS} 天 generation 输入 + 输出</div>
        </div>
        <div className="card">
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 20, color: "var(--green)" }}>
            {formatCost(totalCost)}
          </div>
          <div className="hint">
            {costModels} 个模型有定价记录，按每百万 token 单价估算
          </div>
        </div>
      </div>

      <div className="section-title">
        调用趋势（按模型堆叠）
      </div>
      <div className="card">
        <StackedBarChart data={trend} emptyText={`近 ${DAYS} 天暂无 generation 调用`} />
      </div>

      <div className="section-title">
        按模型汇总
      </div>
      {models.length === 0 ? (
        <div className="card empty">
          <div className="icon">▦</div>
          暂无数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th>调用数</th>
                <th>Token</th>
                <th>成本</th>
                <th>平均延迟</th>
                <th>P95</th>
                <th>ERROR</th>
                <th>WARNING</th>
                <th>错误率</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.name}>
                  <td>
                    <span className="badge purple">{m.name}</span>
                  </td>
                  <td className="mono">{m.count}</td>
                  <td className="mono">{formatTokens(m.tokens)}</td>
                  <td className="mono" style={{ color: m.cost > 0 ? "var(--green)" : undefined }}>
                    {formatCost(m.cost)}
                  </td>
                  <td className="mono">{formatDuration(m.avg)}</td>
                  <td className="mono">{formatDuration(m.p95)}</td>
                  <td>
                    {m.errors > 0 ? (
                      <span className="badge red">{m.errors}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
                  </td>
                  <td>
                    {m.warnings > 0 ? (
                      <span className="badge amber">{m.warnings}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
                  </td>
                  <td>
                    <span
                      style={{
                        color:
                          m.errorRate >= 0.1
                            ? "var(--red)"
                            : m.errorRate > 0
                              ? "var(--amber)"
                              : "var(--green)",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {(m.errorRate * 100).toFixed(1)}%
                    </span>
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
