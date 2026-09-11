-- Machora SQLite Schema（表结构唯一真源）
--
-- 约定：
-- 1. 幂等：全部 CREATE ... IF NOT EXISTS，可重复执行
-- 2. 类型映射（原 Postgres → SQLite）：
--    TEXT → TEXT / JSONB → TEXT / TIMESTAMP(3) → INTEGER(epoch ms)
--    DOUBLE PRECISION → REAL / BOOLEAN → INTEGER(0|1) / TEXT[] → TEXT(JSON 数组)
-- 3. 外键必须内联在 CREATE TABLE 中（SQLite 不支持 ALTER TABLE ADD CONSTRAINT），
--    且运行时需 PRAGMA foreign_keys = ON 才生效（见 packages/shared/src/db.ts）
-- 4. 参与模糊搜索的列标注：使 LIKE 大小写不敏感（替代 PG 的 ILIKE），
--    且能命中索引。对应查询层 textSearch()（packages/shared/src/db-dialect.ts）
-- 5. 增量补列不写在本文件，改由 start.ts 的 ensureColumn() 基于 PRAGMA table_info 执行
--    （SQLite 不支持 ADD COLUMN IF NOT EXISTS）

-- CreateTable
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "publicKey" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Trace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT,
    "timestamp" INTEGER NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "sessionId" TEXT,
    "agentName" TEXT,
    "workflowName" TEXT,
    "skillName" TEXT,
    "input" TEXT,
    "output" TEXT,
    "metadata" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Observation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "parentObservationId" TEXT,
    "startTime" INTEGER NOT NULL,
    "endTime" INTEGER,
    "model" TEXT,
    "agentName" TEXT,
    "workflowName" TEXT,
    "skillName" TEXT,
    "input" TEXT,
    "output" TEXT,
    "metadata" TEXT,
    "level" TEXT NOT NULL DEFAULT 'DEFAULT',
    "usage" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "totalCost" REAL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Score" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "observationId" TEXT,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "dataType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "comment" TEXT,
    "timestamp" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
-- 注：datasetItemId 外键在 DatasetItem 之后无法内联前向引用，SQLite 允许
-- 引用尚未创建的表（仅在 PRAGMA foreign_keys=ON 且实际写入时校验），
-- 但为可读性仍把 DatasetItem 放在 Evaluation 之前创建。
CREATE TABLE IF NOT EXISTS "DatasetItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "input" TEXT,
    "output" TEXT,
    "expectedOutput" TEXT,
    "metadata" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateTable
-- traceId 可空：数据集评测任务不关联 trace（原 PG 版通过 ALTER COLUMN DROP NOT NULL
-- 后补，SQLite 不支持该语句，故直接建为可空）
CREATE TABLE IF NOT EXISTS "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "traceId" TEXT REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "datasetItemId" TEXT REFERENCES "DatasetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mode" TEXT NOT NULL DEFAULT 'EXPERIMENT',
    "error" TEXT,
    "result" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    "updatedAt" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EvaluationConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" TEXT,
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "autoRun" INTEGER NOT NULL DEFAULT 0,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    "updatedAt" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetricSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "kind" TEXT NOT NULL,
    "attributes" TEXT,
    "timestamp" INTEGER NOT NULL,
    "value" REAL,
    "count" REAL,
    "sum" REAL,
    "min" REAL,
    "max" REAL,
    "buckets" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_publicKey_key" ON "ApiKey"("publicKey");
CREATE INDEX IF NOT EXISTS "ApiKey_projectId_idx" ON "ApiKey"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE INDEX IF NOT EXISTS "Trace_projectId_timestamp_idx" ON "Trace"("projectId", "timestamp");
CREATE INDEX IF NOT EXISTS "Trace_userId_idx" ON "Trace"("userId");
CREATE INDEX IF NOT EXISTS "Trace_sessionId_idx" ON "Trace"("sessionId");
CREATE INDEX IF NOT EXISTS "Observation_projectId_startTime_idx" ON "Observation"("projectId", "startTime");
CREATE INDEX IF NOT EXISTS "Observation_traceId_idx" ON "Observation"("traceId");
CREATE INDEX IF NOT EXISTS "Observation_parentObservationId_idx" ON "Observation"("parentObservationId");
CREATE INDEX IF NOT EXISTS "Score_projectId_timestamp_idx" ON "Score"("projectId", "timestamp");
CREATE INDEX IF NOT EXISTS "Score_traceId_idx" ON "Score"("traceId");
CREATE INDEX IF NOT EXISTS "Evaluation_projectId_createdAt_idx" ON "Evaluation"("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "Evaluation_traceId_idx" ON "Evaluation"("traceId");
CREATE INDEX IF NOT EXISTS "Evaluation_status_idx" ON "Evaluation"("status");
CREATE INDEX IF NOT EXISTS "Evaluation_datasetItemId_idx" ON "Evaluation"("datasetItemId");
CREATE INDEX IF NOT EXISTS "DatasetItem_projectId_name_idx" ON "DatasetItem"("projectId", "name");
CREATE INDEX IF NOT EXISTS "EvaluationConfig_projectId_idx" ON "EvaluationConfig"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationConfig_projectId_name_key" ON "EvaluationConfig"("projectId", "name");
CREATE INDEX IF NOT EXISTS "MetricSample_projectId_name_timestamp_idx" ON "MetricSample"("projectId", "name", "timestamp");
CREATE INDEX IF NOT EXISTS "MetricSample_name_timestamp_idx" ON "MetricSample"("name", "timestamp");
