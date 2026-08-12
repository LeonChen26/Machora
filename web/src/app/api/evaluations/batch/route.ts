// 批量评估：按 tag 或显式 traceId 列表对一批 trace 触发评估任务
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  evaluation,
  evaluationConfig,
  queueBus,
  QUEUES,
  trace,
  score,
} from "@machora/shared";
import { getApiUser } from "../../../../server/session";
import { getCurrentProjectId } from "../../../../server/project";

const BatchSchema = z.object({
  configId: z.string().min(1, "configId 必填"),
  tag: z.string().optional(),
  traceIds: z.array(z.string().min(1)).max(1000).optional(),
  // 低分回流：score < 阈值 的 trace（用当前项目 Score 过滤）
  maxScore: z.number().min(0).max(1).optional(),
}).refine((d) => d.tag || d.traceIds || d.maxScore !== undefined, {
  message: "tag / traceIds / maxScore 至少提供一个",
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
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { configId, tag, traceIds, maxScore } = parsed.data;

  const cfg = await db.query.evaluationConfig.findFirst({
    where: and(
      eq(evaluationConfig.id, configId),
      eq(evaluationConfig.projectId, projectId),
      eq(evaluationConfig.enabled, true),
    ),
  });
  if (!cfg) {
    return NextResponse.json({ error: "配置不存在或已停用" }, { status: 400 });
  }

  // 目标 trace 集合
  let targets: string[] = [];
  if (traceIds && traceIds.length > 0) {
    const rows = await db
      .select({ id: trace.id })
      .from(trace)
      .where(
        and(eq(trace.projectId, projectId), inArray(trace.id, traceIds)),
      );
    targets = rows.map((r) => r.id);
  } else if (tag) {
    // tags 是 text[]，用 @> 数组包含过滤
    const rows = await db
      .select({ id: trace.id })
      .from(trace)
      .where(
        and(
          eq(trace.projectId, projectId),
          sql`${trace.tags} @> ARRAY[${tag}]`,
        ),
      )
      .limit(1000);
    targets = rows.map((r) => r.id);
  } else if (maxScore !== undefined) {
    // 低分回流：该项目内 score < 阈值 的 trace（EVALUATION/ANNOTATION 均可）
    const rows = await db
      .selectDistinct({ traceId: score.traceId })
      .from(score)
      .where(
        and(
          eq(score.projectId, projectId),
          sql`${score.value} < ${maxScore}`,
        ),
      )
      .limit(1000);
    targets = rows.map((r) => r.traceId).filter((v): v is string => !!v);
  }

  if (targets.length === 0) {
    return NextResponse.json({ error: "没有匹配的 trace" }, { status: 400 });
  }

  // 逐个创建评估任务并入队
  const runConfig = (cfg.config as Record<string, unknown> | null) ?? {};
  const created: string[] = [];
  for (const traceId of targets) {
    const [task] = await db
      .insert(evaluation)
      .values({
        id: crypto.randomUUID(),
        projectId,
        traceId,
        name: cfg.name,
        evaluatorType: cfg.evaluatorType,
        config: runConfig,
        status: "PENDING",
        updatedAt: new Date(),
      })
      .returning({ id: evaluation.id });
    await queueBus.enqueue(QUEUES.evaluation, {
      projectId,
      evaluationId: task.id,
    });
    created.push(task.id);
  }

  return NextResponse.json({ ok: true, count: created.length, traceIds: targets.length });
}
