import { describe, it, expect } from "vitest";
import {
  getModelPrice,
  parseUsage,
  estimateTokens,
  calculateCost,
} from "./pricing";

describe("getModelPrice", () => {
  it("精确匹配", () => {
    expect(getModelPrice("gpt-4o-mini")).toEqual({
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    });
    expect(getModelPrice("deepseek-chat")!.inputPerMillion).toBe(0.27);
  });
  it("大小写不敏感", () => {
    expect(getModelPrice("Claude-3-5-Sonnet")).toEqual(
      getModelPrice("claude-3-5-sonnet"),
    );
  });
  it("前缀匹配（带版本后缀）", () => {
    expect(getModelPrice("gpt-4o-mini-2024-07-18")).toEqual(
      getModelPrice("gpt-4o-mini"),
    );
  });
  it("未收录模型返回 null", () => {
    expect(getModelPrice("llama-3.1-70b")).toBeNull();
    expect(getModelPrice(null)).toBeNull();
    expect(getModelPrice(undefined)).toBeNull();
  });
});

describe("parseUsage", () => {
  it("OpenAI 格式（prompt_tokens/completion_tokens）", () => {
    expect(
      parseUsage({ prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }),
    ).toEqual({ inputTokens: 120, outputTokens: 45, totalTokens: 165 });
  });
  it("Anthropic / Responses 格式（input_tokens/output_tokens）", () => {
    expect(parseUsage({ input_tokens: 88, output_tokens: 12 })).toEqual({
      inputTokens: 88,
      outputTokens: 12,
      totalTokens: 100,
    });
  });
  it("camelCase 字段", () => {
    expect(parseUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });
  it("无效 usage 返回 null", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage("usage")).toBeNull();
    expect(parseUsage({ prompt_tokens: 10 })).toBeNull();
    expect(parseUsage({})).toBeNull();
  });
});

describe("estimateTokens", () => {
  it("中文字符按 1.5 字符/token", () => {
    expect(estimateTokens("你好世界")).toBe(3);
  });
  it("英文按 4 字符/token", () => {
    expect(estimateTokens("hello world")).toBe(3);
  });
  it("对象序列化后估算", () => {
    expect(estimateTokens({ a: "hello" })).toBeGreaterThan(0);
  });
  it("空值返回 0", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("calculateCost", () => {
  it("按 usage 精确计费（gpt-4o-mini）", () => {
    // 200 input * 0.15/1M + 100 output * 0.6/1M = 0.00003 + 0.00006 = 0.00009
    const r = calculateCost("gpt-4o-mini", { prompt_tokens: 200, completion_tokens: 100 }, null, null);
    expect(r.inputTokens).toBe(200);
    expect(r.outputTokens).toBe(100);
    expect(r.totalTokens).toBe(300);
    expect(r.totalCost).toBeCloseTo(0.00009, 9);
  });
  it("无 usage 时用内容估算", () => {
    const r = calculateCost("gpt-4o-mini", null, "hello world", "你好");
    expect(r.totalTokens).toBeGreaterThan(0);
    expect(r.totalCost).not.toBeNull();
  });
  it("未收录模型返回 null 成本但保留 token", () => {
    const r = calculateCost("llama-3.1-70b", { prompt_tokens: 10, completion_tokens: 5 }, null, null);
    expect(r.totalCost).toBeNull();
    expect(r.totalTokens).toBe(15);
  });
  it("model 为空返回 null 成本", () => {
    const r = calculateCost(null, null, null, null);
    expect(r.totalCost).toBeNull();
    expect(r.totalTokens).toBe(0);
  });
});
