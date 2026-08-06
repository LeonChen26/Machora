// 轨迹视图（推理轨迹）节点角色分类。
// 纯函数：只依赖 observation 落库字段（type / metadata / model / 专用列 / 是否挂父），
// 不改存储、不回填数据。判定优先级（最强语义 → 兜底）：
//   1. type=EVENT → event
//   2. metadata.gen_ai.span.kind（LoongSuite 六值）
//   3. metadata.gen_ai.operation.name（操作枚举）
//   4. 专用列启发式（skillName / workflowName / agentName / gen_ai.tool.name / model 含 embed）
//   5. 兜底：GENERATION → llm；无父 SPAN → entry；其余 → other

export const TRAJECTORY_KINDS = [
  "entry",
  "agent",
  "workflow",
  "think",
  "llm",
  "tool",
  "retrieval",
  "memory",
  "skill",
  "embedding",
  "event",
  "other",
] as const;

export type TrajectoryKind = (typeof TRAJECTORY_KINDS)[number];

export interface TrajectoryKindInput {
  /** SPAN | GENERATION | EVENT */
  type: string;
  /** observation.metadata（jsonb，未知结构视为无） */
  metadata: unknown;
  model: string | null;
  agentName: string | null;
  workflowName: string | null;
  skillName: string | null;
  /** 是否挂有父节点（无父的根 SPAN → entry） */
  hasParent: boolean;
}

/** 从 metadata 读取字符串属性（非字符串 / 空串视为无） */
function metaStr(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

const MEMORY_OPS = new Set([
  "create_memory",
  "search_memory",
  "upsert_memory",
  "update_memory",
  "get_memory",
  "delete_memory",
  "memory",
]);

const LLM_OPS = new Set([
  "chat",
  "completion",
  "text_completion",
  "generate_content",
  "generate",
]);

export function classifyTrajectoryKind(o: TrajectoryKindInput): TrajectoryKind {
  // 1. EVENT 固定为日志（不占主链行，聚合到父节点）
  if (o.type === "EVENT") return "event";

  // 2. LoongSuite gen_ai.span.kind（最强语义，六值）
  const sk = metaStr(o.metadata, "gen_ai.span.kind")?.toUpperCase();
  if (sk) {
    switch (sk) {
      case "ENTRY":
        return "entry";
      case "AGENT":
        return "agent";
      case "STEP":
        return "think";
      case "TOOL":
        return "tool";
      case "LLM":
        return "llm";
      case "EMBEDDING":
        return "embedding";
      default:
        break; // 未知值 → 继续降级
    }
  }

  // 3. gen_ai.operation.name（操作枚举）
  const op = metaStr(o.metadata, "gen_ai.operation.name")?.toLowerCase();
  if (op) {
    if (op === "entry" || op === "invoke_agent" || op === "create_agent") return "agent";
    if (op === "react_step" || op === "plan") return "think";
    if (op === "invoke_workflow" || op === "create_workflow") return "workflow";
    if (op === "retrieval" || op === "rerank") return "retrieval";
    if (MEMORY_OPS.has(op)) return "memory";
    if (op === "invoke_skill" || op === "create_skill" || op === "skill") return "skill";
    if (op === "embeddings") return "embedding";
    if (LLM_OPS.has(op)) return "llm";
  }

  // 4. 专用列 / 属性启发式
  if (o.skillName) return "skill";
  if (o.workflowName) return "workflow";
  if (o.agentName) return "agent";
  if (metaStr(o.metadata, "gen_ai.tool.name")) return "tool";
  if (o.model && /embed/i.test(o.model)) return "embedding";

  // 5. 兜底
  if (o.type === "GENERATION") return "llm";
  if (o.type === "SPAN" && !o.hasParent) return "entry";
  return "other";
}
