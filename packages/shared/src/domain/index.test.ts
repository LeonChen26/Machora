import { describe, it, expect } from "vitest";
import {
  TraceCreateSchema,
  ObservationCreateSchema,
  ScoreCreateSchema,
  IngestionBatchSchema,
} from "./index.ts";

describe("TraceCreateSchema", () => {
  it("接受合法 payload", () => {
    const r = TraceCreateSchema.safeParse({
      id: "t1",
      name: "my-trace",
      timestamp: "2026-08-01T00:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("拒绝非法 timestamp", () => {
    const r = TraceCreateSchema.safeParse({ id: "t1", timestamp: "not-a-date" });
    expect(r.success).toBe(false);
  });

  it("缺 id 时拒绝", () => {
    const r = TraceCreateSchema.safeParse({ timestamp: "2026-08-01T00:00:00Z" });
    expect(r.success).toBe(false);
  });

  it("默认 environment/tags", () => {
    const v = TraceCreateSchema.parse({ id: "t1", timestamp: "2026-08-01T00:00:00Z" });
    expect(v.environment).toBe("default");
    expect(v.tags).toEqual([]);
  });
});

describe("ObservationCreateSchema", () => {
  it("接受 span.kind 多值 type", () => {
    for (const type of ["ENTRY", "AGENT", "STEP", "LLM", "TOOL", "EMBEDDING", "CHAIN", "RETRIEVER", "RERANKER", "EVENT", "SPAN"]) {
      const r = ObservationCreateSchema.safeParse({
        id: "o1",
        traceId: "t1",
        type,
        startTime: "2026-08-01T00:00:00Z",
      });
      expect(r.success).toBe(true);
    }
  });

  it("拒绝未知类型", () => {
    const r = ObservationCreateSchema.safeParse({
      id: "o1",
      traceId: "t1",
      type: "generation", // 必须大写 span.kind 值
      startTime: "2026-08-01T00:00:00Z",
    });
    expect(r.success).toBe(false);
    const g = ObservationCreateSchema.safeParse({
      id: "o2",
      traceId: "t1",
      type: "GENERATION", // 已移除的旧三值
      startTime: "2026-08-01T00:00:00Z",
    });
    expect(g.success).toBe(false);
  });

  it("默认 level 为 DEFAULT", () => {
    const v = ObservationCreateSchema.parse({
      id: "o1",
      traceId: "t1",
      type: "SPAN",
      startTime: "2026-08-01T00:00:00Z",
    });
    expect(v.level).toBe("DEFAULT");
  });
});

describe("ScoreCreateSchema", () => {
  it("默认 source 为 API", () => {
    const v = ScoreCreateSchema.parse({
      traceId: "t1",
      name: "quality",
      value: 0.9,
      dataType: "NUMERIC",
    });
    expect(v.source).toBe("API");
  });

  it("id 可选", () => {
    const v = ScoreCreateSchema.parse({
      traceId: "t1",
      name: "q",
      value: 1,
      dataType: "BOOLEAN",
    });
    expect(v.id).toBeUndefined();
  });
});

describe("IngestionBatchSchema", () => {
  it("区分三种事件类型", () => {
    const r = IngestionBatchSchema.safeParse({
      batch: [
        { type: "trace-create", body: { id: "t", timestamp: "2026-08-01T00:00:00Z" } },
        {
          type: "observation-create",
          body: {
            id: "o",
            traceId: "t",
            type: "LLM",
            startTime: "2026-08-01T00:00:00Z",
          },
        },
        { type: "score-create", body: { traceId: "t", name: "q", value: 0.9, dataType: "NUMERIC" } },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.batch[0].type).toBe("trace-create");
      expect(r.data.batch[1].type).toBe("observation-create");
      expect(r.data.batch[2].type).toBe("score-create");
      // 类型收窄后可读 source 默认值
      if (r.data.batch[2].type === "score-create") {
        expect(r.data.batch[2].body.source).toBe("API");
      }
    }
  });

  it("body 类型不匹配时拒绝", () => {
    const r = IngestionBatchSchema.safeParse({
      batch: [
        {
          type: "trace-create",
          body: { type: "LLM" }, // trace body 缺 id/timestamp
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("超过 1000 条拒绝", () => {
    const batch = Array.from({ length: 1001 }, (_, i) => ({
      type: "trace-create" as const,
      body: { id: `t${i}`, timestamp: "2026-08-01T00:00:00Z" },
    }));
    const r = IngestionBatchSchema.safeParse({ batch });
    expect(r.success).toBe(false);
  });
});
