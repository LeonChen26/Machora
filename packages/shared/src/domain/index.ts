import { z } from "zod";

// 参考 Langfuse packages/shared/src/domain/traces.ts
// 领域创建契约：供评分等内部 API 复用（trace / observation 经 OTLP 通道接入，不走此契约）

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
  agentName: z.string().nullable().optional(),
  workflowName: z.string().nullable().optional(),
  skillName: z.string().nullable().optional(),
  input: jsonSchema.nullable().optional(),
  output: jsonSchema.nullable().optional(),
  metadata: z.record(z.string(), z.any()).nullable().optional(),
  tags: z.array(z.string()).default([]),
});

export type TraceCreate = z.infer<typeof TraceCreateSchema>;

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

// observation.type 与 span.kind 一致的多值：
// span.kind 角色直接落库（ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING/CHAIN/RETRIEVER/RERANKER/EVENT），
// SPAN=通用节点（无角色语义）
export const ObservationTypeEnum = z.enum([
  "ENTRY",
  "AGENT",
  "STEP",
  "LLM",
  "TOOL",
  "EMBEDDING",
  "CHAIN",
  "RETRIEVER",
  "RERANKER",
  "EVENT",
  "SPAN",
]);
export type ObservationType = z.infer<typeof ObservationTypeEnum>;

export const ObservationCreateSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  type: ObservationTypeEnum,
  name: z.string().nullable().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().nullable().optional(),
  // 父 observation id（构建嵌套调用树；父须为同一 trace 内已存在的 observation）
  parentObservationId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  agentName: z.string().nullable().optional(),
  workflowName: z.string().nullable().optional(),
  skillName: z.string().nullable().optional(),
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

export const ScoreSourceEnum = z.enum(["API", "ANNOTATION", "EVALUATION"]);
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
