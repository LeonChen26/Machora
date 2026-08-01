// 模型定价与 token 推算
// 参考 Langfuse packages/shared/src/server/llm/types.ts 的定价思路，简化：
// - 只维护常用模型每百万 token 单价（美元）
// - 未收录模型返回 null（不计费），避免错误成本

export interface ModelPrice {
  /** 每百万输入 token 单价（美元） */
  inputPerMillion: number;
  /** 每百万输出 token 单价（美元） */
  outputPerMillion: number;
}

// 参考公开价格（近似值）
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  // Anthropic
  "claude-3-5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-7-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4 },
  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

/** 按模型名查价：先精确匹配，再做前缀匹配（如 gpt-4o-mini-2024-07-18 → gpt-4o-mini） */
export function getModelPrice(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const normalized = model.trim().toLowerCase();
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];
  // 前缀匹配：按 key 长度降序，更具体的前缀优先（避免 gpt-4o 抢先匹配 gpt-4o-mini）
  const candidates = Object.entries(MODEL_PRICING)
    .filter(([key]) => normalized.startsWith(key))
    .sort((a, b) => b[0].length - a[0].length);
  return candidates.length ? candidates[0][1] : null;
}

// ---------------------------------------------------------------------------
// usage 解析：兼容 OpenAI（prompt_tokens/completion_tokens）与
// Anthropic / Responses API（input_tokens/output_tokens）
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function parseUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens;
  const output = u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? u.outputTokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const inputTokens = Math.round(input);
  const outputTokens = Math.round(output);
  const total = u.total_tokens ?? u.totalTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      typeof total === "number" ? Math.round(total) : inputTokens + outputTokens,
  };
}

// ---------------------------------------------------------------------------
// 无 usage 时的估算：把 input/output 内容序列化为文本后粗估 token 数
// ---------------------------------------------------------------------------

function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 粗估 token 数：中文约 1.5 字符/token，其余按 4 字符/token */
export function estimateTokens(value: unknown): number {
  const str = toText(value);
  if (!str) return 0;
  const cjk = (str.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const nonCjk = str.length - cjk;
  return Math.max(Math.ceil(cjk / 1.5 + nonCjk / 4), 0);
}

// ---------------------------------------------------------------------------
// 成本计算
// ---------------------------------------------------------------------------

/**
 * 计算一次调用的成本（美元）。
 * usage 存在则优先解析；否则用 input/output 内容估算。
 * 模型未收录返回 null（不产生成本）。
 */
export function calculateCost(
  model: string | null | undefined,
  usage: unknown,
  input: unknown,
  output: unknown,
): { inputTokens: number; outputTokens: number; totalTokens: number; totalCost: number | null } {
  const parsed = parseUsage(usage);
  const inputTokens = parsed?.inputTokens ?? estimateTokens(input);
  const outputTokens = parsed?.outputTokens ?? estimateTokens(output);
  const totalTokens = parsed?.totalTokens ?? inputTokens + outputTokens;

  const price = getModelPrice(model);
  if (!price) {
    return { inputTokens, outputTokens, totalTokens, totalCost: null };
  }
  const totalCost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion;
  return { inputTokens, outputTokens, totalTokens, totalCost };
}
