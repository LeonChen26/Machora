// 轨迹视图（推理轨迹）服务端组装：
// 输入 observation 调用树 → 输出主链行（TrajectoryRow[]）。
// 聚合规则：event / other 不占行，计入最近祖先主链节点的计数徽标；
// 循环检测：主链上同名工具连续出现 ≥3 次 → loop 标记（badge「重复调用 ×N」）。

import { classifyTrajectoryKind, type TrajectoryKind } from "@machora/shared";
import { observation as observationTable } from "@machora/shared";
import { durationMs } from "../lib/format";

export type TrajectoryRow = {
  id: string;
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
  loop: boolean; // 重复工具调用标记
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

export function buildTrajectoryRows(
  roots: ObsNode[],
): { rows: TrajectoryRow[]; longTask: boolean; hasAgentSignal: boolean } {
  const rows: TrajectoryRow[] = [];

  function walk(nodes: ObsNode[], depth: number): { rowsCount: number; events: number; others: number } {
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
      const sub = walk(node.children, depth + 1);
      const dur = durationMs(node.startTime, node.endTime);
      rowsCount += 1 + sub.rowsCount;
      rows.push({
        id: node.id,
        name: node.name,
        kind,
        level: node.level,
        model: node.model,
        depth,
        start: node.startTime.getTime(),
        end: node.endTime ? node.endTime.getTime() : null,
        dur: dur ?? 0,
        container: sub.rowsCount > 0,
        visibleChildren: sub.rowsCount,
        events: sub.events,
        others: sub.others,
        loop: false,
        badge: null,
      });
    }
    return { rowsCount, events, others };
  }

  walk(roots, 0);

  // 循环检测：同名工具在决策序列中“连续”出现 ≥3 次。
  // 树序拍平下同名工具可能被 think/llm 等行隔开（ReAct 一轮含思考+工具+模型），
  // 因此只有出现【不同】工具时才重置计数，其它行不打断。
  let prev: { name: string | null; streak: number } | null = null;
  for (const r of rows) {
    if (r.kind === "tool") {
      if (prev && prev.name === r.name) {
        prev.streak += 1;
      } else {
        prev = { name: r.name, streak: 1 };
      }
      if (prev.streak >= 3) {
        r.loop = true;
        r.badge = `重复调用 ×${prev.streak}`;
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
