// 队列处理器注册
// 参考 Langfuse worker/src/app.ts 的 WorkerManager 模式
// standalone 模式下被 start.ts 同进程 import，共享 queueBus 单例

import { and, eq } from "drizzle-orm";
import {
  queueBus,
  QUEUES,
  db,
  getEvaluator,
  buildTrajectorySummary,
  selfMetrics,
  evaluation as evaluationTable,
  evaluationConfig,
  trace as traceTable,
  score as scoreTable,
  type IngestionQueuePayload,
  type EvaluationQueuePayload,
} from "@machora/shared";

export function registerQueueProcessors(): void {
  queueBus.consume<IngestionQueuePayload>(QUEUES.ingestion, async (payload) => {
    // 在线自动评估：ingestion 完成后，对该项目启用的评估配置自动创建任务（AgentLoop 在线评估模式）
    await triggerOnlineEvaluations(payload.projectId, payload.traceId);
  });

  queueBus.consume<EvaluationQueuePayload>(QUEUES.evaluation, async (payload) => {
    await runEvaluation(payload);
  });

  console.log("[worker] Queue processors registered (ingestion, evaluation)");
}

/**
 * 在线自动评估：查询项目内 enabled 的评估配置，为当前 trace 逐条创建评估任务并入队。
 * 防重复：同 trace 同 name 已存在未终结（PENDING/RUNNING）任务时跳过。
 */
async function triggerOnlineEvaluations(
  projectId: string,
  traceId: string,
): Promise<void> {
  // 在线自动评估仅对 autoRun=true 的配置生效（AgentLoop 在线评估模式）；
  // enabled 仅控制手动触发。避免 LLM judge 对每条 trace 自动产生成本。
  const configs = await db.query.evaluationConfig.findMany({
    where: and(
      eq(evaluationConfig.projectId, projectId),
      eq(evaluationConfig.enabled, true),
      eq(evaluationConfig.autoRun, true),
    ),
    columns: { id: true, name: true, evaluatorType: true, config: true },
  });
  if (configs.length === 0) return;

  // 该 trace 已有未终结任务（避免 ingestion 重复事件/重试导致重复评估）
  const existing = await db.query.evaluation.findMany({
    where: eq(evaluationTable.traceId, traceId),
    columns: { name: true, status: true },
  });
  const runningNames = new Set(
    existing
      .filter((e) => e.status === "PENDING" || e.status === "RUNNING")
      .map((e) => e.name),
  );

  for (const cfg of configs) {
    if (runningNames.has(cfg.name)) continue;
    const [task] = await db
      .insert(evaluationTable)
      .values({
        id: crypto.randomUUID(),
        projectId,
        traceId,
        name: cfg.name,
        evaluatorType: cfg.evaluatorType,
        config: (cfg.config as Record<string, unknown> | null) ?? undefined,
        status: "PENDING",
        mode: "ONLINE",
        updatedAt: new Date(),
      })
      .returning({ id: evaluationTable.id });
    await queueBus.enqueue(QUEUES.evaluation, {
      projectId,
      evaluationId: task.id,
    });
    selfMetrics.inc("machora.evaluation.online_triggered", 1, {
      type: cfg.evaluatorType,
    });
  }
  if (configs.length > 0) {
    console.log(
      `[ingestion] project=${projectId} trace=${traceId} online-evals=${configs.length}`,
    );
  }
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
