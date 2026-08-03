import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../../server/session";

export async function POST(_req: NextRequest) {
  // 用请求的真实 Host 构建跳转，避免 Next 内部 URL 的 0.0.0.0 host
  const host = _req.headers.get("host") ?? "localhost:3100";
  const res = NextResponse.redirect(new URL("/login", `http://${host}`), 303);
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 0,
  });
  return res;
}
