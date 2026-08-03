// Projects 管理 REST 路由（create/delete）
// 注：与 /api/keys 一致，未使用 Server Actions —— 本项目 in-process 自定义服务器
// 生产模式下 Server Action 的 flight reply 解码存在环境级不兼容。
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@machora/shared";
import { getApiUser } from "../../../server/session";

const CreateSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称").max(60),
});

export async function POST(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }

  const project = await prisma.project.create({
    data: { name: parsed.data.name },
  });
  return NextResponse.json({ project: { id: project.id, name: project.name } });
}

export async function DELETE(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }

  // 至少保留一个项目，避免空库状态（standalone seed 只负责重建默认项目）
  const total = await prisma.project.count();
  if (total <= 1) {
    return NextResponse.json({ error: "至少保留一个项目" }, { status: 400 });
  }

  try {
    // 级联删除：apiKeys / traces（traces 再级联 observations、scores），schema 已配 onDelete: Cascade
    await prisma.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "删除失败" },
      { status: 400 },
    );
  }
}
