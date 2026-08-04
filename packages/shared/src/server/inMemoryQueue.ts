import { EventEmitter } from "node:events";
import { selfMetrics } from "../self/index.ts";

// 进程内队列总线，替代 BullMQ
// 关键不变量：Next.js 与 worker 必须同进程，共享此单例
export class InMemoryQueueBus extends EventEmitter {
  enqueue<T>(queue: string, payload: T): void {
    selfMetrics.inc("machora.queue.enqueued", 1, { queue });
    // 非阻塞：下一 tick 投递，避免阻塞 HTTP 响应
    setImmediate(() => this.emit(queue, payload));
  }

  consume<T>(queue: string, handler: (payload: T) => Promise<void>): void {
    this.on(queue, async (payload: T) => {
      const start = Date.now();
      try {
        await handler(payload);
        selfMetrics.inc("machora.queue.consumed", 1, { queue, status: "ok" });
      } catch (e) {
        selfMetrics.inc("machora.queue.consumed", 1, { queue, status: "error" });
        console.error(`[queue:${queue}] handler error:`, e);
      } finally {
        selfMetrics.observe("machora.queue.duration_ms", Date.now() - start, {
          queue,
        });
      }
    });
  }
}

// 进程级单例
declare global {
  // eslint-disable-next-line no-var
  var __machoraQueueBus: InMemoryQueueBus | undefined;
}

export const queueBus =
  globalThis.__machoraQueueBus ?? new InMemoryQueueBus();

// 关键：standalone 模式下 web（Next.js in-process production bundle）与 worker 同进程。
// Next.js bundle 会内联 @machora/shared 副本，若不用 globalThis 兜底，web 侧 enqueue 的
// 事件将发到另一个队列实例，worker 永远收不到（evaluation 任务会卡在 PENDING）。
// 因此必须无条件写回 globalThis，与 NODE_ENV 无关。
globalThis.__machoraQueueBus = queueBus;
