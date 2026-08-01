// 队列处理器注册
// 参考 Langfuse worker/src/app.ts 的 WorkerManager 模式
// standalone 模式下被 start.ts 同进程 import，共享 queueBus 单例

import { queueBus, QUEUES, type IngestionQueuePayload } from "@machora/shared";

export function registerQueueProcessors(): void {
  queueBus.consume<IngestionQueuePayload>(QUEUES.ingestion, async (payload) => {
    // v1：仅打日志。后续在此做 session 聚合、token 统计等派生计算
    console.log(`[ingestion] project=${payload.projectId} trace=${payload.traceId}`);
  });

  console.log("[worker] Queue processors registered (ingestion)");
}
