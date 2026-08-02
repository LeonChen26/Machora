// 服务端评估任务（evaluations）领域类型
// Phase 3：规则评估器落地，评估器接口抽象为可插拔（预留 LLM judge 等扩展）

export const EVALUATOR_TYPES = [
  "error", // trace 是否含 ERROR observation
  "latency", // 总耗时是否超 thresholdMs
  "cost", // 总成本是否超 thresholdUsd
  "token", // 总 token 是否超 thresholdTokens
  "tag", // trace.tags 是否含 config.tag
  "llm", // 预留：LLM-as-judge
] as const;

export type EvaluatorType = (typeof EVALUATOR_TYPES)[number];

/** 评估器输入：trace + 其下 observations 的轻量视图（worker 组装） */
export interface EvaluationContext {
  trace: {
    id: string;
    tags: string[];
    timestamp: Date;
  };
  observations: Array<{
    id: string;
    type: string;
    level: string;
    startTime: Date;
    endTime: Date | null;
    model: string | null;
    totalTokens: number | null;
    totalCost: number | null;
  }>;
}

/** 评估结果：value 写回 Score（BOOLEAN 用 0/1），comment 写回 Score.comment */
export interface EvaluationResult {
  value: number;
  dataType: "NUMERIC" | "BOOLEAN";
  comment?: string;
}

export interface Evaluator {
  type: EvaluatorType;
  description: string;
  run(
    ctx: EvaluationContext,
    config: Record<string, unknown>,
  ): Promise<EvaluationResult>;
}
