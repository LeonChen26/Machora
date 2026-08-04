import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { apiKey as apiKeyTable } from "../drizzle/schema.ts";

export interface ApiKeyAuth {
  projectId: string;
}

/**
 * 校验 Authorization: Basic base64(pk:sk)
 * 参考 Langfuse web/src/server/auth.ts
 */
export async function verifyApiKey(
  authorization: string | undefined,
): Promise<ApiKeyAuth | null> {
  if (!authorization?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf-8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  const publicKey = decoded.slice(0, sep);
  const secretKey = decoded.slice(sep + 1);
  if (!publicKey || !secretKey) return null;

  const found = await db
    .select({
      projectId: apiKeyTable.projectId,
      hashedSecret: apiKeyTable.hashedSecret,
    })
    .from(apiKeyTable)
    .where(eq(apiKeyTable.publicKey, publicKey))
    .limit(1);
  const apiKey = found[0];
  if (!apiKey) return null;

  const ok = await bcrypt.compare(secretKey, apiKey.hashedSecret);
  if (!ok) return null;

  return { projectId: apiKey.projectId };
}
