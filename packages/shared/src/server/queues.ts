import { z } from "zod";

// 队列 payload 契约，参考 Langfuse packages/shared/src/server/queues.ts
// 单一真源：web 生产、worker 消费都引用这里的 schema

export const IngestionQueuePayloadSchema = z.object({
  projectId: z.string(),
  traceId: z.string(),
  // v1 仅打日志，后续做 session 聚合 / token 统计
});

export type IngestionQueuePayload = z.infer<typeof IngestionQueuePayloadSchema>;

export const QUEUES = {
  ingestion: "ingestion",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
