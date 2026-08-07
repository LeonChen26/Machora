"use client";

// 推理轨迹拓扑图（对标 AgentLoop 拓扑风格）：
// DAG 分层按 depth 排列，每层垂直堆叠，节点按角色着色，贝塞尔边 + 箭头。
// 节点点击 → useSelection 联动，右侧详情面板弹出；选中高亮描边 + 阴影。
// event / other 不占行（服务端已聚合），此组件只画主链。

import { useMemo } from "react";
import type { TrajectoryKind } from "@machora/shared";
import { useSelection } from "./contexts";
import type { TrajectoryRow } from "../../server/trajectory";

const NODE_W = 280;
const NODE_H = 84;
const LAYER_GAP = 160; // 水平层间距（节点右侧 → 下一节点左侧）
const ROW_GAP = 28; // 同层垂直行距
const PAD_X = 36;
const PAD_Y = 36;

/** 12 kind → 视觉族（对齐 AgentLoop ENTRY/AGENT/STEP/LLM/TOOL 五色语义） */
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
  event: "step", // 理论上 event 不占行，兜底为 step 色
  other: "step",
};

const FAM_LABEL: Record<Fam, string> = {
  entry: "ENTRY",
  agent: "AGENT",
  step: "STEP",
  llm: "LLM",
  tool: "TOOL",
};

const KIND_SUBLABEL: Record<TrajectoryKind, string> = {
  entry: "入口",
  agent: "Agent",
  workflow: "工作流",
  think: "思考",
  retrieval: "检索",
  memory: "记忆",
  skill: "技能",
  llm: "模型",
  embedding: "嵌入",
  tool: "工具",
  event: "日志",
  other: "其他",
};

type Pos = { x: number; y: number };

export function TrajectoryGraph({ rows }: { rows: TrajectoryRow[] }) {
  const { selectedId, select } = useSelection();

  // 1) 按 layer（=depth）分组，保留先序顺序
  const byLayer = useMemo(() => {
    const map = new Map<number, TrajectoryRow[]>();
    for (const r of rows) {
      if (!map.has(r.depth)) map.set(r.depth, []);
      map.get(r.depth)!.push(r);
    }
    // 按 depth 升序
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  // 2) 计算每个节点坐标 & 总画布尺寸
  const { pos, width, height, layerCount } = useMemo(() => {
    const pos = new Map<string, Pos>();
    let maxLayerSize = 0;
    const layerCount = Math.max(1, byLayer.length);
    for (const [, layerRows] of byLayer) {
      maxLayerSize = Math.max(maxLayerSize, layerRows.length);
    }
    for (const [layer, layerRows] of byLayer) {
      const cx = PAD_X + NODE_W / 2 + layer * (NODE_W + LAYER_GAP);
      layerRows.forEach((r, i) => {
        const cy = PAD_Y + NODE_H / 2 + i * (NODE_H + ROW_GAP);
        // 垂直居中：让每层都相对最大层居中（视觉对齐 AgentLoop 的错落）
        const shift = ((maxLayerSize - layerRows.length) * (NODE_H + ROW_GAP)) / 2;
        pos.set(r.id, { x: cx, y: cy + shift });
      });
    }
    const width = PAD_X * 2 + layerCount * NODE_W + (layerCount - 1) * LAYER_GAP;
    const height = PAD_Y * 2 + maxLayerSize * NODE_H + (maxLayerSize - 1) * ROW_GAP;
    return { pos, width, height, layerCount };
  }, [byLayer]);

  if (rows.length === 0) return null;

  // 3) 边：对每个非根节点，连 parentId → id
  const edges: Array<{ from: Pos; to: Pos; key: string }> = [];
  for (const r of rows) {
    if (!r.parentId) continue;
    const a = pos.get(r.parentId);
    const b = pos.get(r.id);
    if (!a || !b) continue;
    edges.push({ from: a, to: b, key: `${r.parentId}->${r.id}` });
  }

  // 4) 节点渲染
  const renderNode = (r: TrajectoryRow) => {
    const p = pos.get(r.id);
    if (!p) return null;
    const fam = FAM_OF_KIND[r.kind];
    const sel = selectedId === r.id;
    const isErr = r.level === "ERROR";
    const isWarn = r.level === "WARNING";
    const cls = `tn-${fam}${sel ? " selected" : ""}${isErr ? " is-error" : ""}${isWarn ? " is-warn" : ""}${r.loop ? " is-loop" : ""}`;

    const x = p.x - NODE_W / 2;
    const y = p.y - NODE_H / 2;
    const label = KIND_SUBLABEL[r.kind];
    const famLabel = FAM_LABEL[fam];
    const name = r.name || "（未命名）";
    const nameShort = name.length > 34 ? `${name.slice(0, 32)}…` : name;

    return (
      <g
        key={r.id}
        className="t-node"
        onClick={() => select(r.id)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          select(r.id);
        }}
        role="button"
        tabIndex={0}
        aria-label={`${label} ${name}`}
      >
        <title>
          {`[${label}${r.loop && r.badge ? ` · ${r.badge}` : ""}${r.level === "ERROR" ? " · ERROR" : r.level === "WARNING" ? " · WARNING" : ""}] ${name}\n耗时: ${formatDur(r.dur)}${r.model ? `\n模型: ${r.model}` : ""}${r.events > 0 ? `\n聚合日志: ${r.events} 条` : ""}${r.others > 0 ? `\n其他调用: ${r.others} 条` : ""}`}
        </title>
        {/* 点击热区（比可视区略大） */}
        <rect
          x={x - 2}
          y={y - 2}
          width={NODE_W + 4}
          height={NODE_H + 4}
          rx={12}
          fill="transparent"
        />
        <rect
          x={x}
          y={y}
          width={NODE_W}
          height={NODE_H}
          rx={10}
          className={cls}
        />
        {/* 角色角标（左上，AgentLoop 风格） */}
        <rect x={x + 10} y={y + 8} width={56} height={16} rx={4} className={`tn-badge tn-badge-${fam}`} />
        <text
          x={x + 38}
          y={y + 20}
          textAnchor="middle"
          className="t-label"
        >
          {famLabel}
        </text>
        {/* 子类型标签（右上小字） */}
        <text x={x + NODE_W - 12} y={y + 20} textAnchor="end" className="t-sub">
          {label}
        </text>
        {/* 名称 */}
        <text x={x + 14} y={y + 44} className="t-name">
          {nameShort}
        </text>
        {/* 底部两行：左 attributes，右上 duration，右下 model（分行避免重叠） */}
        <text x={x + 14} y={y + 62} className="t-attr">
          attributes
        </text>
        <text x={x + NODE_W - 14} y={y + 62} textAnchor="end" className="t-dur mono">
          {formatDur(r.dur)}
        </text>
        {r.model && (
          <text x={x + NODE_W - 14} y={y + 78} textAnchor="end" className="t-mono2 mono">
            {r.model.length > 20 ? `${r.model.slice(0, 18)}…` : r.model}
          </text>
        )}

        {/* 循环 badge（右上角悬浮） */}
        {r.loop && r.badge && (
          <g>
            <rect
              x={x + NODE_W - 112}
              y={y - 10}
              width={108}
              height={18}
              rx={4}
              className={`tn-loop-badge${r.loopLevel === "ineffective" ? " is-bad" : ""}`}
            />
            <text
              x={x + NODE_W - 58}
              y={y + 3}
              textAnchor="middle"
              className="t-loop-text"
            >
              {r.badge.length > 14 ? `${r.badge.slice(0, 12)}…` : r.badge}
            </text>
          </g>
        )}
        {/* 事件/其他聚合徽标（右下，圆角） */}
        {(r.events > 0 || r.others > 0) && (
          <g>
            {r.events > 0 && (
              <>
                <rect x={x + NODE_W - 10} y={y + NODE_H - 10} width={28} height={16} rx={8} className="tn-acc-badge" />
                <text x={x + NODE_W + 4} y={y + NODE_H + 2} textAnchor="middle" className="t-acc-text">
                  📝{r.events}
                </text>
              </>
            )}
            {r.others > 0 && (
              <>
                <rect
                  x={x + NODE_W - 10 + (r.events > 0 ? 32 : 0)}
                  y={y + NODE_H - 10}
                  width={28}
                  height={16}
                  rx={8}
                  className="tn-acc-badge"
                />
                <text
                  x={x + NODE_W + 4 + (r.events > 0 ? 32 : 0)}
                  y={y + NODE_H + 2}
                  textAnchor="middle"
                  className="t-acc-text"
                >
                  ···{r.others}
                </text>
              </>
            )}
          </g>
        )}
      </g>
    );
  };

  // 5) 连线渲染（bezier + 箭头标签 + marker 箭头）
  const edgePath = (a: Pos, b: Pos) => {
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y;
    const x2 = b.x - NODE_W / 2;
    const y2 = b.y;
    const mx1 = x1 + (x2 - x1) * 0.5;
    const mx2 = x1 + (x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${mx1} ${y1}, ${mx2} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="traj-graph" role="img" aria-label="推理轨迹拓扑图">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMin meet"
      >
        <style>{`
          .t-node { cursor: pointer; }
          .t-node:hover .tn-entry, .t-node:hover .tn-agent, .t-node:hover .tn-step,
          .t-node:hover .tn-llm, .t-node:hover .tn-tool { filter: brightness(0.98); }
          .t-label { font: var(--weight-semibold) 10px/12px var(--font-mono); fill: #fff; letter-spacing: 0.4px; }
          .t-sub { font: var(--weight-medium) 10px/12px var(--font-sans); fill: var(--text-mute); }
          .t-name { font: var(--weight-semibold) 13px/18px var(--font-sans); fill: var(--text); }
          .t-attr { font: var(--weight-regular) 11px/14px var(--font-mono); fill: var(--text-mute); }
          .t-dur { font: var(--weight-regular) 11px/14px var(--font-mono); fill: var(--text-mute); }
          .t-mono2 { font: var(--weight-regular) 10px/12px var(--font-mono); fill: var(--text-mute); opacity: 0.85; }
          .t-loop-text { font: var(--weight-semibold) 10px/12px var(--font-sans); fill: #fff; }
          .t-acc-text { font: var(--weight-semibold) 10px/12px var(--font-sans); fill: var(--text-mute); }
          .t-edge { stroke: var(--text-mute); fill: none; stroke-width: 1.4; stroke-opacity: 0.7; }
          .t-edge-label { font: var(--weight-medium) 10px/12px var(--font-sans); fill: var(--text-mute); }
          .tn-entry { fill: var(--fam-entry-bg); stroke: var(--fam-entry); stroke-width: 1.5; }
          .tn-agent { fill: var(--fam-agent-bg); stroke: var(--fam-agent); stroke-width: 1.5; }
          .tn-step { fill: var(--fam-step-bg); stroke: var(--fam-step); stroke-width: 1.5; }
          .tn-llm { fill: var(--fam-llm-bg); stroke: var(--fam-llm); stroke-width: 1.5; }
          .tn-tool { fill: var(--fam-tool-bg); stroke: var(--fam-tool); stroke-width: 1.5; }
          .tn-badge-entry { fill: var(--fam-entry); }
          .tn-badge-agent { fill: var(--fam-agent); }
          .tn-badge-step { fill: var(--fam-step); }
          .tn-badge-llm { fill: var(--fam-llm); }
          .tn-badge-tool { fill: var(--fam-tool); }
          .t-node .selected { stroke-width: 3; filter: drop-shadow(0 6px 14px rgba(0,0,0,0.08)); }
          .tn-entry.selected { stroke: var(--brand); }
          .tn-agent.selected { stroke: var(--brand); }
          .tn-step.selected { stroke: var(--brand); }
          .tn-llm.selected { stroke: var(--brand); }
          .tn-tool.selected { stroke: var(--brand); }
          .t-node .is-error { stroke: var(--red) !important; stroke-width: 2.5; }
          .t-node .is-warn { stroke: var(--amber) !important; stroke-width: 2.2; }
          .t-node .is-loop { stroke-dasharray: 6 3; }
          .tn-loop-badge { fill: var(--amber); }
          .tn-loop-badge.is-bad { fill: var(--red); }
          .tn-acc-badge { fill: var(--surface-muted); stroke: var(--border); stroke-width: 1; }
        `}</style>
        <defs>
          <marker
            id="t-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-mute)" />
          </marker>
        </defs>
        {/* 先画边（后画节点，让节点覆盖线头） */}
        {edges.map((e) => {
          return (
            <path
              key={e.key}
              d={edgePath(e.from, e.to)}
              className="t-edge"
              markerEnd="url(#t-arrow)"
            />
          );
        })}
        {rows.map(renderNode)}
        {/* 画布右下角占位，避免箭头标签与循环徽标溢出裁剪 */}
      </svg>
      {/* 图例（右下固定，参考截图） */}
      <div className="traj-legend">
        <span className="dot entry" /> ENTRY
        <span className="dot agent" /> AGENT
        <span className="dot step" /> STEP
        <span className="dot llm" /> LLM
        <span className="dot tool" /> TOOL
      </div>
    </div>
  );
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
