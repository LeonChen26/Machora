import { prisma, SYSTEM_PROJECT_ID } from "@machora/shared";
import { formatDateTime, formatRelative } from "../../lib/format";
import { BarChart } from "../../components/BarChart";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Link } from "../../components/NativeLink";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

// 时间窗：1h / 24h / 7d，chart 聚合桶宽对应
const RANGES = [
  { key: "1h", label: "1 小时", ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000, timeKey: "hm" },
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, timeKey: "h" },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000, timeKey: "d" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

const MAX_SAMPLES = 3000;

function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function bucketLabel(t: Date, range: (typeof RANGES)[number]): string {
  if (range.timeKey === "hm") {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  if (range.timeKey === "h") return `${String(t.getHours()).padStart(2, "0")}:00`;
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

function attrsText(attrs: unknown): string {
  if (!attrs) return "";
  try {
    const obj = attrs as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
  } catch {
    return "";
  }
}

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const range = RANGES.find((r) => r.key === raw) ?? RANGES[0]!;

  const since = new Date(Date.now() - range.ms);
  const samples = await prisma.metricSample.findMany({
    where: { projectId: SYSTEM_PROJECT_ID, timestamp: { gte: since } },
    orderBy: { timestamp: "desc" },
    take: MAX_SAMPLES,
  });

  // 按指标名聚合：最新值 / 窗口样本数 / 总 sum / chart 桶 sum
  const byName = new Map<
    string,
    {
      unit: string | null;
      kind: string;
      latest: (typeof samples)[number] | null;
      count: number;
      total: number;
      buckets: Map<number, number>;
    }
  >();
  for (const s of samples) {
    const e = byName.get(s.name) ?? {
      unit: s.unit,
      kind: s.kind,
      latest: null,
      count: 0,
      total: 0,
      buckets: new Map<number, number>(),
    };
    if (!e.latest || s.timestamp > e.latest.timestamp) e.latest = s;
    e.count++;
    e.total += s.value ?? 0;
    const key = Math.floor(s.timestamp.getTime() / range.bucketMs) * range.bucketMs;
    e.buckets.set(key, (e.buckets.get(key) ?? 0) + (s.value ?? 0));
    byName.set(s.name, e);
  }

  const names = Array.from(byName.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <div className="sub">
            {samples.length} 条采样
            {samples.length === MAX_SAMPLES ? "（已达上限）" : ""} · 近 {range.label} · 归属
            系统项目
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="seg">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`/metrics?range=${r.key}`}
              prefetch={false}
              className={r.key === range.key ? "seg-btn active" : "seg-btn"}
              aria-current={r.key === range.key ? "true" : undefined}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <div className="hint mt-2">
          自观测指标由服务内部每 60 秒汇总落库一次（SUM，value 为窗口内累计值），
          图表按时间桶聚合展示吞吐与趋势。
        </div>
      </div>

      {names.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="chart" />
          暂无系统指标数据。指标会在服务运行（注入 / 队列 / 评估）约 1 分钟后开始落库。
        </div>
      ) : (
        <>
          <div className="section-title">指标走势</div>
          <div className="grid grid-4">
            {names.map(([name, e]) => {
              const avg = e.count > 0 ? e.total / e.count : null;
              const chartData = Array.from(e.buckets.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([ts, v]) => ({
                  label: bucketLabel(new Date(ts), range),
                  value: Math.round(v * 100) / 100,
                }));
              return (
                <div className="card" key={name}>
                  <div className="label" title={name}>
                    {name}
                  </div>
                  <div className="value text-accent">
                    {fmtNum(e.latest?.value)}
                    {e.unit ? <span className="hint"> {e.unit}</span> : null}
                  </div>
                  <div className="hint">
                    n={e.count}
                    {avg != null ? ` · 均值 ${fmtNum(avg)}` : ""}
                  </div>
                  <BarChart
                    data={chartData}
                    height={90}
                    emptyText="该窗口无采样"
                  />
                </div>
              );
            })}
          </div>

          <div className="section-title">明细</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">指标</th>
                  <th scope="col">类型</th>
                  <th scope="col">值</th>
                  <th scope="col">计数</th>
                  <th scope="col">属性</th>
                  <th scope="col">时间</th>
                </tr>
              </thead>
              <tbody>
                {samples.slice(0, 100).map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.name}</td>
                    <td>
                      <span className="badge">{s.kind}</span>
                    </td>
                    <td>{fmtNum(s.value)}</td>
                    <td>{fmtNum(s.count)}</td>
                    <td className="muted">
                      {attrsText(s.attributes) || <span className="mute2">—</span>}
                    </td>
                    <td className="muted" title={formatDateTime(s.timestamp)}>
                      {formatRelative(s.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
