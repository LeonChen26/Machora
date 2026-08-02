// 内置规则评估器 + 可插拔注册表
// Phase 3：零外部依赖；注册表抽象供后续接入 LLM-as-judge 等扩展

import type {
  EvaluationContext,
  EvaluationResult,
  Evaluator,
  EvaluatorType,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function toNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 规则评估器
// ---------------------------------------------------------------------------

/** error：trace 是否包含 ERROR 级别 observation → BOOLEAN */
const errorEvaluator: Evaluator = {
  type: "error",
  description: "Trace 是否包含 ERROR 级别 observation",
  async run(ctx) {
    const hasError = ctx.observations.some((o) => o.level === "ERROR");
    return {
      value: hasError ? 1 : 0,
      dataType: "BOOLEAN",
      comment: hasError ? "包含 ERROR observation" : "无 ERROR observation",
    };
  },
};

/** latency：trace 总耗时（max endTime - min startTime）是否超过 thresholdMs → BOOLEAN */
const latencyEvaluator: Evaluator = {
  type: "latency",
  description: "Trace 总耗时（首 obs startTime → 末 obs endTime）是否超过 thresholdMs",
  async run(ctx, config) {
    const threshold = toNumber(config.thresholdMs, 5000);
    let min = Infinity;
    let max = -Infinity;
    for (const o of ctx.observations) {
      if (o.endTime) {
        min = Math.min(min, o.startTime.getTime());
        max = Math.max(max, o.endTime.getTime());
      }
    }
    const durationMs = Number.isFinite(min) ? max - min : 0;
    return {
      value: durationMs > threshold ? 1 : 0,
      dataType: "BOOLEAN",
      comment: `总耗时 ${durationMs}ms，阈值 ${threshold}ms`,
    };
  },
};

/** cost：trace 总成本是否超过 thresholdUsd → BOOLEAN */
const costEvaluator: Evaluator = {
  type: "cost",
  description: "Trace 总成本是否超过 thresholdUsd（美元）",
  async run(ctx, config) {
    const threshold = toNumber(config.thresholdUsd, 0.01);
    const total = ctx.observations.reduce((acc, o) => acc + (o.totalCost ?? 0), 0);
    return {
      value: total > threshold ? 1 : 0,
      dataType: "BOOLEAN",
      comment: `总成本 $${total.toFixed(6)}，阈值 $${threshold}`,
    };
  },
};

/** token：trace 总 token 是否超过 thresholdTokens → BOOLEAN */
const tokenEvaluator: Evaluator = {
  type: "token",
  description: "Trace 总 token（input+output）是否超过 thresholdTokens",
  async run(ctx, config) {
    const threshold = toNumber(config.thresholdTokens, 10000);
    const total = ctx.observations.reduce((acc, o) => acc + (o.totalTokens ?? 0), 0);
    return {
      value: total > threshold ? 1 : 0,
      dataType: "BOOLEAN",
      comment: `总 token ${total}，阈值 ${threshold}`,
    };
  },
};

/** tag：trace.tags 是否包含 config.tag → BOOLEAN */
const tagEvaluator: Evaluator = {
  type: "tag",
  description: "Trace 是否带指定标签 config.tag",
  async run(ctx, config) {
    const tag = String(config.tag ?? "");
    const has = tag !== "" && ctx.trace.tags.includes(tag);
    return {
      value: has ? 1 : 0,
      dataType: "BOOLEAN",
      comment: has ? `含标签 ${tag}` : `不含标签 ${tag}`,
    };
  },
};

// ---------------------------------------------------------------------------
// 注册表（可插拔：registerEvaluator 供 LLM judge 等外部扩展注册）
// ---------------------------------------------------------------------------

const registry = new Map<string, Evaluator>();
for (const e of [errorEvaluator, latencyEvaluator, costEvaluator, tokenEvaluator, tagEvaluator]) {
  registry.set(e.type, e);
}

export const defaultEvaluators: Evaluator[] = [...registry.values()];

export function getEvaluator(type: string): Evaluator | undefined {
  return registry.get(type);
}

export function registerEvaluator(evaluator: Evaluator): void {
  registry.set(evaluator.type, evaluator);
}

export type { EvaluationContext, EvaluationResult, Evaluator, EvaluatorType } from "./types.ts";
