import { and, desc, eq, gte } from "drizzle-orm";
import { db, metricSample, SYSTEM_PROJECT_ID, getSelfStartedAt } from "@machora/shared";
import { formatDateTime, formatRelative } from "../../lib/format";
import { EmptyIcon } from "../../components/EmptyIcon";
import { Link } from "../../components/NativeLink";
import { LineChart } from "../../components/LineChart";
import { OpenApiLineChart } from "../../components/OpenApiLineChart";
import {
  RANGES,
  MAX_SAMPLES,
  fmtNum,
  attrsText,
  bucketLabel,
  MetricCardGrid,
} from "../../components/metricsShared";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分 ${s % 60}秒`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// OpenAPI 流量口径：接入 = 上报端点（ingestion / OTLP traces / metrics），
// 查询 = public 查询端点。console 管理接口不埋点，天然不计入。
const INGESTION_METRICS = new Set([
  "machora.ingestion.requests",
  "machora.traces.requests",
  "machora.metrics.requests",
]);
const QUERY_METRICS = new Set(["machora.query.requests"]);

/** 按时间桶聚合指定指标名的 SUM（合并同桶 value） */
function bucketSums(
  samples: { name: string; value: number | null; timestamp: Date }[],
  names: Set<string>,
  bucketMs: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of samples) {
    if (!names.has(s.name)) continue;
    const key = Math.floor(s.timestamp.getTime() / bucketMs) * bucketMs;
    out.set(key, (out.get(key) ?? 0) + (s.value ?? 0));
  }
  return out;
}

// 平台自身健康面板：运行状态卡 + machora.* 指标趋势。
// 数据源为 machora-system 专用项目的自观测采样（60s 窗口 SUM）。
export default async function SystemPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const range = RANGES.find((r) => r.key === raw) ?? RANGES[0]!;

  const since = new Date(Date.now() - range.ms);
  const samples = await db
    .select()
    .from(metricSample)
    .where(
      and(
        eq(metricSample.projectId, SYSTEM_PROJECT_ID),
        gte(metricSample.timestamp, since),
      ),
    )
    .orderBy(desc(metricSample.timestamp))
    .limit(MAX_SAMPLES);

  // 状态卡：运行时长 / 最近落库 / 采样数 / 错误计数（status=error|unauthorized）
  const startedAt = getSelfStartedAt();
  const latest = samples[0]?.timestamp ?? null;
  const errorCount = samples.filter((s) => {
    const a = (s.attributes ?? {}) as Record<string, unknown>;
    return a.status === "error" || a.status === "unauthorized";
  }).length;

  const stats = [
    {
      label: "运行时长",
      value: startedAt ? fmtUptime(Date.now() - startedAt) : "—",
      hint: startedAt ? `启动于 ${formatDateTime(new Date(startedAt))}` : "未记录启动时间",
    },
    {
      label: "最近落库",
      value: latest ? formatRelative(latest) : "—",
      hint: latest ? formatDateTime(latest) : "自观测启动后约 60s 落库",
    },
    {
      label: "采样数",
      value: fmtNum(samples.length),
      hint: `近 ${range.label} · machora-system`,
    },
    {
      label: "错误计数",
      value: fmtNum(errorCount),
      hint: "status=error/unauthorized 采样数",
    },
  ];

  // 进程资源：按指标名取最新一窗（samples 已按时间倒序）
  const latestByName = new Map<string, number>();
  for (const s of samples) {
    if (!latestByName.has(s.name) && s.value != null) {
      latestByName.set(s.name, s.value);
    }
  }
  const resCpu = latestByName.get("machora.process.cpu_percent") ?? null;
  const resRss = latestByName.get("machora.process.memory_rss_bytes") ?? null;
  const resDataDir = latestByName.get("machora.process.data_dir_bytes") ?? null;
  const resEvLoop = latestByName.get("machora.process.event_loop_ms") ?? null;

  const resStats = [
    {
      label: "CPU",
      value: resCpu != null ? `${resCpu}%` : "—",
      hint: "进程 CPU 占用（跨窗口差值）",
    },
    {
      label: "内存 RSS",
      value: resRss != null ? fmtBytes(resRss) : "—",
      hint: "进程常驻内存",
    },
    {
      label: "数据目录",
      value: resDataDir != null ? fmtBytes(resDataDir) : "—",
      hint: "PGlite 落盘大小",
    },
    {
      label: "事件循环",
      value: resEvLoop != null ? `${resEvLoop.toFixed(2)} ms` : "—",
      hint: "setImmediate 轮询平均延迟",
    },
  ];

  // HTTP 请求按 端点/状态码 双维度聚合（machora.http.requests 的 attrs.path / attrs.status）
  const httpByUrl = new Map<number, Map<string, number>>();
  const httpByStatus = new Map<number, Map<string, number>>();
  for (const s of samples) {
    if (s.name !== "machora.http.requests" || s.value == null) continue;
    const attrs = (s.attributes ?? {}) as Record<string, unknown>;
    const path = String(attrs.path ?? "/");
    const status = String(attrs.status ?? "2xx");
    const key = Math.floor(s.timestamp.getTime() / range.bucketMs) * range.bucketMs;
    const mUrl = httpByUrl.get(key) ?? new Map<string, number>();
    mUrl.set(path, (mUrl.get(path) ?? 0) + s.value);
    httpByUrl.set(key, mUrl);
    const mSt = httpByStatus.get(key) ?? new Map<string, number>();
    mSt.set(status, (mSt.get(status) ?? 0) + s.value);
    httpByStatus.set(key, mSt);
  }
  const toSeries = (m: Map<number, Map<string, number>>) =>
    Array.from(m.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, mm]) => ({
        label: bucketLabel(new Date(ts), range),
        series: Array.from(mm.entries()).map(([name, value]) => ({ name, value })),
      }));
  const urlSeries = toSeries(httpByUrl);
  const statusSeries = toSeries(httpByStatus);
  const hasHttp = urlSeries.some((d) => d.series.length > 0);

  // OpenAPI 流量折线：接入/查询两系列。x 轴按完整时间窗铺满，
  // 折线只含有数据的桶（缺失不补点，折线自动断开）
  const ingestion = bucketSums(samples, INGESTION_METRICS, range.bucketMs);
  const query = bucketSums(samples, QUERY_METRICS, range.bucketMs);
  const startKey = Math.floor(since.getTime() / range.bucketMs) * range.bucketMs;
  const bucketCount = Math.ceil(range.ms / range.bucketMs);
  const endKey = startKey + bucketCount * range.bucketMs;
  const xTicks = Array.from({ length: bucketCount }, (_, i) => {
    const ts = startKey + i * range.bucketMs;
    return { ts, label: bucketLabel(new Date(ts), range) };
  });
  const toPoints = (m: Map<number, number>) =>
    Array.from(m.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, v]) => ({
        ts,
        value: v,
        label: bucketLabel(new Date(ts), range),
      }));
  const openApiSeries = [
    { name: "接入", color: "var(--accent)", data: toPoints(ingestion) },
    { name: "查询", color: "var(--green)", data: toPoints(query) },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System</h1>
          <div className="sub">
            {samples.length} 条采样
            {samples.length === MAX_SAMPLES ? "（已达上限）" : ""} · 近 {range.label} · 平台自运维
          </div>
        </div>
      </div>

      <div className="grid grid-4 mb-3">
        {stats.map((st) => (
          <div className="card" key={st.label}>
            <div className="label">{st.label}</div>
            <div className="value text-accent">{st.value}</div>
            <div className="hint">{st.hint}</div>
          </div>
        ))}
      </div>

      <div className="section-title">进程资源（近 {range.label} 最新值）</div>
      <div className="grid grid-4 mb-3">
        {resStats.map((st) => (
          <div className="card" key={st.label}>
            <div className="label">{st.label}</div>
            <div className="value text-accent">{st.value}</div>
            <div className="hint">{st.hint}</div>
          </div>
        ))}
      </div>

      <div className="card mb-3">
        <div className="seg">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`/system?range=${r.key}`}
              prefetch={false}
              className={r.key === range.key ? "seg-btn active" : "seg-btn"}
              aria-current={r.key === range.key ? "true" : undefined}
            >
              {r.label}
            </Link>
          ))}
        </div>
        <div className="hint mt-2">
          服务内部每 60 秒汇总落库（SUM，value 为窗口内累计值），保留 7 天。队列为进程内
          事件总线即时投递，无积压队列；趋势图反映处理吞吐与延迟。
        </div>
      </div>

      {samples.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="chart" />
          暂无自运维指标。服务运行约 1 分钟后开始落库。
        </div>
      ) : (
        <>
          <div className="card mb-3">
            <div className="card-head">
              <div>
                <div className="card-title">OpenAPI 流量</div>
                <div className="hint">
                  接入 = /ingestion、/otel/v1/traces、/otel/v1/metrics 上报；查询 =
                  public 查询接口。console 管理接口不计入。
                </div>
              </div>
            </div>
            <OpenApiLineChart
              series={openApiSeries}
              xDomain={[startKey, endKey]}
              xTicks={xTicks}
              gapMs={range.bucketMs}
              height={220}
              emptyText="近窗口无 OpenAPI 请求（上报/查询后约 60s 落库）"
            />
          </div>

          <MetricCardGrid samples={samples} range={range} />

          {hasHttp && (
            <>
              <div className="section-title">HTTP 请求 · 按端点</div>
              <div className="card mb-3">
                <LineChart data={urlSeries} height={140} emptyText="该窗口无请求" />
              </div>
              <div className="section-title">HTTP 请求 · 按状态码</div>
              <div className="card mb-3">
                <LineChart data={statusSeries} height={140} emptyText="该窗口无请求" />
              </div>
            </>
          )}

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
