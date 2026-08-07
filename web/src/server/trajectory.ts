// 轨迹视图（推理轨迹）服务端组装：
// 输入 observation 调用树 → 输出主链行（TrajectoryRow[]）。
// 聚合规则：event / other 不占行，计入最近祖先主链节点的计数徽标；
// 循环检测：主链上同名工具连续出现 ≥3 次 → loop 标记（badge「重复调用 ×N」）。

import { classifyTrajectoryKind, type TrajectoryKind } from "@machora/shared";
import { observation as observationTable } from "@machora/shared";
import { durationMs } from "../lib/format";

export type LoopLevel = "repeat" | "ineffective";

export type TrajectoryRow = {
  id: string;
  parentId: string | null;
  name: string | null;
  kind: TrajectoryKind;
  level: string | null;
  model: string | null;
  depth: number;
  start: number; // epoch ms
  end: number | null; // epoch ms
  dur: number; // ms
  container: boolean; // 有可见子节点 → 可折叠
  visibleChildren: number;
  events: number; // 子树内聚合的日志事件数
  others: number; // 子树内聚合的其它调用数
  loop: boolean; // 重复工具调用 / 疑似无效循环标记
  loopLevel: LoopLevel | null; // repeat=仅重复；ineffective=含无进展信号
  badge: string | null;
};

type Obs = typeof observationTable.$inferSelect;
export type ObsNode = Obs & { children: ObsNode[] };

// 判定“是否有 Agent 语义数据”的角色集合（排除入口/其它/日志）
const AGENTISH = new Set<TrajectoryKind>([
  "think",
  "llm",
  "tool",
  "retrieval",
  "memory",
  "skill",
  "embedding",
]);

// 无进展信号：输出显式为空（空串 / 空数组 / 空对象）。
// null 视为“未采集”，不当作无进展，避免 SDK 未捕获 output 时误报。
function isEmptyOutput(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function hasNoProgress(o: Obs): boolean {
  return o.level === "ERROR" || isEmptyOutput(o.output);
}

export function buildTrajectoryRows(
  roots: ObsNode[],
): { rows: TrajectoryRow[]; longTask: boolean; hasAgentSignal: boolean } {
  const rows: TrajectoryRow[] = [];

  // 收集含“无进展信号”的 tool 节点 id（供循环检测分级）
  const noProgressIds = new Set<string>();
  function walk(
    nodes: ObsNode[],
    depth: number,
    parentId: string | null,
  ): { rowsCount: number; events: number; others: number } {
    let rowsCount = 0;
    let events = 0;
    let others = 0;
    for (const node of nodes) {
      const kind = classifyTrajectoryKind({
        type: node.type,
        metadata: node.metadata,
        model: node.model,
        agentName: node.agentName,
        workflowName: node.workflowName,
        skillName: node.skillName,
        hasParent: node.parentObservationId != null,
      });
      // event / other 不占行：聚合成计数，交给最近祖先主链节点
      if (kind === "event") {
        events++;
        continue;
      }
      if (kind === "other") {
        others++;
        continue;
      }
      if (kind === "tool" && hasNoProgress(node)) noProgressIds.add(node.id);
      const dur = durationMs(node.startTime, node.endTime);
      // 先入队父行（先序：入口在最前），再递归子树，最后回填聚合计数
      const idx = rows.length;
      rows.push({
        id: node.id,
        parentId,
        name: node.name,
        kind,
        level: node.level,
        model: node.model,
        depth,
        start: node.startTime.getTime(),
        end: node.endTime ? node.endTime.getTime() : null,
        dur: dur ?? 0,
        container: false,
        visibleChildren: 0,
        events: 0,
        others: 0,
        loop: false,
        loopLevel: null,
        badge: null,
      });
      const sub = walk(node.children, depth + 1, node.id);
      const row = rows[idx];
      row.container = sub.rowsCount > 0;
      row.visibleChildren = sub.rowsCount;
      row.events = sub.events;
      row.others = sub.others;
      rowsCount += 1 + sub.rowsCount;
    }
    return { rowsCount, events, others };
  }

  walk(roots, 0, null);

  // 循环检测（分级）：
  // - 同名工具在决策序列中“连续”出现 ≥3 次 → 重复调用 ×N（仅重复）
  // - 连续出现 ≥2 次且段内含“无进展信号”（ERROR / 输出显式为空）→ 疑似无效循环 ×N
  // 树序拍平下同名工具可能被 think/llm 等行隔开（ReAct 一轮含思考+工具+模型），
  // 因此只有出现【不同】工具时才重置计数，其它行不打断。
  let prev: { name: string | null; streak: number; noProgress: boolean } | null = null;
  for (const r of rows) {
    if (r.kind === "tool") {
      const np = noProgressIds.has(r.id);
      if (prev && prev.name === r.name) {
        prev.streak += 1;
        prev.noProgress = prev.noProgress || np;
      } else {
        prev = { name: r.name, streak: 1, noProgress: np };
      }
      if (prev.streak >= 3) {
        r.loop = true;
        r.loopLevel = prev.noProgress ? "ineffective" : "repeat";
        r.badge = prev.noProgress
          ? `疑似无效循环 ×${prev.streak}`
          : `重复调用 ×${prev.streak}`;
      } else if (prev.streak >= 2 && prev.noProgress) {
        r.loop = true;
        r.loopLevel = "ineffective";
        r.badge = `疑似无效循环 ×${prev.streak}`;
      }
    }
  }

  const thinkCount = rows.filter((r) => r.kind === "think").length;
  return {
    rows,
    longTask: thinkCount >= 8,
    hasAgentSignal: rows.some((r) => AGENTISH.has(r.kind)),
  };
}
