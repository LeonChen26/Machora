// Drizzle ORM 表定义（方案 C：移除 Prisma 后的替换层）
//
// 与 packages/shared/prisma/schema.sql 保持一致（8 张表，宽事件模型）：
// - 列名/表名与 schema.sql 完全相同（列键即列名，保证现有代码字段访问不变）
// - 表结构由 schema.sql 幂等建立，drizzle 定义仅作类型层 + relations 引用
// - timestamp(3) 用 mode: "date"（与 Prisma 返回 Date 语义一致）
// - Json 列用 jsonb()；tags 用 text[].notNull()（Prisma String[] 语义）

import { relations } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) =>
  timestamp(name, { precision: 3, mode: "date" });

// 主键 id：对应 Prisma @default(cuid())，客户端生成（缺省时 drizzle 自动填充）。
// trace/observation 的 id 是 OTel hex，写入处总是显式提供，不受影响。
const primaryId = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

export const project = pgTable("Project", {
  id: primaryId(),
  name: text("name").notNull(),
  createdAt: ts("createdAt").notNull().defaultNow(),
});

export const apiKey = pgTable(
  "ApiKey",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    publicKey: text("publicKey").notNull(),
    hashedSecret: text("hashedSecret").notNull(),
    name: text("name"),
    createdAt: ts("createdAt").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ApiKey_publicKey_key").on(t.publicKey),
    index("ApiKey_projectId_idx").on(t.projectId),
  ],
);

export const user = pgTable(
  "User",
  {
    id: primaryId(),
    email: text("email").notNull(),
    passwordHash: text("passwordHash").notNull(),
    name: text("name"),
    createdAt: ts("createdAt").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("User_email_key").on(t.email)],
);

// ---------------------------------------------------------------------------
// 核心观测数据（宽事件模型）
// ---------------------------------------------------------------------------

export const trace = pgTable(
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
    input: jsonb("input"),
    output: jsonb("output"),
    metadata: jsonb("metadata"),
    tags: text("tags").array().notNull(),
    createdAt: ts("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("Trace_projectId_timestamp_idx").on(t.projectId, t.timestamp),
    index("Trace_userId_idx").on(t.userId),
    index("Trace_sessionId_idx").on(t.sessionId),
  ],
);

export const observation = pgTable(
  "Observation",
  {
    id: primaryId(), // OTel spanId（hex）
    traceId: text("traceId")
      .notNull()
      .references(() => trace.id, { onDelete: "cascade", onUpdate: "cascade" }),
    projectId: text("projectId").notNull(),
    type: text("type").notNull(), // SPAN | GENERATION | EVENT
    name: text("name"),
    parentObservationId: text("parentObservationId"),
    startTime: ts("startTime").notNull(),
    endTime: ts("endTime"),
    model: text("model"),
    agentName: text("agentName"),
    workflowName: text("workflowName"),
    skillName: text("skillName"),
    input: jsonb("input"),
    output: jsonb("output"),
    metadata: jsonb("metadata"),
    level: text("level").notNull().default("DEFAULT"), // DEBUG | DEFAULT | WARNING | ERROR
    usage: jsonb("usage"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    totalCost: doublePrecision("totalCost"),
  },
  (t) => [
    index("Observation_projectId_startTime_idx").on(t.projectId, t.startTime),
    index("Observation_traceId_idx").on(t.traceId),
    index("Observation_parentObservationId_idx").on(t.parentObservationId),
  ],
);

export const score = pgTable(
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
    value: doublePrecision("value").notNull(),
    dataType: text("dataType").notNull(), // NUMERIC | CATEGORICAL | BOOLEAN
    source: text("source").notNull(), // API | ANNOTATION | EVALUATION
    comment: text("comment"),
    timestamp: ts("timestamp").notNull().defaultNow(),
  },
  (t) => [
    index("Score_projectId_timestamp_idx").on(t.projectId, t.timestamp),
    index("Score_traceId_idx").on(t.traceId),
  ],
);

// ---------------------------------------------------------------------------
// 服务端评估任务
// ---------------------------------------------------------------------------

export const evaluation = pgTable(
  "Evaluation",
  {
    id: text("id").primaryKey(),
    projectId: text("projectId").notNull(),
    traceId: text("traceId")
      .notNull()
      .references(() => trace.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(), // 写回 Score 时的 name
    evaluatorType: text("evaluatorType").notNull(),
    config: jsonb("config"),
    status: text("status").notNull().default("PENDING"), // PENDING | RUNNING | COMPLETED | ERROR
    error: text("error"),
    result: jsonb("result"),
    createdAt: ts("createdAt").notNull().defaultNow(),
    updatedAt: ts("updatedAt").notNull(),
  },
  (t) => [
    index("Evaluation_projectId_createdAt_idx").on(t.projectId, t.createdAt),
    index("Evaluation_traceId_idx").on(t.traceId),
    index("Evaluation_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// 指标采样
// ---------------------------------------------------------------------------

export const metricSample = pgTable(
  "MetricSample",
  {
    id: primaryId(),
    projectId: text("projectId")
      .notNull()
      .references(() => project.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit"),
    kind: text("kind").notNull(), // GAUGE | SUM | HISTOGRAM
    attributes: jsonb("attributes"), // labels（OTLP attributes / 自观测维度）
    timestamp: ts("timestamp").notNull(),
    // gauge / sum：单值
    value: doublePrecision("value"),
    // histogram：摘要
    count: doublePrecision("count"),
    sum: doublePrecision("sum"),
    min: doublePrecision("min"),
    max: doublePrecision("max"),
    buckets: jsonb("buckets"), // [{ boundary: number, count: number }]
    createdAt: ts("createdAt").notNull().defaultNow(),
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
}));

export const metricSampleRelations = relations(metricSample, ({ one }) => ({
  project: one(project, {
    fields: [metricSample.projectId],
    references: [project.id],
  }),
}));
