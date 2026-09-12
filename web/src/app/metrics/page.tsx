import { desc, gte } from "drizzle-orm";
import { db, metricSample } from "@machora/shared";
import { formatDateTime, formatRelative } from "../../lib/format";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Link } from "../../components/NativeLink";
import {
  RANGES,
  MAX_SAMPLES,
  fmtNum,
  attrsText,
  MetricCardGrid,
} from "../../components/metricsShared";

export const dynamic = "force-dynamic";

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const range = RANGES.find((r) => r.key === raw) ?? RANGES[0]!;

  const since = new Date(Date.now() - range.ms);
  const samples = await db
    .select()
    .from(metricSample)
    .where(gte(metricSample.timestamp, since))
    .orderBy(desc(metricSample.timestamp))
    .limit(MAX_SAMPLES);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <div className="sub">
            {samples.length} 条采样
            {samples.length === MAX_SAMPLES ? "（已达上限）" : ""} · 近 {range.label}
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
          经 OTLP metrics 端点上报的指标。图表按时间桶聚合展示吞吐与趋势；
          平台自身运行指标见「System」页。
        </div>
      </div>

      {samples.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="chart" />
          暂无指标数据。通过 /api/public/otel/v1/metrics 上报后可见。
        </div>
      ) : (
        <>
          <MetricCardGrid samples={samples} range={range} />

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
