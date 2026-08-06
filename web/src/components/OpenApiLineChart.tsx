// 轻量多系列折线图（纯 SVG，无第三方依赖；服务端组件可用）。
// System 页 OpenAPI 流量专用：与 components/LineChart.tsx（HTTP 请求图）API 不同，
// 本组件由调用方给定完整时间窗（xDomain + xTicks），刻度铺满整窗；
// 折线只绘制有数据的时间点，缺失区间不补点、不连线
// （相邻数据点间隔超过 gapMs 时折线断开）。

export interface OpenApiChartPoint {
  /** 桶起点时间戳（x 轴定位） */
  ts: number;
  value: number;
  /** 悬停提示文本（如桶 label） */
  label?: string;
}

export interface OpenApiSeries {
  name: string;
  color: string;
  /** 只含有数据的点，按 ts 升序 */
  data: OpenApiChartPoint[];
}

export interface OpenApiAxisTick {
  ts: number;
  label: string;
}

const W = 600;
const H = 220;
const PAD = { top: 16, right: 42, bottom: 26, left: 14 };

/** 取不小于 v 的"整齐"上限（1/2/2.5/5 × 10^n），保证 y 轴刻度易读 */
function niceCeil(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * p) return m * p;
  }
  return 10 * p;
}

function fmt(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 把点序列按 x 间距切分为多段（gapX 为断开的间距阈值） */
function lineSegments(
  pts: { x: number; y: number }[],
  gapX: number,
): string[][] {
  if (pts.length === 0) return [];
  const segs: string[][] = [];
  let cur = [`${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`];
  for (let i = 1; i < pts.length; i++) {
    if (gapX > 0 && pts[i].x - pts[i - 1].x > gapX) {
      segs.push(cur);
      cur = [];
    }
    cur.push(`${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`);
  }
  segs.push(cur);
  return segs;
}

export function OpenApiLineChart({
  series,
  xDomain,
  xTicks,
  gapMs = 0,
  height = 220,
  emptyText = "暂无数据",
}: {
  series: OpenApiSeries[];
  /** 完整时间窗 [起始, 结束]（毫秒），x 轴按比例映射 */
  xDomain: [number, number];
  /** 完整时间轴刻度（组件按需稀疏显示） */
  xTicks: OpenApiAxisTick[];
  /** 相邻数据点超过该间隔（毫秒）时断开折线；0 = 不断开 */
  gapMs?: number;
  height?: number;
  emptyText?: string;
}) {
  const hasData = series.some((s) => s.data.length > 0);
  if (!hasData) {
    return (
      <div
        style={{
          height,
          display: "grid",
          placeItems: "center",
          color: "var(--text-mute)",
          fontSize: 13,
        }}
      >
        {emptyText}
      </div>
    );
  }

  const maxV = Math.max(
    ...series.flatMap((s) => s.data.map((d) => d.value)),
    0,
  );
  const yMax = niceCeil(maxV);
  const [x0, x1] = xDomain;
  const span = x1 - x0 || 1;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (ts: number) => PAD.left + ((ts - x0) / span) * innerW;
  const y = (v: number) => PAD.top + (1 - v / yMax) * innerH;
  const gapX = (gapMs / span) * innerW;
  const dotR = xTicks.length > 24 ? 1.8 : xTicks.length > 12 ? 2.2 : 2.6;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    f,
    y: PAD.top + (1 - f) * innerH,
    label: fmt(yMax * f),
  }));
  const labelStep = Math.max(1, Math.ceil(xTicks.length / 8));

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 8,
          fontSize: 12,
          color: "var(--text-dim)",
        }}
      >
        {series.map((s) => {
          const total = s.data.reduce((acc, d) => acc + d.value, 0);
          return (
            <span
              key={s.name}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 14,
                  height: 3,
                  borderRadius: 2,
                  background: s.color,
                  display: "inline-block",
                }}
              />
              {s.name}
              <span
                style={{
                  color: "var(--text-mute)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmt(total)}
              </span>
            </span>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={height}
        role="img"
        aria-label={series
          .map((s) => `${s.name} ${fmt(s.data.reduce((a, d) => a + d.value, 0))}`)
          .join("，")}
        style={{ display: "block", fontFamily: "var(--mono)", fontSize: 10 }}
      >
        {grid.map((g) => (
          <g key={g.f}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={g.y}
              y2={g.y}
              stroke="var(--border-soft)"
              strokeDasharray={g.f === 0 ? "0" : "3 4"}
            />
            <text x={W - PAD.right + 4} y={g.y + 3} fill="var(--text-mute)">
              {g.label}
            </text>
          </g>
        ))}

        {series.map((s) => {
          const pts = s.data.map((d) => ({ x: x(d.ts), y: y(d.value) }));
          const segs = lineSegments(pts, gapX);
          return (
            <g key={s.name}>
              {segs.map((points, si) => (
                <polyline
                  key={si}
                  points={points.join(" ")}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
              ))}
              {s.data.map((d, i) => (
                <circle
                  key={i}
                  cx={x(d.ts)}
                  cy={y(d.value)}
                  r={dotR}
                  fill={s.color}
                >
                  <title>{`${d.label ?? ""}：${s.name} ${d.value}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

        {xTicks.map((t, i) =>
          i % labelStep === 0 ? (
            <text
              key={i}
              x={x(t.ts)}
              y={H - 8}
              textAnchor="middle"
              fill="var(--text-mute)"
            >
              {t.label}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
