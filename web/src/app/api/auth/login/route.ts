import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, user, signSessionToken } from "@machora/shared";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  getSessionSecret,
} from "../../../../server/session";

const LoginBodySchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("邮箱格式不正确")
    .max(120),
  password: z.string().min(1, "请输入密码").max(200),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LoginBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 },
    );
  }
  const { email, password } = parsed.data;

  // 统一 401 文案，避免通过响应差异枚举已注册邮箱
  const fail = () =>
    NextResponse.json({ error: "邮箱或密码错误" }, { status: 401 });

  const userRow = await db.query.user.findFirst({ where: eq(user.email, email) });
  if (!userRow) return fail();

  const ok = await bcrypt.compare(password, userRow.passwordHash);
  if (!ok) return fail();

  const token = await signSessionToken({ uid: userRow.id }, getSessionSecret());
  const res = NextResponse.json({ ok: true, user: { email: userRow.email } });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // 公网部署为纯 HTTP，开启 secure 会导致浏览器拒绝发送 cookie，故固定 false
    secure: false,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
