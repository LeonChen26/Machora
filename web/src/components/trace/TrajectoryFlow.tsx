"use client";

// 轨迹视图（推理轨迹）：按 Agent 行为角色渲染决策主链。
// 行数据（TrajectoryRow）由服务端拍平/聚合/检测循环，此处纯展示 + 折叠 + 选中联动。
// event / other 已聚合为计数徽标，不占行；容器节点（有可见子节点）可折叠。

import { useMemo, useState } from "react";
import type { TrajectoryKind } from "@machora/shared";
import { useSelection } from "./contexts";
import { formatDuration } from "../../lib/format";
import type { TrajectoryRow } from "../../server/trajectory";

const KIND_META: Record<TrajectoryKind, { label: string; icon: string; badge: string }> = {
  entry: { label: "入口", icon: "🚀", badge: "" },
  agent: { label: "Agent", icon: "🤖", badge: "purple" },
  workflow: { label: "工作流", icon: "🔀", badge: "blue" },
  think: { label: "思考", icon: "💭", badge: "" },
  llm: { label: "模型", icon: "🧠", badge: "purple" },
  tool: { label: "工具", icon: "🛠️", badge: "blue" },
  retrieval: { label: "检索", icon: "🔍", badge: "green" },
  memory: { label: "记忆", icon: "🗂️", badge: "" },
  skill: { label: "技能", icon: "🎯", badge: "" },
  embedding: { label: "嵌入", icon: "📐", badge: "purple" },
  event: { label: "日志", icon: "📝", badge: "amber" },
  other: { label: "其他", icon: "▪️", badge: "" },
};

export function TrajectoryFlow({ rows }: { rows: TrajectoryRow[] }) {
  const { selectedId, select } = useSelection();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 折叠子树：仅渲染未被折叠祖先覆盖的行（保持深度的先序扫描）
  const visible = useMemo(() => {
    const out: TrajectoryRow[] = [];
    let hideUntilDepth = -1;
    for (const r of rows) {
      if (r.depth <= hideUntilDepth) hideUntilDepth = -1;
      if (hideUntilDepth >= 0) continue;
      out.push(r);
      if (r.container && collapsed.has(r.id)) hideUntilDepth = r.depth;
    }
    return out;
  }, [rows, collapsed]);

  if (rows.length === 0) return null;

  return (
    <div className="traj-flow" role="tree">
      {visible.map((r) => {
        const meta = KIND_META[r.kind];
        const sel = selectedId === r.id;
        const isErr = r.level === "ERROR";
        const isWarn = r.level === "WARNING";
        const isCollapsed = collapsed.has(r.id);
        return (
          <div
            key={r.id}
            role="treeitem"
            aria-expanded={r.container ? !isCollapsed : undefined}
            aria-selected={sel}
            tabIndex={0}
            className={`traj-row${sel ? " selected" : ""}${isErr ? " is-error" : ""}${isWarn ? " is-warn" : ""}${r.loop ? " is-loop" : ""}`}
            style={{ paddingLeft: r.depth * 20 }}
            onClick={() => select(r.id)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              select(r.id);
            }}
          >
            <span className="traj-icon" aria-hidden>
              {meta.icon}
            </span>
            <span className={`badge ${meta.badge}`}>{meta.label}</span>
            <span className="traj-name">{r.name || <span className="mute2">（未命名）</span>}</span>
            {r.model && <span className="mono mute2 text-xs">{r.model}</span>}
            {r.loop && r.badge && (
              <span
                className={`badge ${r.loopLevel === "ineffective" ? "red" : "amber"}`}
                title={r.loopLevel === "ineffective" ? "含无进展信号（ERROR 或空输出）" : "仅重复调用"}
              >
                {r.badge}
              </span>
            )}
            {r.events > 0 && (
              <span className="badge" title="子树内日志事件">
                📝 {r.events}
              </span>
            )}
            {r.others > 0 && (
              <span className="badge" title="子树内其它调用">
                ··· {r.others}
              </span>
            )}
            {r.container && (
              <button
                type="button"
                className="traj-toggle"
                aria-label={isCollapsed ? "展开" : "折叠"}
                title={isCollapsed ? "展开" : "折叠"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(r.id);
                }}
              >
                {isCollapsed ? "▶" : "▼"}
              </button>
            )}
            <span className="spacer" />
            <span className="mono mute2 text-xs">{formatDuration(r.dur)}</span>
          </div>
        );
      })}
    </div>
  );
}
