import type { ReactNode } from "react";

function delta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  if (a === 0) return null;
  return (b - a) / a;
}

function pct(v: number): string {
  const r = v * 100;
  return `${r >= 0 ? "↑" : "↓"}${Math.abs(r).toFixed(0)}%`;
}

/** 环比变化单元格：相对前一窗口 涨（恶化）红 / 跌（改善）绿 / 持平灰 */
export function deltaCell(cur: number | null, prev: number | null): ReactNode {
  const d = delta(prev, cur);
  if (d == null) return <span className="mute2">—</span>;
  const cls = d > 0.05 ? "delta-up" : d < -0.05 ? "delta-down" : "delta-flat";
  return (
    <span className={cls} title="相对前一窗口">
      {pct(d)}
    </span>
  );
}
