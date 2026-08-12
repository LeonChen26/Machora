// 内部评估 API（UI 用）：评估配置 CRUD + 触发评估任务
// session 鉴权，归属校验到当前项目；REST 路由（Server Actions 在本项目 in-process 生产模式不兼容）
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  evaluationConfig,
  evaluation,
  queueBus,
  QUEUES,
  getEvaluator,
  selfMetrics,
  trace,
} from "@machora/shared";
import { getApiUser } from "../../../server/session";
import { getCurrentProjectId } from "../../../server/project";

// ---------------------------------------------------------------------------
// 配置 Schema
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  name: z.string().trim().min(1, "配置名必填").max(60),
  evaluatorType: z.string().min(1, "评估器类型必填"),
  config: z.record(z.string(), z.any()).optional(),
  enabled: z.boolean().optional(),
});

const ConfigUpdateSchema = ConfigSchema.partial().extend({ id: z.string() });

function maskSecret(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) return config;
  const c = { ...config };
  if (c.apiKey) c.apiKey = "••••••••";
  return c;
}

function unmaskSecret(config: Record<string, unknown> | null, prev: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) return prev ?? null;
  const c = { ...config };
  // 掩码未变 → 沿用旧 key
  if (c.apiKey === "••••••••") {
    c.apiKey = prev?.apiKey ?? c.apiKey;
  }
  return c;
}

// ---------------------------------------------------------------------------
// GET /api/evaluations —— 配置列表（含掩码）+ 最近任务
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const view = sp.get("view") ?? "config";

  if (view === "tasks") {
    const tasks = await db.query.evaluation.findMany({
      where: eq(evaluation.projectId, projectId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 100,
    });
    return NextResponse.json({ tasks });
  }

  const configs = await db.query.evaluationConfig.findMany({
    where: eq(evaluationConfig.projectId, projectId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  return NextResponse.json({
    configs: configs.map((c) => ({
      ...c,
      config: maskSecret(c.config as Record<string, unknown> | null),
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/evaluations —— 新建配置 或 触发评估任务
// ---------------------------------------------------------------------------

const CreateBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config"),
    name: z.string().trim().min(1, "配置名必填").max(60),
    evaluatorType: z.string().min(1, "评估器类型必填"),
    config: z.record(z.string(), z.any()).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("run"),
    traceId: z.string().min(1, "traceId 必填"),
    name: z.string().trim().min(1, "任务名必填").max(60),
    evaluatorType: z.string().min(1, "评估器类型必填"),
    config: z.record(z.string(), z.any()).optional(),
    configId: z.string().optional(),
  }),
]);

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
  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // 注册表校验
  if (!getEvaluator(d.evaluatorType)) {
    return NextResponse.json({ error: `未知评估器类型: ${d.evaluatorType}` }, { status: 400 });
  }

  if (d.kind === "config") {
    const exists = await db.query.evaluationConfig.findFirst({
      where: and(
        eq(evaluationConfig.projectId, projectId),
        eq(evaluationConfig.name, d.name),
      ),
      columns: { id: true },
    });
    if (exists) {
      return NextResponse.json({ error: `配置名已存在: ${d.name}` }, { status: 400 });
    }
    const [row] = await db
      .insert(evaluationConfig)
      .values({
        projectId,
        name: d.name,
        evaluatorType: d.evaluatorType,
        config: d.config ?? undefined,
        enabled: d.enabled ?? true,
        updatedAt: new Date(),
      })
      .returning();
    selfMetrics.inc("machora.evaluation.config_created", 1, {
      type: d.evaluatorType,
    });
    return NextResponse.json({ config: row }, { status: 201 });
  }

  // kind === "run"：校验 trace 归属并创建评估任务
  const traceRow = await db.query.trace.findFirst({
    where: and(eq(trace.id, d.traceId), eq(trace.projectId, projectId)),
    columns: { id: true },
  });
  if (!traceRow) {
    return NextResponse.json({ error: "Trace 不存在或不属于当前项目" }, { status: 404 });
  }

  // 支持 configId：从配置表读取完整参数（LLM judge 的 model/apiKey 等）
  let evaluatorType = d.evaluatorType;
  let runConfig = d.config;
  if (d.configId) {
    const cfg = await db.query.evaluationConfig.findFirst({
      where: and(
        eq(evaluationConfig.id, d.configId),
        eq(evaluationConfig.projectId, projectId),
        eq(evaluationConfig.enabled, true),
      ),
    });
    if (!cfg) {
      return NextResponse.json({ error: "配置不存在或已停用" }, { status: 400 });
    }
    evaluatorType = cfg.evaluatorType;
    runConfig = (cfg.config as Record<string, unknown> | null) ?? {};
  }
  if (!getEvaluator(evaluatorType)) {
    return NextResponse.json({ error: `未知评估器类型: ${evaluatorType}` }, { status: 400 });
  }

  const [task] = await db
    .insert(evaluation)
    .values({
      id: crypto.randomUUID(),
      projectId,
      traceId: d.traceId,
      name: d.name,
      evaluatorType,
      config: runConfig ?? undefined,
      status: "PENDING",
      updatedAt: new Date(),
    })
    .returning();

  await queueBus.enqueue(QUEUES.evaluation, {
    projectId,
    evaluationId: task.id,
  });

  selfMetrics.inc("machora.evaluation.run_triggered", 1, {
    type: d.evaluatorType,
  });
  return NextResponse.json({ task }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH /api/evaluations —— 更新配置（id in body）
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
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
  const parsed = ConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { id, ...updates } = parsed.data;

  const prev = await db.query.evaluationConfig.findFirst({
    where: and(eq(evaluationConfig.id, id), eq(evaluationConfig.projectId, projectId)),
  });
  if (!prev) {
    return NextResponse.json({ error: "配置不存在" }, { status: 404 });
  }

  const next = { ...updates };
  next.config =
    unmaskSecret(
      updates.config as Record<string, unknown> | null,
      prev.config as Record<string, unknown> | null,
    ) ?? undefined;
  if (updates.evaluatorType && !getEvaluator(updates.evaluatorType)) {
    return NextResponse.json({ error: `未知评估器类型: ${updates.evaluatorType}` }, { status: 400 });
  }

  const [row] = await db
    .update(evaluationConfig)
    .set({
      ...(next.name !== undefined ? { name: next.name } : {}),
      ...(next.evaluatorType !== undefined ? { evaluatorType: next.evaluatorType } : {}),
      ...(next.config !== undefined ? { config: next.config } : {}),
      ...(next.enabled !== undefined ? { enabled: next.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(eq(evaluationConfig.id, id))
    .returning();
  return NextResponse.json({ config: row });
}

// ---------------------------------------------------------------------------
// DELETE /api/evaluations?id=xxx —— 删除配置
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id 必填" }, { status: 400 });

  const prev = await db.query.evaluationConfig.findFirst({
    where: and(eq(evaluationConfig.id, id), eq(evaluationConfig.projectId, projectId)),
    columns: { id: true },
  });
  if (!prev) return NextResponse.json({ error: "配置不存在" }, { status: 404 });

  await db.delete(evaluationConfig).where(eq(evaluationConfig.id, id));
  return NextResponse.json({ ok: true });
}
