// Next 16 Proxy（原 middleware）：未登录时对受保护路由做粗粒度拦截（仅查 cookie 存在性）。
// 真正的签名验证在服务端页面 requireUser() / API getApiUser() 兜底，这里只是 UX 层前置拦截。
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "./server/session";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/",
  "/api/public/",
  "/api/health",
  "/_next/",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (request.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }

  // 未登录：公开路径与静态资源放行，其余（页面 + 内部 API）重定向到登录页
  if (
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    pathname === "/icon.jpg"
  ) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export default proxy;
