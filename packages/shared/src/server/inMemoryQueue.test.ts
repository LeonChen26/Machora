import { describe, it, expect } from "vitest";
import { queueBus } from "./inMemoryQueue.ts";

// setImmediate 投递，等下一 tick
const tick = () => new Promise<void>((r) => setImmediate(() => r()));

describe("InMemoryQueueBus", () => {
  it("enqueue 后投递给 consume handler", async () => {
    const q = `test-q-${Date.now()}`;
    const received: string[] = [];
    queueBus.consume<string>(q, async (p) => {
      received.push(p);
    });
    queueBus.enqueue(q, "hello");
    await tick();
    expect(received).toEqual(["hello"]);
  });

  it("handler 抛错不中断队列", async () => {
    const q = `test-q-err-${Date.now()}`;
    const received: string[] = [];
    queueBus.consume<string>(q, async () => {
      throw new Error("boom");
    });
    queueBus.consume<string>(q, async (p) => {
      received.push(p);
    });
    // 消费端 error 只在 console 打日志，不应 crash
    queueBus.enqueue(q, "x");
    await tick();
    expect(received).toEqual(["x"]);
  });

  it("不同队列互不影响", async () => {
    const qa = `test-qa-${Date.now()}`;
    const qb = `test-qb-${Date.now()}`;
    const got: string[] = [];
    queueBus.consume<string>(qa, async (p) => {
      got.push(p);
    });
    queueBus.consume<string>(qb, async (p) => {
      got.push(p);
    });
    queueBus.enqueue(qb, "b");
    queueBus.enqueue(qa, "a");
    await tick();
    expect(got).toEqual(["b", "a"]);
  });
});
