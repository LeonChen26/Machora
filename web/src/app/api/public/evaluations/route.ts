import { z } from "zod";
import { prisma, queueBus, QUEUES, getEvaluator } from "@machora/shared";
import { verifyApiKey } from "../../../../server/auth";
import { listEnvelope, parseCommonQuery, timeWindow } from "../../../../server/publicQuery";

const EvaluationCreateSchema = z.object({
  traceId: z.string(),
  name: z.string().optional(),
  evaluatorType: z.string().min(1),
  config: z.record(z.string(), z.any()).optional(),
});

// POST /api/public/evaluations —— 创建服务端评估任务（异步，worker 执行后写回 Score）
export async function POST(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = EvaluationCreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { traceId, name, evaluatorType, config } = parsed.data;

  const trace = await prisma.trace.findUnique({
    where: { id: traceId },
    select: { id: true },
  });
  if (!trace) {
    return Response.json({ error: "Trace not found" }, { status: 404 });
  }

  // 注册表校验：内置规则评估器；LLM judge 等注册后立即可用
  if (!getEvaluator(evaluatorType)) {
    return Response.json(
      { error: `Unknown evaluatorType: ${evaluatorType}` },
      { status: 400 },
    );
  }

  const evaluation = await prisma.evaluation.create({
    data: {
      projectId: auth.projectId,
      traceId,
      name: name ?? evaluatorType,
      evaluatorType,
      config: config ?? undefined,
      status: "PENDING",
    },
  });

  await queueBus.enqueue(QUEUES.evaluation, {
    projectId: auth.projectId,
    evaluationId: evaluation.id,
  });

  return Response.json({ data: evaluation }, { status: 201 });
}

// GET /api/public/evaluations?traceId&status&from&to&limit&cursor —— 查询评估任务列表
export async function GET(req: Request) {
  const auth = await verifyApiKey(req.headers.get("authorization") ?? undefined);
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const sp = new URL(req.url).searchParams;
  const parsed = parseCommonQuery(sp);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { limit, cursor, from, to } = parsed.value;

  const traceId = sp.get("traceId") || undefined;
  const status = sp.get("status") || undefined;

  const where = {
    projectId: auth.projectId,
    createdAt: timeWindow(from, to),
    ...(traceId ? { traceId } : {}),
    ...(status ? { status } : {}),
  };

  const [items, totalCount] = await Promise.all([
    prisma.evaluation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    }),
    prisma.evaluation.count({ where }),
  ]);

  const nextCursor = items.length > limit ? items[items.length - 1].id : null;
  return Response.json(
    listEnvelope(items.slice(0, limit), { limit, nextCursor, totalCount }),
  );
}
