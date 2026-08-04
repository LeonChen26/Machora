import { and, desc, eq, gte } from "drizzle-orm";
import { db, metricSample, SYSTEM_PROJECT_ID, getSelfStartedAt } from "@machora/shared";
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
