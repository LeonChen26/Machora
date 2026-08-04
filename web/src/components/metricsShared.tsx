import { BarChart } from "./BarChart";

// 指标展示公共部分：时间窗定义、数值格式化、按指标名聚合、卡片网格。
// /metrics（项目上报指标）与 /system（自运维指标）共用，避免两套逻辑漂移。

export const RANGES = [
  { key: "1h", label: "1 小时", ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000, timeKey: "hm" },
  { key: "24h", label: "24 小时", ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, timeKey: "h" },
  { key: "7d", label: "7 天", ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000, timeKey: "d" },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export const MAX_SAMPLES = 3000;

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function bucketLabel(t: Date, range: (typeof RANGES)[number]): string {
  if (range.timeKey === "hm") {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  if (range.timeKey === "h") return `${String(t.getHours()).padStart(2, "0")}:00`;
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

export function attrsText(attrs: unknown): string {
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

export interface MetricAgg {
  unit: string | null;
  kind: string;
  latest: { value: number | null; ts: number } | null;
  count: number;
  total: number;
  buckets: Map<number, number>;
}

/** 按指标名聚合一组采样（最新值 / 样本数 / 总 sum / chart 桶 sum） */
export function aggregate(
  samples: { name: string; kind: string; unit: string | null; value: number | null; timestamp: Date }[],
  bucketMs: number,
): Map<string, MetricAgg> {
  const byName = new Map<string, MetricAgg>();
  for (const s of samples) {
    const e = byName.get(s.name) ?? {
      unit: s.unit,
      kind: s.kind,
      latest: null,
      count: 0,
      total: 0,
      buckets: new Map<number, number>(),
    };
    const ts = s.timestamp.getTime();
    if (!e.latest || ts > e.latest.ts) {
      e.latest = { value: s.value, ts };
    }
    e.count++;
    e.total += s.value ?? 0;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    e.buckets.set(key, (e.buckets.get(key) ?? 0) + (s.value ?? 0));
    byName.set(s.name, e);
  }
  return byName;
}

/** 走势卡片网格：每指标一张卡（最新值 / 样本数均值 / 时间桶 bar 图） */
export function MetricCardGrid({
  samples,
  range,
}: {
  samples: { name: string; kind: string; unit: string | null; value: number | null; timestamp: Date }[];
  range: (typeof RANGES)[number];
}) {
  const byName = aggregate(samples, range.bucketMs);
  const names = Array.from(byName.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (names.length === 0) return null;
  return (
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
            <BarChart data={chartData} height={90} emptyText="该窗口无采样" />
          </div>
        );
      })}
    </div>
  );
}
