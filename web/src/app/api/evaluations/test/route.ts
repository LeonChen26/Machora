// 评估配置「测试运行」：对最新一条 trace 触发评估（同步等待结果或异步入队）
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import {
  db,
  evaluation,
  evaluationConfig,
  queueBus,
  QUEUES,
  trace,
} from "@machora/shared";

const TestSchema = z.object({
  configId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = TestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "configId 必填" }, { status: 400 });
  }

  const cfg = await db.query.evaluationConfig.findFirst({
    where: eq(evaluationConfig.id, parsed.data.configId),
  });
  if (!cfg) {
    return NextResponse.json({ error: "配置不存在" }, { status: 404 });
  }

  // 取最新一条 trace 作为测试样本
  const latest = await db.query.trace.findFirst({
    orderBy: (t, { desc }) => [desc(t.timestamp)],
    columns: { id: true },
  });
  if (!latest) {
    return NextResponse.json({ error: "暂无 trace，无法测试" }, { status: 400 });
  }

  const [task] = await db
    .insert(evaluation)
    .values({
      id: crypto.randomUUID(),
      traceId: latest.id,
      name: `test:${cfg.name}`,
      evaluatorType: cfg.evaluatorType,
      config: cfg.config ?? undefined,
      status: "PENDING",
      updatedAt: new Date(),
    })
    .returning();

  await queueBus.enqueue(QUEUES.evaluation, {
    evaluationId: task.id,
  });

  return NextResponse.json({
    ok: true,
    message: `已对最新 trace ${latest.id.slice(0, 8)}… 触发「${cfg.name}」测试`,
  });
}
