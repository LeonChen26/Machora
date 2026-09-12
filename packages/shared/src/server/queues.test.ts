import { describe, it, expect } from "vitest";
import { IngestionQueuePayloadSchema } from "./queues.ts";

describe("IngestionQueuePayloadSchema", () => {
  it("接受合法 payload", () => {
    const v = IngestionQueuePayloadSchema.parse({
      traceId: "t1",
    });
    expect(v).toEqual({ traceId: "t1" });
  });

  it("缺 traceId 时拒绝", () => {
    const r = IngestionQueuePayloadSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
