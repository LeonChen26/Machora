// Drizzle ORM 表定义（方案 C：移除 Prisma 后的替换层）
//
// 与 packages/shared/sql/schema.sql 保持一致（8 张表，宽事件模型）：
// - 列名/表名与 schema.sql 完全相同（列键即列名，保证现有代码字段访问不变）
// - 表结构由 schema.sql 幂等建立，drizzle 定义仅作类型层 + relations 引用
// - 时间列用 integer({ mode: "timestamp_ms" })（epoch 毫秒，读写仍为 JS Date）
// - Json 列用 text({ mode: "json" })；tags 用 JSON 文本数组（SQLite 无数组类型）

import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// SQLite 无原生时间类型：统一存 epoch 毫秒整数，drizzle 读写仍为 JS Date
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

// 主键 id：对应 Prisma @default(cuid())，客户端生成（缺省时 drizzle 自动填充）。
// trace/observation 的 id 是 OTel hex，写入处总是显式提供，不受影响。
const primaryId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

export const project = sqliteTable("Project", {
  id: primaryId(),
  name: text("name").notNull(),
  createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
});

export const apiKey = sqliteTable(
  "ApiKey",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    publicKey: text("publicKey").notNull(),
    hashedSecret: text("hashedSecret").notNull(),
    name: text("name"),
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("ApiKey_publicKey_key").on(t.publicKey),
    index("ApiKey_projectId_idx").on(t.projectId),
  ],
);

export const user = sqliteTable(
  "User",
  {
    id: primaryId(),
    email: text("email").notNull(),
    passwordHash: text("passwordHash").notNull(),
    name: text("name"),
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("User_email_key").on(t.email)],
);

// ---------------------------------------------------------------------------
// 核心观测数据（宽事件模型）
// ---------------------------------------------------------------------------

export const trace = sqliteTable(
  "Trace",
  {
    id: text("id").primaryKey(), // OTel traceId（hex）
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name"),
    timestamp: ts("timestamp").notNull(),
    environment: text("environment").notNull().default("default"),
    userId: text("userId"),
    sessionId: text("sessionId"),
    agentName: text("agentName"),
    workflowName: text("workflowName"),
    skillName: text("skillName"),
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    metadata: text("metadata", { mode: "json" }),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("Trace_projectId_timestamp_idx").on(t.projectId, t.timestamp),
    index("Trace_userId_idx").on(t.userId),
    index("Trace_sessionId_idx").on(t.sessionId),
  ],
);

export const observation = sqliteTable(
  "Observation",
  {
    id: primaryId(), // OTel spanId（hex）
    traceId: text("traceId")
      .notNull()
      .references(() => trace.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("projectId").notNull(),
    type: text("type").notNull(), // span.kind 多值（ENTRY/AGENT/STEP/LLM/TOOL/EMBEDDING/CHAIN/RETRIEVER/RERANKER/EVENT/SPAN）
    name: text("name"),
    parentObservationId: text("parentObservationId"),
    startTime: ts("startTime").notNull(),
    endTime: ts("endTime"),
    model: text("model"),
    agentName: text("agentName"),
    workflowName: text("workflowName"),
    skillName: text("skillName"),
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    metadata: text("metadata", { mode: "json" }),
    level: text("level").notNull().default("DEFAULT"), // DEBUG | DEFAULT | WARNING | ERROR
    usage: text("usage", { mode: "json" }),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    totalCost: real("totalCost"),
  },
  (t) => [
    index("Observation_projectId_startTime_idx").on(t.projectId, t.startTime),
    index("Observation_traceId_idx").on(t.traceId),
    index("Observation_parentObservationId_idx").on(t.parentObservationId),
  ],
);

export const score = sqliteTable(
  "Score",
  {
    id: primaryId(),
    traceId: text("traceId").references(() => trace.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    observationId: text("observationId"),
    projectId: text("projectId").notNull(),
    name: text("name").notNull(),
    value: real("value").notNull(),
    dataType: text("dataType").notNull(), // NUMERIC | CATEGORICAL | BOOLEAN
    source: text("source").notNull(), // API | ANNOTATION | EVALUATION
    comment: text("comment"),
    timestamp: ts("timestamp").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("Score_projectId_timestamp_idx").on(t.projectId, t.timestamp),
    index("Score_traceId_idx").on(t.traceId),
  ],
);

// ---------------------------------------------------------------------------
// 数据集（Prompt 级评测用例，Langfuse dataset 简化版：name 为数据集名，item 为用例）
// ---------------------------------------------------------------------------

export const datasetItem = sqliteTable(
  "DatasetItem",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(), // 数据集名
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    expectedOutput: text("expectedOutput", { mode: "json" }),
    metadata: text("metadata", { mode: "json" }),
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("DatasetItem_projectId_name_idx").on(t.projectId, t.name),
  ],
);

// ---------------------------------------------------------------------------
// 服务端评估任务
// ---------------------------------------------------------------------------

export const evaluation = sqliteTable(
  "Evaluation",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    // trace 评估：traceId 指向 Trace；数据集评测：datasetItemId 指向数据集用例（traceId 为空）
    traceId: text("traceId").references(() => trace.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    datasetItemId: text("datasetItemId").references(() => datasetItem.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    name: text("name").notNull(), // 写回 Score 时的 name
    evaluatorType: text("evaluatorType").notNull(),
    config: text("config", { mode: "json" }),
    status: text("status").notNull().default("PENDING"), // PENDING | RUNNING | COMPLETED | ERROR
    mode: text("mode").notNull().default("EXPERIMENT"), // ONLINE（在线自动） | EXPERIMENT（手动/批量）
    error: text("error"),
    result: text("result", { mode: "json" }),
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [
    index("Evaluation_projectId_createdAt_idx").on(t.projectId, t.createdAt),
    index("Evaluation_traceId_idx").on(t.traceId),
    index("Evaluation_datasetItemId_idx").on(t.datasetItemId),
    index("Evaluation_status_idx").on(t.status),
  ],
);

// 评估器配置（UI 可管理）：LLM judge 的模型/端点/提示词，或规则评估器阈值
export const evaluationConfig = sqliteTable(
  "EvaluationConfig",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(), // 配置名（如 helpfulness）
    evaluatorType: text("evaluatorType").notNull(), // llm | error | latency ...
    config: text("config", { mode: "json" }), // 评估器参数（model/apiKey/systemPrompt 或阈值）
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true), // 可手动触发
    autoRun: integer("autoRun", { mode: "boolean" }).notNull().default(false), // 在线自动评估（ingestion 后自动触发）
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [
    index("EvaluationConfig_projectId_idx").on(t.projectId),
    uniqueIndex("EvaluationConfig_projectId_name_key").on(t.projectId, t.name),
  ],
);

// ---------------------------------------------------------------------------
// 指标采样
// ---------------------------------------------------------------------------

export const metricSample = sqliteTable(
  "MetricSample",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit"),
    kind: text("kind").notNull(), // GAUGE | SUM | HISTOGRAM
    attributes: text("attributes", { mode: "json" }), // labels（OTLP attributes / 自观测维度）
    timestamp: ts("timestamp").notNull(),
    // gauge / sum：单值
    value: real("value"),
    // histogram：摘要
    count: real("count"),
    sum: real("sum"),
    min: real("min"),
    max: real("max"),
    buckets: text("buckets", { mode: "json" }), // [{ boundary: number, count: number }]
    createdAt: ts("createdAt").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("MetricSample_projectId_name_timestamp_idx").on(
      t.projectId,
      t.name,
      t.timestamp,
    ),
    index("MetricSample_name_timestamp_idx").on(t.name, t.timestamp),
  ],
);

// ---------------------------------------------------------------------------
// relations（供 drizzle 的 with/relational queries 使用）
// ---------------------------------------------------------------------------

export const projectRelations = relations(project, ({ many }) => ({
  apiKeys: many(apiKey),
  traces: many(trace),
  metricSamples: many(metricSample),
}));

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
  project: one(project, { fields: [apiKey.projectId], references: [project.id] }),
}));

export const traceRelations = relations(trace, ({ one, many }) => ({
  project: one(project, { fields: [trace.projectId], references: [project.id] }),
  observations: many(observation),
  scores: many(score),
  evaluations: many(evaluation),
}));

export const observationRelations = relations(observation, ({ one }) => ({
  trace: one(trace, { fields: [observation.traceId], references: [trace.id] }),
}));

export const scoreRelations = relations(score, ({ one }) => ({
  trace: one(trace, { fields: [score.traceId], references: [trace.id] }),
}));

export const evaluationRelations = relations(evaluation, ({ one }) => ({
  trace: one(trace, { fields: [evaluation.traceId], references: [trace.id] }),
  datasetItem: one(datasetItem, {
    fields: [evaluation.datasetItemId],
    references: [datasetItem.id],
  }),
}));

export const datasetItemRelations = relations(datasetItem, ({ one }) => ({
  project: one(project, {
    fields: [datasetItem.projectId],
    references: [project.id],
  }),
}));

export const metricSampleRelations = relations(metricSample, ({ one }) => ({
  project: one(project, {
    fields: [metricSample.projectId],
    references: [project.id],
  }),
}));
