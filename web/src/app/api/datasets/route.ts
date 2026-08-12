// 数据集 API：Prompt 级评测用例管理（Langfuse dataset 简化版：name 为数据集名，item 为用例）
// session 鉴权，归属校验到当前项目
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, datasetItem, evaluation, selfMetrics } from "@machora/shared";
import { getApiUser } from "../../../server/session";
import { getCurrentProjectId } from "../../../server/project";

const ItemSchema = z.object({
  name: z.string().trim().min(1, "数据集名必填").max(60),
  input: z.any().optional(),
  output: z.any().optional(),
  expectedOutput: z.any().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// GET /api/datasets —— 数据集列表（按 name 分组，含每条用例）
export async function GET(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });

  const items = await db.query.datasetItem.findMany({
    where: eq(datasetItem.projectId, projectId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 2000,
  });

  const byName = new Map<string, typeof items>();
  for (const item of items) {
    const arr = byName.get(item.name) ?? [];
    arr.push(item);
    byName.set(item.name, arr);
  }

  // 评测统计：每个数据集名 × 配置名 → 平均分/通过率/次数（仅 COMPLETED 数据集任务）
  const tasks = await db.query.evaluation.findMany({
    where: and(
      eq(evaluation.projectId, projectId),
      sql`${evaluation.datasetItemId} IS NOT NULL`,
      eq(evaluation.status, "COMPLETED"),
    ),
    columns: { name: true, datasetItemId: true, result: true },
    limit: 5000,
  });
  const itemNameOf = new Map(items.map((i) => [i.id, i.name]));
  const statsByDataset = new Map<
    string,
    Map<string, { sum: number; n: number; dataType: string }>
  >();
  for (const t of tasks) {
    const dsName = t.datasetItemId ? itemNameOf.get(t.datasetItemId) : undefined;
    if (!dsName) continue;
    const r = (t.result ?? {}) as Record<string, unknown>;
    if (typeof r.value !== "number") continue;
    let m = statsByDataset.get(dsName);
    if (!m) {
      m = new Map();
      statsByDataset.set(dsName, m);
    }
    const acc = m.get(t.name) ?? { sum: 0, n: 0, dataType: String(r.dataType ?? "NUMERIC") };
    acc.sum += r.value;
    acc.n += 1;
    m.set(t.name, acc);
  }

  const datasets = Array.from(byName.entries()).map(([name, list]) => {
    const stats = Array.from((statsByDataset.get(name) ?? new Map()).entries()).map(
      ([configName, acc]) => ({
        configName,
        n: acc.n,
        avg: +(acc.sum / acc.n).toFixed(3),
        passRate: acc.dataType === "BOOLEAN" ? +(acc.sum / acc.n).toFixed(3) : null,
        dataType: acc.dataType,
      }),
    );
    stats.sort((a, b) => b.n - a.n);
    return { name, count: list.length, items: list, stats };
  });
  return NextResponse.json({ datasets });
}

// POST /api/datasets —— 新增数据集用例
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
  const parsed = ItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { name, input, output, expectedOutput, metadata } = parsed.data;

  const [row] = await db
    .insert(datasetItem)
    .values({
      projectId,
      name,
      input: input ?? null,
      output: output ?? null,
      expectedOutput: expectedOutput ?? null,
      metadata: metadata ?? null,
    })
    .returning();
  selfMetrics.inc("machora.evaluation.dataset_item_created", 1, {
    dataset: name,
  });
  return NextResponse.json({ item: row }, { status: 201 });
}

// DELETE /api/datasets?id=xxx 删单条用例；?name=xxx 删整个数据集
export async function DELETE(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const projectId = await getCurrentProjectId();
  if (!projectId) return NextResponse.json({ error: "No project" }, { status: 400 });

  const sp = new URL(req.url).searchParams;
  const id = sp.get("id");
  const name = sp.get("name");
  if (!id && !name) {
    return NextResponse.json({ error: "id 或 name 必填" }, { status: 400 });
  }

  if (id) {
    const prev = await db.query.datasetItem.findFirst({
      where: and(eq(datasetItem.id, id), eq(datasetItem.projectId, projectId)),
      columns: { id: true },
    });
    if (!prev) return NextResponse.json({ error: "用例不存在" }, { status: 404 });
    await db.delete(datasetItem).where(eq(datasetItem.id, id));
  } else {
    const rows = await db.query.datasetItem.findMany({
      where: and(eq(datasetItem.projectId, projectId), eq(datasetItem.name, name!)),
      columns: { id: true },
      limit: 2000,
    });
    if (rows.length === 0) return NextResponse.json({ error: "数据集不存在" }, { status: 404 });
    for (const r of rows) {
      await db.delete(datasetItem).where(eq(datasetItem.id, r.id));
    }
  }
  return NextResponse.json({ ok: true });
}
