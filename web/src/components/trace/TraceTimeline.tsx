"use client";

// 时间线视图（参照 Langfuse TraceTimeline）：整行横条按时间定位渲染，
// 复用服务端算好的 left/width（%），点条选中 → 右侧面板联动（SelectionContext）。
// v4 改造：语义与调用树对齐，类型徽标前置；时间线直接拍平，不体现调用关系。

import { useCallback, useMemo, useState } from "react";
import { useSelection, type TraceRow } from "./contexts";
import { formatDuration } from "../../lib/format";
import type { TrajectoryKind } from "@machora/shared";

const ROW_H = 36; // 固定行高（虚拟化窗口计算基准）
const OVERSCAN = 12;

type Fam = "entry" | "agent" | "step" | "llm" | "tool";

const FAM_OF_KIND: Record<TrajectoryKind, Fam> = {
  entry: "entry",
  agent: "agent",
  workflow: "agent",
  think: "step",
  retrieval: "step",
  memory: "step",
  skill: "step",
  llm: "llm",
  embedding: "llm",
  tool: "tool",
  event: "step",
  other: "step",
};

// 五色板来自 globals.css 的 --fam-* 变量（基色 + color-mix 软底随主题深浅），
// 与调用树徽标 / TrajectoryGraph 节点保持同族同色；时间线条同色系着色。

const FAM_LABEL: Record<Fam, string> = {
  entry: "ENTRY",
  agent: "AGENT",
  step: "STEP",
  llm: "LLM",
  tool: "TOOL",
};

/** 时间线条颜色：异常优先红/琥珀（与调用树左指示条语义一致），正常按 kind 五色族着色 */
function barColorFor(o: TraceRow): string {
  if (o.level === "ERROR") return "var(--red)";
  if (o.level === "WARNING") return "var(--amber)";
  return `var(--fam-${FAM_OF_KIND[o.kind]})`;
}

export function TraceTimeline({
  rows,
}: {
  rows: TraceRow[];
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

  // 耗时列统一宽度：取所有行中格式化后最长的文本长度（ch，mono 等宽单位），
  // 表头与数据列共用同一宽度 → 列宽一致，避免表头"耗时"与数字错位。
  const durW = useMemo(() => {
    let max = 4; // 至少容纳 "3.80s" 这类常见值
    for (const r of rows) {
      max = Math.max(max, formatDuration(r.dur).length);
    }
    return `${max}ch`;
  }, [rows]);

  return (
    <div className="table-wrap tree-virtual tl-view" onScroll={onScroll}>
      {/* 头部：名称 / 时间轴 / 耗时（时间轴只保留颜色条，不显示刻度） */}
      <div className="tl-head" aria-hidden="true">
        <span className="tl-name-col">名称</span>
        <span className="tl-dur-col" style={{ width: durW }}>耗时</span>
        <span className="tl-track-col">时间轴</span>
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
            <span className="tl-name">
              {/* 类型徽标：与调用树 v4 对齐，名称列最左侧 */}
              <KindBadge kind={o.kind} />
              {/* 异常级别小圆点 */}
              {(o.level === "ERROR" || o.level === "WARNING") && (
                <span
                  className={`status-dot ${o.level === "ERROR" ? "danger" : "warn"}`}
                  title={o.level}
                  aria-label={`级别 ${o.level}`}
                />
              )}
              {/* 名称 */}
              <span className="obs-name">
                {o.name || <span className="mute2">（未命名）</span>}
              </span>
            </span>
            <span className="tl-dur mono" style={{ width: durW }}>{formatDuration(o.dur)}</span>
            <span className="tl-track">
              <span
                className={`tl-bar${o.level === "ERROR" ? " err" : ""}`}
                style={{
                  left: `${o.left}%`,
                  width: `${o.width}%`,
                  backgroundColor: barColorFor(o),
                }}
                title={`${o.name || o.id} · ${formatDuration(o.dur)}`}
              />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: TrajectoryKind }) {
  const fam = FAM_OF_KIND[kind];
  return (
    <span
      className={`k-badge k-${fam}`}
      style={{
        background: `var(--fam-${fam}-bg)`,
        color: `var(--fam-${fam})`,
        borderColor: `var(--fam-${fam})`,
      }}
      aria-label={`分类 ${FAM_LABEL[fam]}`}
    >
      {FAM_LABEL[fam]}
    </span>
  );
}
