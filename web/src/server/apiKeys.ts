// API Key 生成与管理辅助，参考 Langfuse 的 pk-/sk- 前缀格式
import { randomBytes } from "node:crypto";

export interface GeneratedKey {
  publicKey: string;
  secretKey: string;
}

/**
 * 生成一对 API Key：
 * - publicKey（pk-*）：随 ingestion 请求明文发送，用于识别 key
 * - secretKey（sk-*）：只在创建时返回一次，服务端仅存 bcrypt 哈希
 */
export function generateApiKey(): GeneratedKey {
  const publicKey = `pk-machora-${randomBytes(12).toString("base64url")}`;
  const secretKey = `sk-machora-${randomBytes(24).toString("base64url")}`;
  return { publicKey, secretKey };
}

/** publicKey → 显示用的短标识（如 pk-machora-****abcd），用于界面展示 */
export function maskPublicKey(publicKey: string, visible = 4): string {
  if (publicKey.length <= visible) return publicKey;
  return `${publicKey.slice(0, -visible)}****${publicKey.slice(-visible)}`;
}
