// 轨迹视图（推理轨迹）节点角色分类。
// 纯函数：只依赖 observation 落库字段（type / metadata / model / 专用列 / 是否挂父），
// 不改存储、不回填数据。判定优先级（最强语义 → 兜底）：
//   1. type=EVENT → event
//   2. type 为 span.kind 多值（新数据，type 与 span.kind 一致）→ 直接映射角色
//   3. 兼容：metadata.gen_ai.span.kind → operation → 专用列启发式（对 SPAN 兜底前尽力区分）
//   4. 兜底：无父 SPAN → entry；其余 → other

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
  /** 落库 type（span.kind 多值；SPAN=通用节点） */
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

/** span.kind 多值 type → 轨迹角色（新数据直接落库，无需再推断） */
const TYPE_ROLE: Record<string, TrajectoryKind> = {
  ENTRY: "entry",
  AGENT: "agent",
  STEP: "think",
  LLM: "llm",
  TOOL: "tool",
  EMBEDDING: "embedding",
  CHAIN: "workflow",
  RETRIEVER: "retrieval",
  RERANKER: "retrieval",
  EVENT: "event",
};

export function classifyTrajectoryKind(o: TrajectoryKindInput): TrajectoryKind {
  // 1. EVENT 固定为日志（不占主链行，聚合到父节点）
  if (o.type === "EVENT") return "event";

  // 2. 落库 span.kind 直接映射（新数据：type 与 span.kind 一致）
  const role = TYPE_ROLE[o.type];
  if (role) return role;

  // 3. 对 SPAN 通用节点尽力区分角色：从 metadata 反推（gen_ai.span.kind / operation / 专用列）
  // 3.1 LoongSuite gen_ai.span.kind（最强语义，六值）
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

  // 3.2 gen_ai.operation.name（操作枚举）
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

  // 3.3 专用列 / 属性启发式
  if (o.skillName) return "skill";
  if (o.workflowName) return "workflow";
  if (o.agentName) return "agent";
  if (metaStr(o.metadata, "gen_ai.tool.name")) return "tool";
  if (o.model && /embed/i.test(o.model)) return "embedding";

  // 3.4 兜底：无父 SPAN → entry；其余 → other
  if (o.type === "SPAN" && !o.hasParent) return "entry";
  return "other";
}

// ---------------------------------------------------------------------------
// 轨迹摘要：把 observations 按执行顺序转成文本摘要（LLM judge 深度评估输入）
// ---------------------------------------------------------------------------

export interface TrajectorySummaryInput {
  id: string;
  type: string;
  name: string | null;
  model: string | null;
  agentName: string | null;
  workflowName: string | null;
  skillName: string | null;
  level: string;
  parentObservationId: string | null;
  startTime: Date;
  metadata: unknown;
  input: unknown;
  output: unknown;
}

/** 单条 observation → 摘要行（保留语义标签 + 名称 + IO 摘要） */
function summaryLine(o: TrajectorySummaryInput): string {
  const role = classifyTrajectoryKind({
    type: o.type,
    metadata: o.metadata,
    model: o.model,
    agentName: o.agentName,
    workflowName: o.workflowName,
    skillName: o.skillName,
    hasParent: !!o.parentObservationId,
  });
  const label = o.name?.trim() || o.type || "step";
  const modelSuffix = o.model ? ` [${o.model}]` : "";
  const io: string[] = [];
  if (o.input !== null && o.input !== undefined) {
    try {
      io.push(`in=${JSON.stringify(o.input).slice(0, 200)}`);
    } catch {
      /* ignore */
    }
  }
  if (o.output !== null && o.output !== undefined) {
    try {
      io.push(`out=${JSON.stringify(o.output).slice(0, 300)}`);
    } catch {
      /* ignore */
    }
  }
  const ioSuffix = io.length > 0 ? ` (${io.join(" ")})` : "";
  return `${role}: ${label}${modelSuffix}${ioSuffix}`;
}

/**
 * 把 observations 按开始时间排序生成轨迹摘要（供 LLM judge 注入 prompt）。
 * 纯函数，不依赖落库；空数组返回 null。
 */
export function buildTrajectorySummary(
  observations: TrajectorySummaryInput[],
  limit = 50,
): string | null {
  if (observations.length === 0) return null;
  const sorted = [...observations].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
  const lines = sorted.slice(0, limit).map((o) => summaryLine(o));
  if (sorted.length > limit) lines.push(`…（共 ${sorted.length} 步，仅列前 ${limit} 步）`);
  return lines.join("\n");
}
