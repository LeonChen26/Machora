import { describe, it, expect } from "vitest";
import { IngestionQueuePayloadSchema } from "./queues.ts";

describe("IngestionQueuePayloadSchema", () => {
  it("接受合法 payload", () => {
    const v = IngestionQueuePayloadSchema.parse({
      projectId: "p1",
      traceId: "t1",
    });
    expect(v).toEqual({ projectId: "p1", traceId: "t1" });
  });

  it("缺 traceId 时拒绝", () => {
    const r = IngestionQueuePayloadSchema.safeParse({ projectId: "p1" });
    expect(r.success).toBe(false);
  });
});
