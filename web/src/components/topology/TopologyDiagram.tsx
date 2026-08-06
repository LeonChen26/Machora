// 三层拓扑图（Agent → Tool → Model）：服务端纯 SVG，按调用次数排布。
// 每层只渲染 Top N，节点居中三列，边按权重调透明度；超出部分在列首注明。

import type {
  TopologyAgent,
  TopologyTool,
  TopologyModel,
} from "../../server/topology";

const TOP_N = 10;
const NODE_W = 200;
const NODE_H = 30;
const ROW_H = 44;
const HEADER_Y = 24;

const COL = { agent: 130, tool: 360, model: 590 } as const;

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

  const cy = (arr: unknown[], i: number) =>
    HEADER_Y + 34 + i * ROW_H;
  const agentCy = new Map(topAgents.map((a, i) => [a.name, cy(topAgents, i)]));
  const toolCy = new Map(topTools.map((t, i) => [t.name, cy(topTools, i)]));
  const modelCy = new Map(topModels.map((m, i) => [m.name, cy(topModels, i)]));

  const maxRows = Math.max(topAgents.length, topTools.length, topModels.length);
  const H = HEADER_Y + 34 + maxRows * ROW_H + 24;
  const maxToolCount = Math.max(1, ...topTools.map((t) => t.count));

  // 边：Agent→Tool（tool.agent 归属），Tool→Model（共现 Top 5，且模型在层内）
  interface Edge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    opacity: number;
  }
  const edges: Edge[] = [];
  for (const t of topTools) {
    const ay = agentCy.get(t.agent);
    const ty = toolCy.get(t.name);
    if (ay != null && ty != null) {
      edges.push({
        x1: COL.agent + NODE_W / 2,
        y1: ay,
        x2: COL.tool - NODE_W / 2,
        y2: ty,
        opacity: 0.2 + 0.45 * (t.count / maxToolCount),
      });
    }
    for (const m of t.models.slice(0, 5)) {
      const my = modelCy.get(m.name);
      if (my == null || !modelNameSet.has(m.name)) continue;
      edges.push({
        x1: COL.tool + NODE_W / 2,
        y1: ty ?? 0,
        x2: COL.model - NODE_W / 2,
        y2: my,
        opacity: 0.2 + 0.45 * Math.min(m.count / Math.max(t.count, 1), 1),
      });
    }
  }

  const short = (s: string) =>
    s.length > 20 ? `${s.slice(0, 17)}…` : s;

  const node = (x: number, y: number, label: string, cls: string, sub?: string) => (
    <g key={`${x}-${y}-${label}`}>
      <rect
        x={x - NODE_W / 2}
        y={y - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={8}
        className={cls}
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        className={cls === "n-agent" ? "topo-text brand" : cls === "n-model" ? "topo-text accent" : "topo-text"}
        style={{ font: "var(--weight-medium) 12px/18px var(--font-mono)" }}
      >
        {short(label)}
      </text>
      {sub && (
        <text x={x} y={y + 20} textAnchor="middle" className="topo-sub">
          {sub}
        </text>
      )}
    </g>
  );

  const colLabel = (x: number, text: string, more: number) => (
    <text x={x} y={16} textAnchor="middle" className="topo-col">
      {text}
      {more > 0 ? `（+${more}）` : ""}
    </text>
  );

  return (
    <svg
      viewBox={`0 0 720 ${H}`}
      width="100%"
      height="auto"
      role="img"
      aria-label="Agent 到 Tool 到 Model 的依赖拓扑图"
    >
      <style>{`
        .topo-col { fill: var(--text-mute); font: var(--weight-medium) var(--text-caption) var(--font-sans); }
        .topo-text { fill: var(--text); }
        .topo-text.brand { fill: var(--brand-text); }
        .topo-text.accent { fill: var(--accent-text); }
        .topo-sub { fill: var(--text-mute); font: var(--weight-regular) var(--text-caption) var(--font-sans); }
        .n-agent { fill: var(--brand-soft); stroke: var(--brand); }
        .n-tool { fill: var(--surface-muted); stroke: var(--border); }
        .n-model { fill: var(--accent-soft); stroke: var(--accent); }
      `}</style>
      {colLabel(COL.agent, "Agent", Math.max(0, agents.length - TOP_N))}
      {colLabel(COL.tool, "Tool", Math.max(0, tools.length - TOP_N))}
      {colLabel(COL.model, "Model", Math.max(0, models.length - TOP_N))}
      {edges.map((e, i) => (
        <line
          key={i}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke="var(--text-mute)"
          strokeWidth={1.5}
          strokeOpacity={e.opacity}
        />
      ))}
      {topAgents.map((a) =>
        node(
          COL.agent,
          agentCy.get(a.name)!,
          a.name,
          "n-agent",
          `${a.toolCalls} 工具调用 · ${a.llmCalls} 模型`,
        ),
      )}
      {topTools.map((t) =>
        node(
          COL.tool,
          toolCy.get(t.name)!,
          t.name,
          "n-tool",
          `${t.count} 次 · ${t.models.length} 模型`,
        ),
      )}
      {topModels.map((m) =>
        node(
          COL.model,
          modelCy.get(m.name)!,
          m.name,
          "n-model",
          `${m.count} 次`,
        ),
      )}
    </svg>
  );
}
