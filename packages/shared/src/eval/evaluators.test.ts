import { describe, it, expect } from "vitest";
import {
  defaultEvaluators,
  getEvaluator,
  registerEvaluator,
  type EvaluationContext,
  type Evaluator,
} from "./evaluators.ts";

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    trace: { id: "t1", tags: ["prod"], timestamp: new Date("2026-08-02T00:00:00Z") },
    observations: [
      {
        id: "o1",
        type: "SPAN",
        level: "DEFAULT",
        startTime: new Date("2026-08-02T00:00:00Z"),
        endTime: new Date("2026-08-02T00:00:05Z"),
        model: null,
        totalTokens: 1000,
        totalCost: 0.001,
      },
    ],
    ...overrides,
  };
}

describe("规则评估器", () => {
  it("error：含 ERROR observation → 1", async () => {
    const r = await getEvaluator("error")!.run(
      ctx({ observations: [ctx().observations[0], { ...ctx().observations[0], id: "o2", level: "ERROR" }] }),
      {},
    );
    expect(r).toEqual({ value: 1, dataType: "BOOLEAN", comment: "包含 ERROR observation" });
  });

  it("error：无 ERROR → 0", async () => {
    const r = await getEvaluator("error")!.run(ctx(), {});
    expect(r.value).toBe(0);
  });

  it("latency：5s 耗时，默认阈值 5000ms → 0；thresholdMs=4000 → 1", async () => {
    const e = getEvaluator("latency")!;
    expect((await e.run(ctx(), {})).value).toBe(0);
    expect((await e.run(ctx(), { thresholdMs: 4000 })).value).toBe(1);
  });

  it("latency：无 endTime 的 obs 不参与计时", async () => {
    const e = getEvaluator("latency")!;
    const c = ctx({ observations: [{ ...ctx().observations[0], endTime: null }] });
    expect((await e.run(c, { thresholdMs: 100 })).value).toBe(0);
  });

  it("cost：默认阈值 $0.01，total $0.001 → 0；thresholdUsd=0.0005 → 1", async () => {
    const e = getEvaluator("cost")!;
    expect((await e.run(ctx(), {})).value).toBe(0);
    expect((await e.run(ctx(), { thresholdUsd: 0.0005 })).value).toBe(1);
  });

  it("token：默认阈值 10000，total 1000 → 0；thresholdTokens=500 → 1", async () => {
    const e = getEvaluator("token")!;
    expect((await e.run(ctx(), {})).value).toBe(0);
    expect((await e.run(ctx(), { thresholdTokens: 500 })).value).toBe(1);
  });

  it("tag：tags 含 config.tag → 1，否则 0，空 tag → 0", async () => {
    const e = getEvaluator("tag")!;
    expect((await e.run(ctx(), { tag: "prod" })).value).toBe(1);
    expect((await e.run(ctx(), { tag: "dev" })).value).toBe(0);
    expect((await e.run(ctx(), {})).value).toBe(0);
  });

  it("config 支持字符串数字（HTTP query 传入形态）", async () => {
    const e = getEvaluator("latency")!;
    expect((await e.run(ctx(), { thresholdMs: "4000" })).value).toBe(1);
  });

  it("注册表可插拔：registerEvaluator 扩展（预留 LLM judge）", () => {
    const llm: Evaluator = {
      type: "llm",
      description: "LLM-as-judge（预留）",
      async run() {
        return { value: 0, dataType: "NUMERIC", comment: "todo" };
      },
    };
    expect(getEvaluator("llm")).toBeUndefined();
    registerEvaluator(llm);
    expect(getEvaluator("llm")).toBe(llm);
  });

  it("defaultEvaluators 覆盖 5 个内置规则", () => {
    expect(defaultEvaluators.map((e) => e.type).sort()).toEqual([
      "cost",
      "error",
      "latency",
      "tag",
      "token",
    ]);
  });
});
