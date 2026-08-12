-- CreateTable
CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Trace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "sessionId" TEXT,
    "agentName" TEXT,
    "workflowName" TEXT,
    "skillName" TEXT,
    "input" JSONB,
    "output" JSONB,
    "metadata" JSONB,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Observation" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "parentObservationId" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "model" TEXT,
    "agentName" TEXT,
    "workflowName" TEXT,
    "skillName" TEXT,
    "input" JSONB,
    "output" JSONB,
    "metadata" JSONB,
    "level" TEXT NOT NULL DEFAULT 'DEFAULT',
    "usage" JSONB,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "totalCost" DOUBLE PRECISION,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Score" (
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "observationId" TEXT,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "dataType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "comment" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Evaluation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "traceId" TEXT,
    "datasetItemId" TEXT,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mode" TEXT NOT NULL DEFAULT 'EXPERIMENT',
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DatasetItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "expectedOutput" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EvaluationConfig" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
    "autoRun" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "MetricSample" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "kind" TEXT NOT NULL,
    "attributes" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "value" DOUBLE PRECISION,
    "count" DOUBLE PRECISION,
    "sum" DOUBLE PRECISION,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "buckets" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- 存量表补列（幂等，须在建索引前执行，保证新列上的索引可用）
ALTER TABLE IF EXISTS "EvaluationConfig" ADD COLUMN IF NOT EXISTS "autoRun" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS "Evaluation" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'EXPERIMENT';
ALTER TABLE IF EXISTS "Evaluation" ALTER COLUMN "traceId" DROP NOT NULL;
ALTER TABLE IF EXISTS "Evaluation" ADD COLUMN IF NOT EXISTS "datasetItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_publicKey_key" ON "ApiKey"("publicKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApiKey_projectId_idx" ON "ApiKey"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trace_projectId_timestamp_idx" ON "Trace"("projectId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trace_userId_idx" ON "Trace"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trace_sessionId_idx" ON "Trace"("sessionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Observation_projectId_startTime_idx" ON "Observation"("projectId", "startTime");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Observation_traceId_idx" ON "Observation"("traceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Observation_parentObservationId_idx" ON "Observation"("parentObservationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Score_projectId_timestamp_idx" ON "Score"("projectId", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Score_traceId_idx" ON "Score"("traceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Evaluation_projectId_createdAt_idx" ON "Evaluation"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Evaluation_traceId_idx" ON "Evaluation"("traceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Evaluation_status_idx" ON "Evaluation"("status");
CREATE INDEX IF NOT EXISTS "Evaluation_datasetItemId_idx" ON "Evaluation"("datasetItemId");
CREATE INDEX IF NOT EXISTS "DatasetItem_projectId_name_idx" ON "DatasetItem"("projectId", "name");
CREATE INDEX IF NOT EXISTS "EvaluationConfig_projectId_idx" ON "EvaluationConfig"("projectId");
CREATE UNIQUE INDEX IF NOT EXISTS "EvaluationConfig_projectId_name_key" ON "EvaluationConfig"("projectId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetricSample_projectId_name_timestamp_idx" ON "MetricSample"("projectId", "name", "timestamp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MetricSample_name_timestamp_idx" ON "MetricSample"("name", "timestamp");

-- 存量表补列（幂等）
-- （已上移到建索引之前执行，见上）

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trace" ADD CONSTRAINT "Trace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetItem" ADD CONSTRAINT "DatasetItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_datasetItemId_fkey" FOREIGN KEY ("datasetItemId") REFERENCES "DatasetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
