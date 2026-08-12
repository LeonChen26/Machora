// LLM-as-judge 评估器
// 零外部依赖：直接用全局 fetch 调 OpenAI 兼容 chat/completions 端点。
// config 字段：
//   model         模型名（必填），如 gpt-4o-mini / qwen-max
//   apiBase       OpenAI 兼容端点 base，默认 https://api.openai.com/v1
//   apiKey        API Key（必填）
//   systemPrompt  系统提示词（描述评分标准；默认内置通用打分模板）
//   includeTrajectory  是否把轨迹摘要注入上下文（默认 true，对齐 AgentLoop 轨迹评估）
//   dataType      期望输出类型：NUMERIC（默认）/ BOOLEAN
//   timeoutMs     请求超时（默认 30000）
// 输出：judge 返回 JSON 形如 { "value": 0.82, "comment": "..." }，
//       value 为布尔时按 dataType=BOOLEAN 归一为 0/1。

import type {
  EvaluationContext,
  EvaluationResult,
  Evaluator,
} from "./types.ts";

export interface LlmJudgeConfig {
  model: string;
  apiBase?: string;
  apiKey: string;
  systemPrompt?: string;
  includeTrajectory?: boolean;
  dataType?: "NUMERIC" | "BOOLEAN";
  timeoutMs?: number;
}

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/** 压缩任意值为紧凑 JSON 文本（超长截断，供 prompt 注入） */
function compactJson(v: unknown, maxLen = 3000): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[truncated]` : s;
}

/** 从 judge 输出文本中提取 JSON 对象（整体解析 → 兜底提取首个 {...} 块） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(t.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** 把 observation 的 IO 内容转成一行摘要文本 */
function observationIoLine(o: {
  name: string | null;
  type: string;
  model: string | null;
  input: unknown;
  output: unknown;
}): string {
  const name = o.name?.trim() || o.type || "step";
  const inS = compactJson(o.input, 800);
  const outS = compactJson(o.output, 1200);
  const parts = [`- ${name}（${o.type}${o.model ? ` · ${o.model}` : ""}）`];
  if (inS) parts.push(`输入: ${inS}`);
  if (outS) parts.push(`输出: ${outS}`);
  return parts.join("\n");
}

function buildUserPrompt(ctx: EvaluationContext, config: Partial<LlmJudgeConfig>): string {
  const lines: string[] = [];
  const t = ctx.trace;
  if (t.name) lines.push(`Trace 名称: ${t.name}`);
  lines.push(`Trace ID: ${t.id}`);
  if (t.input !== null && t.input !== undefined) {
    lines.push(`\n[Trace 输入]\n${compactJson(t.input)}`);
  }
  if (t.output !== null && t.output !== undefined) {
    lines.push(`\n[Trace 输出]\n${compactJson(t.output)}`);
  }

  // 轨迹摘要（按执行顺序的步骤序列）——对齐 AgentLoop 的轨迹深度评估
  const useTrajectory = config.includeTrajectory !== false;
  if (useTrajectory && ctx.trajectorySummary) {
    lines.push(`\n[执行轨迹摘要]\n${ctx.trajectorySummary}`);
  }

  // 关键 observation 的 IO 明细（LLM 单步输出等）
  const withIo = ctx.observations.filter(
    (o) => o.input !== null || o.output !== null,
  );
  if (withIo.length > 0) {
    lines.push(
      `\n[关键步骤明细]\n${withIo
        .map((o) => observationIoLine(o))
        .join("\n")}`,
    );
  }

  lines.push(
    `\n请根据以上信息评估，并只输出 JSON：{"value": <0-1 的分数>${config.dataType === "BOOLEAN" ? " 或 true/false" : ""}, "reasoning": "<评估依据，2-3 句详细理由>", "comment": "<一句话结论>"}`,
  );
  return lines.join("\n");
}

function parseResult(text: string, dataType: "NUMERIC" | "BOOLEAN"): EvaluationResult {
  const obj = extractJsonObject(text);
  if (!obj) {
    throw new Error(`LLM judge 输出无法解析为 JSON: ${text.slice(0, 200)}`);
  }
  const rawValue = obj.value;

  if (dataType === "BOOLEAN") {
    let value = 0;
    if (typeof rawValue === "boolean") value = rawValue ? 1 : 0;
    else if (typeof rawValue === "number") value = rawValue >= 0.5 ? 1 : 0;
    else if (typeof rawValue === "string") value = /^(true|1)$/i.test(rawValue.trim()) ? 1 : 0;
    return {
      value,
      dataType: "BOOLEAN",
      comment: typeof obj.comment === "string" ? obj.comment : undefined,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    };
  }

  const num = typeof rawValue === "number" ? rawValue : Number.parseFloat(String(rawValue ?? ""));
  if (!Number.isFinite(num)) {
    throw new Error(`LLM judge 输出 value 非法: ${String(rawValue)}`);
  }
  return {
    value: Math.min(1, Math.max(0, num)),
    dataType: "NUMERIC",
    comment: typeof obj.comment === "string" ? obj.comment : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

const DEFAULT_SYSTEM_PROMPT = `你是一名专业的 Agent 行为评估员。请基于给定的 Trace 输入、输出与执行轨迹，从准确性、完整性与合理性维度给出 0-1 的分数（1=完美），并附一句简短理由。只输出 JSON，不要输出其他文字。`;

export const llmJudgeEvaluator: Evaluator = {
  type: "llm",
  description: "LLM-as-judge：调用 OpenAI 兼容端点对 trace/执行轨迹打分",
  async run(ctx, rawConfig): Promise<EvaluationResult> {
    const config = (rawConfig ?? {}) as Partial<LlmJudgeConfig>;
    if (!config.model || !config.apiKey) {
      throw new Error("LLM judge 需要 config.model 与 config.apiKey");
    }

    const apiBase = (config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    const dataType = config.dataType === "BOOLEAN" ? "BOOLEAN" : "NUMERIC";
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
            },
            { role: "user", content: buildUserPrompt(ctx, config) },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`LLM judge 请求失败 ${res.status}: ${detail}`);
      }

      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM judge 响应缺少 choices[0].message.content");
      }
      return parseResult(content, dataType);
    } finally {
      clearTimeout(timer);
    }
  },
};
