import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { BarChart } from "../../components/BarChart";
import { getCurrentProjectId } from "../../server/project";

export const dynamic = "force-dynamic";

// NUMERIC 值分布桶
const BUCKETS = [
  { label: "0–0.2", min: 0, max: 0.2 },
  { label: "0.2–0.4", min: 0.2, max: 0.4 },
  { label: "0.4–0.6", min: 0.4, max: 0.6 },
  { label: "0.6–0.8", min: 0.6, max: 0.8 },
  { label: "0.8–1", min: 0.8, max: 1.001 },
];

export default async function ScoresPage() {
  const projectId = await getCurrentProjectId();
  const scores = await prisma.score.findMany({
    where: { projectId },
    orderBy: { timestamp: "desc" },
    take: 100,
    include: { trace: { select: { name: true } } },
  });

  // 按名称聚合
  const byName = new Map<string, { count: number; sum: number; values: number[] }>();
  for (const s of scores) {
    if (s.dataType !== "NUMERIC") continue;
    const entry = byName.get(s.name) ?? { count: 0, sum: 0, values: [] };
    entry.count++;
    entry.sum += s.value;
    entry.values.push(s.value);
    byName.set(s.name, entry);
  }

  // 每个评分名的值分布直方图
  const distributions = Array.from(byName.entries()).map(([name, e]) => ({
    name,
    data: BUCKETS.map((b) => ({
      label: b.label,
      value: e.values.filter((v) => v >= b.min && v < b.max).length,
    })),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scores</h1>
          <div className="sub">最近 {scores.length} 条评分</div>
        </div>
      </div>

      {byName.size > 0 && (
        <>
          <div className="section-title">
            汇总 <span className="count">仅 NUMERIC 类型</span>
          </div>
          <div className="grid grid-4">
            {Array.from(byName.entries()).map(([name, e]) => {
              const avg = e.sum / e.count;
              const min = Math.min(...e.values);
              const max = Math.max(...e.values);
              return (
                <div className="card" key={name}>
                  <div className="label">{name}</div>
                  <div className="value" style={{ color: "var(--accent)" }}>
                    {avg.toFixed(3)}
                  </div>
                  <div className="hint">
                    n={e.count} · min {min.toFixed(2)} · max {max.toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="section-title">
            值分布 <span className="count">样本数 / 区间</span>
          </div>
          <div className="grid grid-4">
            {distributions.map(({ name, data }) => (
              <div className="card" key={name}>
                <div className="label">{name}</div>
                <BarChart data={data} height={110} emptyText="暂无 NUMERIC 样本" />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">明细</div>
      {scores.length === 0 ? (
        <div className="card empty">
          <div className="icon">★</div>
          暂无评分数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>值</th>
                <th>类型</th>
                <th>来源</th>
                <th>Trace</th>
                <th>时间</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      style={{
                        color:
                          s.dataType === "NUMERIC"
                            ? s.value >= 0.8
                              ? "var(--green)"
                              : s.value >= 0.5
                                ? "var(--amber)"
                                : "var(--red)"
                            : "var(--text)",
                        fontFamily: "var(--mono)",
                        fontWeight: 600,
                      }}
                    >
                      {s.dataType === "NUMERIC"
                        ? s.value.toFixed(3)
                        : s.dataType === "BOOLEAN"
                          ? s.value
                            ? "✓"
                            : "✗"
                          : String(s.value)}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{s.dataType}</span>
                  </td>
                  <td>
                    <span className="badge blue">{s.source}</span>
                  </td>
                  <td>
                    {s.traceId ? (
                      <Link href={`/traces/${s.traceId}`} prefetch={false}>
                        {s.trace?.name || <span className="mono muted">{s.traceId.slice(0, 8)}…</span>}
                      </Link>
                    ) : (
                      <span className="mute2">—</span>
                    )}
                  </td>
                  <td className="muted" title={formatDateTime(s.timestamp)}>
                    {formatRelative(s.timestamp)}
                  </td>
                  <td className="muted">{s.comment || <span className="mute2">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
