import { describe, it, expect, vi, afterEach } from "vitest";
import {
  llmJudgeEvaluator,
  type LlmJudgeConfig,
} from "./llmJudge.ts";
import type { EvaluationContext } from "./types.ts";
import { buildTrajectorySummary } from "../otel/trajectory.ts";

function ctx(): EvaluationContext {
  return {
    trace: {
      id: "t1",
      name: "客服问答",
      tags: ["prod"],
      timestamp: new Date("2026-08-02T00:00:00Z"),
      input: { question: "如何重置密码？" },
      output: { answer: "请前往设置页重置" },
    },
    observations: [
      {
        id: "o1",
        type: "ENTRY",
        level: "DEFAULT",
        name: "客服问答入口",
        startTime: new Date("2026-08-02T00:00:00Z"),
        endTime: new Date("2026-08-02T00:00:02Z"),
        model: null,
        agentName: "customer-service",
        workflowName: null,
        skillName: null,
        parentObservationId: null,
        totalTokens: 500,
        totalCost: 0.001,
        input: { question: "如何重置密码？" },
        output: { answer: "请前往设置页重置" },
      },
    ],
    trajectorySummary:
      "entry: 客服问答入口 (in={\"question\":\"如何重置密码？\"} out={\"answer\":\"请前往设置页重置\"})",
  };
}

function mockFetchOk(content: string) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LLM-as-judge 评估器", () => {
  const base: LlmJudgeConfig = {
    model: "gpt-4o-mini",
    apiKey: "sk-test",
  };

  it("NUMERIC：解析 value + comment", async () => {
    mockFetchOk(JSON.stringify({ value: 0.82, comment: "回答准确完整" }));
    const r = await llmJudgeEvaluator.run(ctx(), base as unknown as Record<string, unknown>);
    expect(r).toEqual({ value: 0.82, dataType: "NUMERIC", comment: "回答准确完整" });
  });

  it("value 超界时 clamp 到 0–1", async () => {
    mockFetchOk(JSON.stringify({ value: 1.5 }));
    const r = await llmJudgeEvaluator.run(ctx(), base as unknown as Record<string, unknown>);
    expect(r.value).toBe(1);
  });

  it("BOOLEAN：boolean 归一为 0/1", async () => {
    mockFetchOk(JSON.stringify({ value: true, comment: "包含关键信息" }));
    const r = await llmJudgeEvaluator.run(ctx(), { ...base, dataType: "BOOLEAN" } as unknown as Record<string, unknown>);
    expect(r).toEqual({ value: 1, dataType: "BOOLEAN", comment: "包含关键信息" });
  });

  it("输出带 markdown 代码块包裹时仍可解析", async () => {
    mockFetchOk("```json\n{\"value\": 0.7, \"comment\": \"基本合格\"}\n```");
    const r = await llmJudgeEvaluator.run(ctx(), base as unknown as Record<string, unknown>);
    expect(r.value).toBe(0.7);
  });

  it("请求头/体正确：Bearer auth、temperature=0、注入系统与用户消息", async () => {
    const spy = mockFetchOk(JSON.stringify({ value: 0.5 }));
    await llmJudgeEvaluator.run(ctx(), { ...base, systemPrompt: "评估标准：准确性" } as unknown as Record<string, unknown>);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("评估标准：准确性");
    const user = body.messages[1].content as string;
    expect(user).toContain("[Trace 输入]");
    expect(user).toContain("客服问答");
    expect(user).toContain("[执行轨迹摘要]");
  });

  it("apiBase 自定义且去除尾部斜杠", async () => {
    const spy = mockFetchOk(JSON.stringify({ value: 0.5 }));
    await llmJudgeEvaluator.run(ctx(), { ...base, apiBase: "https://dashscope.aliyuncs.com/v1/" } as unknown as Record<string, unknown>);
    expect(spy.mock.calls[0]![0]).toBe("https://dashscope.aliyuncs.com/v1/chat/completions");
  });

  it("HTTP 非 2xx → 抛错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    await expect(llmJudgeEvaluator.run(ctx(), base as unknown as Record<string, unknown>)).rejects.toThrow(/401/);
  });

  it("缺少 model/apiKey → 抛错", async () => {
    await expect(llmJudgeEvaluator.run(ctx(), { apiKey: "k" } as unknown as Record<string, unknown>)).rejects.toThrow(/model/);
    await expect(llmJudgeEvaluator.run(ctx(), { model: "m" } as unknown as Record<string, unknown>)).rejects.toThrow(/apiKey/);
  });

  it("includeTrajectory=false 时 prompt 不含轨迹摘要", async () => {
    const spy = mockFetchOk(JSON.stringify({ value: 0.5 }));
    await llmJudgeEvaluator.run(ctx(), { ...base, includeTrajectory: false } as unknown as Record<string, unknown>);
    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
    expect(body.messages[1].content).not.toContain("[执行轨迹摘要]");
  });
});

describe("轨迹摘要 buildTrajectorySummary", () => {
  it("按开始时间排序输出角色 + 名称 + IO", () => {
    const s = buildTrajectorySummary([
      {
        id: "b",
        type: "TOOL",
        name: "search_logs",
        model: null,
        agentName: null,
        workflowName: null,
        skillName: null,
        level: "DEFAULT",
        parentObservationId: "a",
        metadata: {},
        startTime: new Date("2026-08-02T00:00:02Z"),
        input: { query: "error" },
        output: { hits: 3 },
      },
      {
        id: "a",
        type: "STEP",
        name: "分析日志",
        model: null,
        agentName: null,
        workflowName: null,
        skillName: null,
        level: "DEFAULT",
        parentObservationId: null,
        metadata: {},
        startTime: new Date("2026-08-02T00:00:00Z"),
        input: null,
        output: null,
      },
    ]);
    expect(s).toContain("think: 分析日志");
    expect(s).toContain("tool: search_logs");
    // 排序：a（STEP）在前，b（TOOL）在后
    expect(s!.indexOf("分析日志")).toBeLessThan(s!.indexOf("search_logs"));
  });

  it("空数组返回 null，超 limit 截断", () => {
    expect(buildTrajectorySummary([])).toBeNull();
    const many = Array.from({ length: 55 }, (_, i) => ({
      id: `o${i}`,
      type: "SPAN",
      name: null,
      model: null,
      agentName: null,
      workflowName: null,
      skillName: null,
      level: "DEFAULT",
      parentObservationId: null,
      metadata: {},
      startTime: new Date(2026, 0, 1, 0, 0, i),
      input: null,
      output: null,
    }));
    const s = buildTrajectorySummary(many)!;
    expect(s).toContain("仅列前 50 步");
  });
});
