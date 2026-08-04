// API Key 校验，参考 Langfuse 的 Basic Auth + bcrypt 模式
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { apiKey, db } from "@machora/shared";

export interface AuthResult {
  projectId: string;
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
