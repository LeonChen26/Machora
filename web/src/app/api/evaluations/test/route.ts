// 评估配置「测试运行」：对项目内最新一条 trace 触发评估（同步等待结果或异步入队）
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  evaluation,
  evaluationConfig,
  queueBus,
  QUEUES,
  trace,
} from "@machora/shared";
import { getApiUser } from "../../../../server/session";
import { getCurrentProjectId } from "../../../../server/project";

const TestSchema = z.object({
  configId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });

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
    where: and(
      eq(evaluationConfig.id, parsed.data.configId),
      eq(evaluationConfig.projectId, projectId),
    ),
  });
  if (!cfg) {
    return NextResponse.json({ error: "配置不存在" }, { status: 404 });
  }

  // 取项目内最新一条 trace 作为测试样本
  const latest = await db.query.trace.findFirst({
    where: eq(trace.projectId, projectId),
    orderBy: (t, { desc }) => [desc(t.timestamp)],
    columns: { id: true },
  });
  if (!latest) {
    return NextResponse.json({ error: "项目内暂无 trace，无法测试" }, { status: 400 });
  }

  const [task] = await db
    .insert(evaluation)
    .values({
      id: crypto.randomUUID(),
      projectId,
      traceId: latest.id,
      name: `test:${cfg.name}`,
      evaluatorType: cfg.evaluatorType,
      config: cfg.config ?? undefined,
      status: "PENDING",
      updatedAt: new Date(),
    })
    .returning();

  await queueBus.enqueue(QUEUES.evaluation, {
    projectId,
    evaluationId: task.id,
  });

  return NextResponse.json({
    ok: true,
    message: `已对最新 trace ${latest.id.slice(0, 8)}… 触发「${cfg.name}」测试`,
  });
}
