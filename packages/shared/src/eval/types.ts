// 服务端评估任务（evaluations）领域类型
// Phase 3：规则评估器落地，评估器接口抽象为可插拔（预留 LLM judge 等扩展）

export const EVALUATOR_TYPES = [
  "error", // trace 是否含 ERROR observation
  "latency", // 总耗时是否超 thresholdMs
  "cost", // 总成本是否超 thresholdUsd
  "token", // 总 token 是否超 thresholdTokens
  "tag", // trace.tags 是否含 config.tag
  "llm", // LLM-as-judge：调用 OpenAI 兼容端点对 trace/执行轨迹打分
] as const;

export type EvaluatorType = (typeof EVALUATOR_TYPES)[number];

/** 评估器输入：trace + 其下 observations 的视图（worker 组装） */
export interface EvaluationContext {
  trace: {
    id: string;
    name: string | null;
    tags: string[];
    timestamp: Date;
    /** trace 级 input/output（LLM judge 等需要内容型输入的评估器使用） */
    input: unknown;
    output: unknown;
  };
  observations: Array<{
    id: string;
    type: string;
    level: string;
    name: string | null;
    startTime: Date;
    endTime: Date | null;
    model: string | null;
    agentName: string | null;
    workflowName: string | null;
    skillName: string | null;
    parentObservationId: string | null;
    totalTokens: number | null;
    totalCost: number | null;
    /** observation 级 input/output（LLM judge 评估单步输出时使用） */
    input: unknown;
    output: unknown;
  }>;
  /** 轨迹摘要（按执行顺序的步骤序列，LLM judge 深度评估用；规则评估器忽略） */
  trajectorySummary: string | null;
}

/** 评估结果：value 写回 Score（BOOLEAN 用 0/1），comment 写回 Score.comment */
export interface EvaluationResult {
  value: number;
  dataType: "NUMERIC" | "BOOLEAN";
  comment?: string;
  /** 评估依据/详细理由（LLM judge 输出；规则评估器无） */
  reasoning?: string;
}

export interface Evaluator {
  type: EvaluatorType;
  description: string;
  run(
    ctx: EvaluationContext,
    config: Record<string, unknown>,
  ): Promise<EvaluationResult>;
}
