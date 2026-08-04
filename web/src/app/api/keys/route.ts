// API Key 管理 REST 路由（create/delete）
// 注：未使用 Server Actions —— 本项目 in-process 自定义服务器生产模式下
// Server Action 的 flight reply 解码会抛 "Connection closed"（环境级不兼容），
// REST 路由与 ingestion 同一链路，已验证可靠。
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { apiKey, db, project } from "@machora/shared";
import { generateApiKey } from "../../../server/apiKeys";
import { getApiUser } from "../../../server/session";

const CreateBodySchema = z.object({
  name: z.string().trim().max(60).optional().or(z.literal("")),
  projectId: z.string().min(1, "请选择项目"),
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

  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { name, projectId } = parsed.data;

  const projectRow = await db.query.project.findFirst({
    where: eq(project.id, projectId),
  });
  if (!projectRow) {
    return NextResponse.json({ error: "项目不存在" }, { status: 400 });
  }

  const { publicKey, secretKey } = generateApiKey();
  const hashedSecret = await bcrypt.hash(secretKey, 11);

  const [key] = await db
    .insert(apiKey)
    .values({
      projectId,
      publicKey,
      hashedSecret,
      name: name || null,
    })
    .returning();

  return NextResponse.json({
    key: { id: key.id, name: key.name, publicKey, secretKey },
  });
}

export async function DELETE(req: NextRequest) {
  if (!(await getApiUser())) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  }
  try {
    await db.delete(apiKey).where(eq(apiKey.id, id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "删除失败" },
      { status: 400 },
    );
  }
}
