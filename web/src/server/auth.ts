// API Key 校验，参考 Langfuse 的 Basic Auth + bcrypt 模式
import bcrypt from "bcryptjs";
import { asc, eq } from "drizzle-orm";
import { apiKey, db, project } from "@machora/shared";

export interface AuthResult {
  projectId: string;
}

// 本地调试开关：MACHORA_AUTH_DISABLED=true 时跳过 Basic Auth 校验，
// 回退到默认项目（MACHORA_DEFAULT_PROJECT_ID 或最早创建的项目）
async function resolveDefaultProjectId(): Promise<string | null> {
  const fromEnv = process.env.MACHORA_DEFAULT_PROJECT_ID;
  if (fromEnv) return fromEnv;
  const first = await db
    .select({ id: project.id })
    .from(project)
    .orderBy(asc(project.createdAt))
    .limit(1);
  return first[0]?.id ?? null;
}

// 从 Authorization: Basic base64(publicKey:secretKey) 解析
export function parseBasicAuth(
  header: string | undefined,
): { publicKey: string; secretKey: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return {
      publicKey: decoded.slice(0, idx),
      secretKey: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

export async function verifyApiKey(
  header: string | undefined,
): Promise<AuthResult | null> {
  if (process.env.MACHORA_AUTH_DISABLED === "true") {
    const projectId = await resolveDefaultProjectId();
    return projectId ? { projectId } : null;
  }

  const creds = parseBasicAuth(header);
  if (!creds) return null;

  const found = await db
    .select({ hashedSecret: apiKey.hashedSecret, projectId: apiKey.projectId })
    .from(apiKey)
    .where(eq(apiKey.publicKey, creds.publicKey))
    .limit(1);
  const apiKeyRow = found[0];
  if (!apiKeyRow) return null;

  const ok = await bcrypt.compare(creds.secretKey, apiKeyRow.hashedSecret);
  if (!ok) return null;

  return { projectId: apiKeyRow.projectId };
}
