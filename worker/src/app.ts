// 队列处理器注册
// 参考 Langfuse worker/src/app.ts 的 WorkerManager 模式
// standalone 模式下被 start.ts 同进程 import，共享 queueBus 单例

import { eq } from "drizzle-orm";
import {
  queueBus,
  QUEUES,
  db,
  getEvaluator,
  buildTrajectorySummary,
  selfMetrics,
  evaluation as evaluationTable,
  trace as traceTable,
  score as scoreTable,
  type IngestionQueuePayload,
  type EvaluationQueuePayload,
} from "@machora/shared";

export function registerQueueProcessors(): void {
  queueBus.consume<IngestionQueuePayload>(QUEUES.ingestion, async (payload) => {
    // v1：仅打日志。后续在此做 session 聚合、token 统计等派生计算
    console.log(`[ingestion] project=${payload.projectId} trace=${payload.traceId}`);
  });

  queueBus.consume<EvaluationQueuePayload>(QUEUES.evaluation, async (payload) => {
    await runEvaluation(payload);
  });

  console.log("[worker] Queue processors registered (ingestion, evaluation)");
}

/**
 * 执行服务端评估任务：读 evaluation + trace + observations → 运行评估器 → 写回 Score → 更新状态
 * 幂等：COMPLETED / ERROR 状态的任务直接跳过（不会重复写 Score）
 */
async function runEvaluation(payload: EvaluationQueuePayload): Promise<void> {
  const start = Date.now();
  const evaluation = await db.query.evaluation.findFirst({
    where: eq(evaluationTable.id, payload.evaluationId),
  });
  if (!evaluation || evaluation.projectId !== payload.projectId) return;
  if (evaluation.status === "COMPLETED" || evaluation.status === "ERROR") {
    console.log(`[evaluation] skip (${evaluation.status}) id=${evaluation.id}`);
    return;
  }
  selfMetrics.inc("machora.evaluation.attempted", 1, {
    type: evaluation.evaluatorType,
  });

  try {
    await db
      .update(evaluationTable)
      .set({ status: "RUNNING" })
      .where(eq(evaluationTable.id, evaluation.id));

    const trace = await db.query.trace.findFirst({
      where: eq(traceTable.id, evaluation.traceId),
      with: { observations: true },
    });
    if (!trace) throw new Error(`trace not found: ${evaluation.traceId}`);

    const evaluator = getEvaluator(evaluation.evaluatorType);
    if (!evaluator) throw new Error(`unknown evaluator type: ${evaluation.evaluatorType}`);

    const result = await evaluator.run(
      {
        trace: {
          id: trace.id,
          name: trace.name,
          tags: trace.tags,
          timestamp: trace.timestamp,
          input: trace.input ?? null,
          output: trace.output ?? null,
        },
        observations: trace.observations.map((o) => ({
          id: o.id,
          type: o.type,
          level: o.level,
          name: o.name,
          startTime: o.startTime,
          endTime: o.endTime,
          model: o.model,
          agentName: o.agentName,
          workflowName: o.workflowName,
          skillName: o.skillName,
          parentObservationId: o.parentObservationId,
          totalTokens: o.totalTokens,
          totalCost: o.totalCost,
          input: o.input ?? null,
          output: o.output ?? null,
        })),
        // 轨迹摘要：LLM judge 深度评估输入（按执行顺序，对齐 AgentLoop 轨迹评估）
        trajectorySummary: buildTrajectorySummary(trace.observations as any),
      },
      (evaluation.config as Record<string, unknown>) ?? {},
    );

    await db.insert(scoreTable).values({
      traceId: evaluation.traceId,
      projectId: evaluation.projectId,
      name: evaluation.name,
      value: result.value,
      dataType: result.dataType,
      source: "EVALUATION",
      comment: result.comment ?? null,
    });

    await db
      .update(evaluationTable)
      .set({
        status: "COMPLETED",
        result: {
          ...(result as unknown as Record<string, unknown>),
          durationMs: Date.now() - start,
        } as unknown as typeof evaluationTable.$inferInsert["result"],
      })
      .where(eq(evaluationTable.id, evaluation.id));
    selfMetrics.inc("machora.evaluation.completed", 1, {
      type: evaluation.evaluatorType,
    });
    console.log(
      `[evaluation] completed id=${evaluation.id} type=${evaluation.evaluatorType} value=${result.value}`,
    );
  } catch (e: any) {
    await db
      .update(evaluationTable)
      .set({ status: "ERROR", error: String(e?.message ?? e) })
      .where(eq(evaluationTable.id, evaluation.id));
    selfMetrics.inc("machora.evaluation.failed", 1, {
      type: evaluation.evaluatorType,
    });
    console.error(`[evaluation] failed id=${evaluation.id}`, e);
  } finally {
    selfMetrics.observe("machora.evaluation.duration_ms", Date.now() - start);
  }
}
