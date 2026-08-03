// Web 侧 session 工具：secret 持久化 + cookie 读写 + 页面/API 鉴权。
// secret 优先级：环境变量 MACHORA_SESSION_SECRET > 持久化文件（.machora-data/session-secret）
// > 内存生成（仅 last resort）。生产（standalone）由 start.ts 启动时注入 env，保证跨进程一致。
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  verifySessionToken,
  type SessionPayload,
} from "@machora/shared";
import { prisma } from "@machora/shared";

export const SESSION_COOKIE = "machora_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 天（秒）

let cachedSecret: string | null = null;

function secretFilePath(): string {
  const dir = process.env.DATA_DIR || join(process.cwd(), ".machora-data");
  return join(dir, "session-secret");
}

export function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;

  const envSecret = process.env.MACHORA_SESSION_SECRET;
  if (envSecret) {
    cachedSecret = envSecret;
    return envSecret;
  }

  try {
    const file = secretFilePath();
    if (existsSync(file)) {
      const s = readFileSync(file, "utf8").trim();
      if (s.length >= 16) {
        cachedSecret = s;
        return s;
      }
    }
    const gen = randomBytes(32).toString("hex");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, gen, { mode: 0o600 });
    process.env.MACHORA_SESSION_SECRET = gen;
    cachedSecret = gen;
    return gen;
  } catch {
    // 极端兜底：纯内存随机（进程重启后所有 session 失效）
    const gen = randomBytes(32).toString("hex");
    cachedSecret = gen;
    return gen;
  }
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export async function getSessionPayload(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token, getSessionSecret());
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const payload = await getSessionPayload();
  if (!payload) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.uid },
    select: { id: true, email: true, name: true },
  });
  return user;
}

// 页面级保护：无有效 session 时重定向到登录页（返回 next 便于登录后跳回）
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

// API 级保护：无有效 session 时返回 null，route 自行决定 401
export async function getApiUser(): Promise<SessionUser | null> {
  return getSessionUser();
}
