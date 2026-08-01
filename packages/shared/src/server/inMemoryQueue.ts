import { EventEmitter } from "node:events";

// 进程内队列总线，替代 BullMQ
// 关键不变量：Next.js 与 worker 必须同进程，共享此单例
export class InMemoryQueueBus extends EventEmitter {
  enqueue<T>(queue: string, payload: T): void {
    // 非阻塞：下一 tick 投递，避免阻塞 HTTP 响应
    setImmediate(() => this.emit(queue, payload));
  }

  consume<T>(queue: string, handler: (payload: T) => Promise<void>): void {
    this.on(queue, async (payload: T) => {
      try {
        await handler(payload);
      } catch (e) {
        console.error(`[queue:${queue}] handler error:`, e);
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

if (process.env.NODE_ENV !== "production") {
  globalThis.__machoraQueueBus = queueBus;
}
