// 队列处理器注册
// 参考 Langfuse worker/src/app.ts 的 WorkerManager 模式
// standalone 模式下被 start.ts 同进程 import，共享 queueBus 单例

import {
  queueBus,
  QUEUES,
  prisma,
  getEvaluator,
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
  const evaluation = await prisma.evaluation.findUnique({
    where: { id: payload.evaluationId },
  });
  if (!evaluation || evaluation.projectId !== payload.projectId) return;
  if (evaluation.status === "COMPLETED" || evaluation.status === "ERROR") {
    console.log(`[evaluation] skip (${evaluation.status}) id=${evaluation.id}`);
    return;
  }

  try {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: "RUNNING" },
    });

    const trace = await prisma.trace.findUnique({
      where: { id: evaluation.traceId },
      include: { observations: true },
    });
    if (!trace) throw new Error(`trace not found: ${evaluation.traceId}`);

    const evaluator = getEvaluator(evaluation.evaluatorType);
    if (!evaluator) throw new Error(`unknown evaluator type: ${evaluation.evaluatorType}`);

    const result = await evaluator.run(
      {
        trace: { id: trace.id, tags: trace.tags, timestamp: trace.timestamp },
        observations: trace.observations.map((o) => ({
          id: o.id,
          type: o.type,
          level: o.level,
          startTime: o.startTime,
          endTime: o.endTime,
          model: o.model,
          totalTokens: o.totalTokens,
          totalCost: o.totalCost,
        })),
      },
      (evaluation.config as Record<string, unknown>) ?? {},
    );

    await prisma.score.create({
      data: {
        traceId: evaluation.traceId,
        projectId: evaluation.projectId,
        name: evaluation.name,
        value: result.value,
        dataType: result.dataType,
        source: "EVALUATION",
        comment: result.comment ?? null,
      },
    });

    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: "COMPLETED", result: result as object },
    });
    console.log(
      `[evaluation] completed id=${evaluation.id} type=${evaluation.evaluatorType} value=${result.value}`,
    );
  } catch (e: any) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { status: "ERROR", error: String(e?.message ?? e) },
    });
    console.error(`[evaluation] failed id=${evaluation.id}`, e);
  }
}
