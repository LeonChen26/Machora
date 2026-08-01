import bcrypt from "bcryptjs";
import { prisma } from "../db.ts";

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

  const apiKey = await prisma.apiKey.findUnique({
    where: { publicKey },
    select: { projectId: true, hashedSecret: true },
  });
  if (!apiKey) return null;

  const ok = await bcrypt.compare(secretKey, apiKey.hashedSecret);
  if (!ok) return null;

  return { projectId: apiKey.projectId };
}
