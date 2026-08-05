"use client";

// 虚拟化调用树：固定行高 + 只渲染可见窗口（参照 Langfuse VirtualizedTree 的
// rowHeight 预算方案），避免大 trace 一次性输出全部 DOM 行。
// 行数据（TraceRow）由服务端拍平并算好时间轴定位，此处纯展示 + 选中。

import { useCallback, useMemo, useState } from "react";
import { useSelection, type TraceRow } from "./contexts";
import { CopyButton } from "../CopyButton";
import { formatDuration, formatDateTime } from "../../lib/format";

const ROW_H = 36; // 固定行高（虚拟化窗口计算基准）
const OVERSCAN = 12; // 可见窗口上下额外预渲染行数

function typeLabel(t: string): string {
  return t === "GENERATION" ? "GEN" : t;
}

export function TraceTree({ rows, spanMs }: { rows: TraceRow[]; spanMs: number }) {
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
    <div className="table-wrap tree-virtual" onScroll={onScroll}>
      <table>
        <thead>
          <tr>
            <th scope="col">名称 / 类型</th>
            <th scope="col" className="col-gantt">
              时间轴
            </th>
            <th scope="col" className="col-dur">
              耗时
            </th>
          </tr>
          {/* 统一刻度：只在表头显示一次，对齐时间轴列 */}
          <tr className="gantt-scale-row" aria-hidden="true">
            <td></td>
            <td>
              <div className="gantt-scale">
                {[0, 50, 100].map((p) => (
                  <span key={p} style={{ left: `${p}%` }}>
                    {p === 0 ? "0" : p === 50 ? "50%" : formatDuration(spanMs)}
                  </span>
                ))}
              </div>
            </td>
            <td></td>
          </tr>
        </thead>
        {/* spacer 行撑出完整滚动高度（tbody padding 在 border-collapse: collapse
            下不生效），仅渲染可见窗口行 */}
        <tbody>
          {w0 > 0 && (
            <tr aria-hidden="true" className="spacer" style={{ height: w0 * ROW_H }}>
              <td colSpan={3} />
            </tr>
          )}
          {visible.map((o, i) => {
            const barTip =
              `${o.name || o.id}\n` +
              `${formatDateTime(new Date(o.start))} → ${o.end ? formatDateTime(new Date(o.end)) : "—"}\n` +
              `耗时 ${formatDuration(o.dur)}`;
            // 下一行深度决定本行各层级竖线是否向下延续（窗口最后一行无 next 时全不画）
            const nextDepth = rows[w0 + i + 1]?.depth ?? -1;
            return (
              <tr
                key={o.id}
                data-obs={o.id}
                data-level={o.level ?? undefined}
                className={selectedId === o.id ? "selected" : undefined}
                tabIndex={0}
                onClick={() => select(o.id)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  select(o.id);
                }}
              >
                <td>
                  <div className="obs-cell">
                    {o.depth > 0 && (
                      <span
                        className="tree-guides"
                        aria-hidden="true"
                        style={{ width: o.depth * 14 }}
                      >
                        {Array.from({ length: o.depth }).map((_, g) => (
                          <span key={g} className={nextDepth > g ? "guide" : "guide off"} />
                        ))}
                      </span>
                    )}
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
                    <span className={`badge ${o.typeColor}`}>{typeLabel(o.type)}</span>
                    {o.model && <span className="mono mute2 text-xs">{o.model}</span>}
                    <span
                      className="mono mute2 text-xs obs-id"
                      title={o.id}
                    >
                      {o.id.slice(0, 8)}
                      <span className="copy-btn-inline">
                        <CopyButton text={o.id} />
                      </span>
                    </span>
                  </div>
                </td>
                <td>
                  <div className="gantt-col">
                    <div className="gantt-track" title={barTip}>
                      <div
                        className="gantt-bar"
                        style={{
                          left: `${o.left}%`,
                          width: `${o.width}%`,
                          background: o.barColor,
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td className="mono">{formatDuration(o.dur)}</td>
              </tr>
            );
          })}
          {rows.length - w1 > 0 && (
            <tr aria-hidden="true" className="spacer" style={{ height: (rows.length - w1) * ROW_H }}>
              <td colSpan={3} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
