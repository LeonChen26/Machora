import {
  db,
  queueBus,
  IngestionBatchSchema,
  QUEUES,
  calculateCost,
  selfMetrics,
  trace as traceTable,
  observation as observationTable,
  score as scoreTable,
} from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";

export async function POST(req: Request) {
  const start = Date.now();
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    selfMetrics.inc("machora.ingestion.requests", 1, { status: "unauthorized" });
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const projectId = auth.projectId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    selfMetrics.inc("machora.ingestion.requests", 1, { status: "bad-json" });
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = IngestionBatchSchema.safeParse(body);
  if (!parsed.success) {
    selfMetrics.inc("machora.ingestion.requests", 1, { status: "bad-payload" });
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { batch } = parsed.data;
  const errors: { index: number; error: string }[] = [];

  // 顺序处理：batch 内事件存在依赖（observation 依赖同批先建的 trace），
  // 并发写入会触发外键约束失败
  for (const [index, event] of batch.entries()) {
    try {
      if (event.type === "trace-create") {
        await db.insert(traceTable).values({
          id: event.body.id,
          projectId,
          name: event.body.name ?? null,
          timestamp: new Date(event.body.timestamp),
          environment: event.body.environment,
          userId: event.body.userId ?? null,
          sessionId: event.body.sessionId ?? null,
          agentName: event.body.agentName ?? null,
          workflowName: event.body.workflowName ?? null,
          skillName: event.body.skillName ?? null,
          input: (event.body.input ?? null) as unknown as typeof traceTable.$inferInsert["input"],
          output: (event.body.output ?? null) as unknown as typeof traceTable.$inferInsert["output"],
          metadata: (event.body.metadata ?? null) as unknown as typeof traceTable.$inferInsert["metadata"],
          tags: event.body.tags,
        });
        queueBus.enqueue(QUEUES.ingestion, {
          projectId,
          traceId: event.body.id,
        });
      } else if (event.type === "observation-create") {
        // 服务端根据 usage / input-output 推算 token 与成本
        const billing = calculateCost(
          event.body.model,
          event.body.usage ?? null,
          event.body.input ?? null,
          event.body.output ?? null,
        );
        await db.insert(observationTable).values({
          id: event.body.id,
          traceId: event.body.traceId,
          projectId,
          type: event.body.type,
          name: event.body.name ?? null,
          parentObservationId: event.body.parentObservationId ?? null,
          startTime: new Date(event.body.startTime),
          endTime: event.body.endTime ? new Date(event.body.endTime) : null,
          model: event.body.model ?? null,
          agentName: event.body.agentName ?? null,
          workflowName: event.body.workflowName ?? null,
          input: (event.body.input ?? null) as unknown as typeof observationTable.$inferInsert["input"],
          output: (event.body.output ?? null) as unknown as typeof observationTable.$inferInsert["output"],
          metadata: (event.body.metadata ?? null) as unknown as typeof observationTable.$inferInsert["metadata"],
          level: event.body.level,
          usage: (event.body.usage ?? null) as unknown as typeof observationTable.$inferInsert["usage"],
          inputTokens: billing.inputTokens,
          outputTokens: billing.outputTokens,
          totalTokens: billing.totalTokens,
          totalCost: billing.totalCost,
        });
      } else if (event.type === "score-create") {
        await db.insert(scoreTable).values({
          id: event.body.id,
          traceId: event.body.traceId ?? null,
          observationId: event.body.observationId ?? null,
          projectId,
          name: event.body.name,
          value: event.body.value,
          dataType: event.body.dataType,
          source: event.body.source,
          comment: event.body.comment ?? null,
        });
      }
    } catch (e: any) {
      errors.push({ index, error: e.message });
    }
  }

  selfMetrics.inc("machora.ingestion.requests", 1, {
    status: errors.length ? "error" : "ok",
  });
  selfMetrics.inc("machora.ingestion.events", batch.length);
  selfMetrics.observe("machora.ingestion.duration_ms", Date.now() - start);

  return Response.json({
    success: true,
    received: batch.length,
    errors: errors.length ? errors : undefined,
  });
}