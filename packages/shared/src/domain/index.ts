import { z } from "zod";

// 参考 Langfuse packages/shared/src/domain/traces.ts
// 宽事件契约：注入 API 和 tRPC 共用

export const jsonSchema = z.any();

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export const TraceCreateSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  timestamp: z.string().datetime(),
  environment: z.string().default("default"),
  userId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  input: jsonSchema.nullable().optional(),
  output: jsonSchema.nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional(),
  tags: z.array(z.string()).default([]),
});

export type TraceCreate = z.infer<typeof TraceCreateSchema>;

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export const ObservationTypeEnum = z.enum(["SPAN", "GENERATION", "EVENT"]);
export type ObservationType = z.infer<typeof ObservationTypeEnum>;

export const ObservationCreateSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  type: ObservationTypeEnum,
  name: z.string().nullable().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().nullable().optional(),
  model: z.string().nullable().optional(),
  input: jsonSchema.nullable().optional(),
  output: jsonSchema.nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional(),
  level: z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]).default("DEFAULT"),
  // 原始 usage 对象（OpenAI/Anthropic 格式），服务端据此推算 token 与成本
  usage: jsonSchema.nullable().optional(),
});

export type ObservationCreate = z.infer<typeof ObservationCreateSchema>;

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export const ScoreDataTypeEnum = z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]);
export type ScoreDataType = z.infer<typeof ScoreDataTypeEnum>;

export const ScoreSourceEnum = z.enum(["API", "ANNOTATION"]);
export type ScoreSource = z.infer<typeof ScoreSourceEnum>;

export const ScoreCreateSchema = z.object({
  id: z.string().optional(),
  traceId: z.string().nullable().optional(),
  observationId: z.string().nullable().optional(),
  name: z.string(),
  value: z.number(),
  dataType: ScoreDataTypeEnum,
  source: ScoreSourceEnum.default("API"),
  comment: z.string().nullable().optional(),
});

export type ScoreCreate = z.infer<typeof ScoreCreateSchema>;

// ---------------------------------------------------------------------------
// 批量注入
// ---------------------------------------------------------------------------

export const IngestionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trace-create"), body: TraceCreateSchema }),
  z.object({ type: z.literal("observation-create"), body: ObservationCreateSchema }),
  z.object({ type: z.literal("score-create"), body: ScoreCreateSchema }),
]);

export type IngestionEvent = z.infer<typeof IngestionEventSchema>;

export const IngestionBatchSchema = z.object({
  batch: z.array(IngestionEventSchema).max(1000),
});

export type IngestionBatch = z.infer<typeof IngestionBatchSchema>;
