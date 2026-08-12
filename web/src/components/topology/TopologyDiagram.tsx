// 三层拓扑图（Agent → Tool → Model）：对齐 trace 详情轨迹图（TrajectoryGraph）风格。
// 圆角节点按角色着色（AGENT 蓝 / TOOL 粉 / MODEL 橙），左上角色标 + 右上小字，
// 名称 + 双行 mono 指标；贝塞尔边 + 箭头，线宽/透明度表示调用/共现强度。

import type {
  TopologyAgent,
  TopologyTool,
  TopologyModel,
} from "../../server/topology";
import { formatDuration, formatTokens, formatCost } from "../../lib/format";

const TOP_N = 10;
const NODE_W = 200;
const NODE_H = 64;
const ROW_H = 84; // 行距（含节点高）
const HEADER_Y = 24; // 列标题基线

const COL = { agent: 150, tool: 430, model: 710 } as const;
const VIEW_W = 880;

type Pos = { x: number; y: number };

export function TopologyDiagram({
  agents,
  tools,
  models,
}: {
  agents: TopologyAgent[];
  tools: TopologyTool[];
  models: TopologyModel[];
}) {
  const topAgents = agents.slice(0, TOP_N);
  const topTools = tools.slice(0, TOP_N);
  const topModels = models.slice(0, TOP_N);
  const modelNameSet = new Set(topModels.map((m) => m.name));

  const cy = (_: unknown[], i: number) => HEADER_Y + 46 + i * ROW_H;
  const agentCy = new Map(topAgents.map((a, i) => [a.name, cy(topAgents, i)]));
  const toolCy = new Map(topTools.map((t, i) => [t.name, cy(topTools, i)]));
  const modelCy = new Map(topModels.map((m, i) => [m.name, cy(topModels, i)]));

  const maxRows = Math.max(topAgents.length, topTools.length, topModels.length);
  const H = HEADER_Y + 46 + maxRows * ROW_H + 28;
  const maxToolCount = Math.max(1, ...topTools.map((t) => t.count));

  // 边：Agent→Tool（tool.agent 归属），Tool→Model（同 Trace 共现 Top 5，且模型在层内）
  const edges: Array<{ from: Pos; to: Pos; key: string; opacity: number }> = [];
  for (const t of topTools) {
    const ay = agentCy.get(t.agent);
    const ty = toolCy.get(t.name);
    if (ay != null && ty != null) {
      edges.push({
        from: { x: COL.agent, y: ay },
        to: { x: COL.tool, y: ty },
        key: `a-${t.agent}->${t.name}`,
        opacity: 0.35 + 0.45 * (t.count / maxToolCount),
      });
    }
    for (const m of t.models.slice(0, 5)) {
      const my = modelCy.get(m.name);
      if (my == null || !modelNameSet.has(m.name)) continue;
      edges.push({
        from: { x: COL.tool, y: ty ?? 0 },
        to: { x: COL.model, y: my },
        key: `m-${t.name}->${m.name}`,
        opacity: 0.35 + 0.45 * Math.min(m.count / Math.max(t.count, 1), 1),
      });
    }
  }

  const edgePath = (a: Pos, b: Pos) => {
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y;
    const x2 = b.x - NODE_W / 2;
    const y2 = b.y;
    const mx = x1 + (x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };

  const short = (s: string, n: number) =>
    s.length > n ? `${s.slice(0, n - 1)}…` : s;

  // 节点：左上角角色标 + 右上小字 + 名称 + 底部左右双指标
  const node = (
    x: number,
    y: number,
    fam: "agent" | "tool" | "llm",
    label: string,
    sub: string,
    name: string,
    attrL: string,
    attrR: string,
  ) => {
    const x0 = x - NODE_W / 2;
    const y0 = y - NODE_H / 2;
    return (
      <g key={`${fam}-${name}`} className="pn-node">
        <title>{`[${label}] ${name}\n${attrL} · ${attrR}`}</title>
        <rect
          x={x0}
          y={y0}
          width={NODE_W}
          height={NODE_H}
          rx={10}
          className={`pn-rect pn-${fam}`}
        />
        {/* 角色角标（左上） */}
        <rect
          x={x0 + 10}
          y={y0 + 8}
          width={62}
          height={16}
          rx={4}
          className={`pn-badge pn-badge-${fam}`}
        />
        <text x={x0 + 41} y={y0 + 20} textAnchor="middle" className="pn-label">
          {label}
        </text>
        {/* 右上小字 */}
        <text x={x0 + NODE_W - 12} y={y0 + 20} textAnchor="end" className="pn-sub">
          {sub}
        </text>
        {/* 名称 */}
        <text x={x0 + 14} y={y0 + 42} className="pn-name">
          {short(name, 18)}
        </text>
        {/* 底部双指标 */}
        <text x={x0 + 14} y={y0 + 57} className="pn-attr">
          {attrL}
        </text>
        <text x={x0 + NODE_W - 14} y={y0 + 57} textAnchor="end" className="pn-mono">
          {attrR}
        </text>
      </g>
    );
  };

  const colLabel = (x: number, text: string, count: number, more: number) => (
    <g key={text}>
      <text x={x} y={14} textAnchor="middle" className="pn-col">
        {text}
      </text>
      <text x={x} y={26} textAnchor="middle" className="pn-col-count">
        {count} 项{more > 0 ? `（+${more}）` : ""}
      </text>
    </g>
  );

  return (
    <div className="topo-wrap">
      <svg
        viewBox={`0 0 ${VIEW_W} ${H}`}
        width="100%"
        height="auto"
        role="img"
        aria-label="Agent 到 Tool 到 Model 的依赖拓扑图"
      >
        <style>{`
          .pn-node { cursor: default; }
          .pn-node:hover .pn-rect { filter: brightness(0.97); }
          .pn-col { fill: var(--text-mute); font: var(--weight-semibold) 12px/16px var(--font-sans); letter-spacing: 0.4px; }
          .pn-col-count { fill: var(--text-mute); font: var(--weight-regular) 10px/14px var(--font-mono); opacity: 0.75; }
          .pn-label { font: var(--weight-semibold) 10px/12px var(--font-mono); fill: #fff; letter-spacing: 0.4px; }
          .pn-sub { font: var(--weight-medium) 10px/12px var(--font-sans); fill: var(--text-mute); }
          .pn-name { font: var(--weight-semibold) 13px/18px var(--font-sans); fill: var(--text); }
          .pn-attr { font: var(--weight-regular) 11px/14px var(--font-mono); fill: var(--text-mute); }
          .pn-mono { font: var(--weight-regular) 11px/14px var(--font-mono); fill: var(--text-mute); }
          .pn-rect { stroke-width: 1.5; }
          .pn-agent { fill: var(--fam-agent-bg); stroke: var(--fam-agent); }
          .pn-tool { fill: var(--fam-tool-bg); stroke: var(--fam-tool); }
          .pn-llm { fill: var(--fam-llm-bg); stroke: var(--fam-llm); }
          .pn-badge-agent { fill: var(--fam-agent); }
          .pn-badge-tool { fill: var(--fam-tool); }
          .pn-badge-llm { fill: var(--fam-llm); }
          .pn-edge { fill: none; stroke: var(--text-mute); stroke-width: 1.4; }
        `}</style>
        <defs>
          <marker
            id="pn-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-mute)" />
          </marker>
        </defs>
        {colLabel(
          COL.agent,
          "AGENT",
          topAgents.length,
          Math.max(0, agents.length - TOP_N),
        )}
        {colLabel(
          COL.tool,
          "TOOL",
          topTools.length,
          Math.max(0, tools.length - TOP_N),
        )}
        {colLabel(
          COL.model,
          "MODEL",
          topModels.length,
          Math.max(0, models.length - TOP_N),
        )}
        {edges.map((e) => (
          <path
            key={e.key}
            d={edgePath(e.from, e.to)}
            className="pn-edge"
            style={{ strokeOpacity: e.opacity }}
            markerEnd="url(#pn-arrow)"
          />
        ))}
        {topAgents.map((a) =>
          node(
            COL.agent,
            agentCy.get(a.name)!,
            "agent",
            "AGENT",
            `${a.toolCount} 工具`,
            a.name,
            `${a.toolCalls} 调用`,
            `${a.llmCalls} 模型`,
          ),
        )}
        {topTools.map((t) =>
          node(
            COL.tool,
            toolCy.get(t.name)!,
            "tool",
            "TOOL",
            `${t.count} 次`,
            t.name,
            t.avgDur != null ? formatDuration(t.avgDur) : "—",
            `${t.models.length} 模型`,
          ),
        )}
        {topModels.map((m) =>
          node(
            COL.model,
            modelCy.get(m.name)!,
            "llm",
            "MODEL",
            `${m.count} 次`,
            m.name,
            formatTokens(m.tokens),
            formatCost(m.cost),
          ),
        )}
      </svg>
      {/* 图例（右下，复用 trace 详情图例样式） */}
      <div className="traj-legend">
        <span className="dot agent" /> AGENT
        <span className="dot tool" /> TOOL
        <span className="dot llm" /> MODEL
      </div>
    </div>
  );
}
