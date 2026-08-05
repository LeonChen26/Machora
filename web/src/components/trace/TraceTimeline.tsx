"use client";

// 时间线视图（参照 Langfuse TraceTimeline）：整行横条按时间定位渲染，
// 复用服务端算好的 left/width（%），点条选中 → 右侧面板联动（SelectionContext）。

import { useCallback, useMemo, useState } from "react";
import { useSelection, type TraceRow } from "./contexts";
import { formatDuration } from "../../lib/format";

const ROW_H = 36; // 固定行高（虚拟化窗口计算基准）
const OVERSCAN = 12;

export function TraceTimeline({
  rows,
  spanMs,
}: {
  rows: TraceRow[];
  spanMs: number;
}) {
  const { selectedId, select } = useSelection();
  const [w0, setW0] = useState(0);
  const [w1, setW1] = useState(() => Math.min(rows.length, 40));

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const from = Math.floor(el.scrollTop / ROW_H);
      const count = Math.ceil(el.clientHeight / ROW_H);
      setW0(Math.max(0, from - OVERSCAN));
      setW1(Math.min(rows.length, from + count + OVERSCAN));
    },
    [rows.length],
  );

  const visible = useMemo(
    () => rows.slice(w0, w1),
    [rows, w0, w1],
  );

  return (
    <div className="table-wrap tree-virtual tl-view" onScroll={onScroll}>
      {/* 头部刻度：0 / 50% / 总跨度 */}
      <div className="tl-head" aria-hidden="true">
        <span className="tl-name-col">名称</span>
        <span className="tl-track-col">
          <span className="gantt-scale">
            {[0, 50, 100].map((p) => (
              <span key={p} style={{ left: `${p}%` }}>
                {p === 0 ? "0" : p === 50 ? "50%" : formatDuration(spanMs)}
              </span>
            ))}
          </span>
        </span>
        <span className="tl-dur-col">耗时</span>
      </div>
      <div
        className="tl-window"
        style={{
          paddingTop: w0 * ROW_H,
          paddingBottom: (rows.length - w1) * ROW_H,
        }}
      >
        {visible.map((o) => (
          <div
            key={o.id}
            data-obs={o.id}
            className={`tl-row${selectedId === o.id ? " selected" : ""}`}
            data-level={o.level ?? undefined}
            tabIndex={0}
            onClick={() => select(o.id)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              select(o.id);
            }}
          >
            <span className="tl-name" style={{ paddingLeft: o.depth * 10 }}>
              {(o.level === "ERROR" || o.level === "WARNING") && (
                <span
                  className={`status-dot ${o.level === "ERROR" ? "danger" : "warn"}`}
                  title={o.level}
                  aria-label={`级别 ${o.level}`}
                />
              )}
              <span className="obs-name">
                {o.name || <span className="mute2">（未命名）</span>}
              </span>
              <span className={`badge ${o.typeColor}`}>{o.type === "GENERATION" ? "GEN" : o.type}</span>
            </span>
            <span className="tl-track">
              <span
                className={`tl-bar${o.level === "ERROR" ? " err" : ""}`}
                style={{
                  left: `${o.left}%`,
                  width: `${o.width}%`,
                  backgroundColor: o.barColor,
                }}
                title={`${o.name || o.id} · ${formatDuration(o.dur)}`}
              />
            </span>
            <span className="tl-dur mono">{formatDuration(o.dur)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
