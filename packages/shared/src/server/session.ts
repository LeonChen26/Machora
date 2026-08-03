// 无状态 session token：base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
// 用 Web Crypto（Node 20+ 全局可用），proxy / route handler / server component 通用。
// 不依赖外部包，重启不失效（secret 持久化见 web/src/server/session.ts）。
import { webcrypto } from "node:crypto";

export interface SessionPayload {
  /** user id */
  uid: string;
  /** 过期时间（unix 秒） */
  exp: number;
}

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

const encoder = new TextEncoder();

function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSha256(data: string, secret: string): Promise<Uint8Array> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

// Edge runtime 无 timingSafeEqual，用 XOR 累加实现常量时间比较
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSessionToken(
  payload: Omit<SessionPayload, "exp">,
  secret: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<string> {
  const data = b64urlEncode(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    }),
  );
  const sig = b64urlEncode(await hmacSha256(data, secret));
  return `${data}.${sig}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = await hmacSha256(data, secret);
    if (!timingSafeEqualBytes(b64urlDecode(sig), expected)) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(data)),
    ) as Partial<SessionPayload>;
    if (typeof payload.uid !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { uid: payload.uid, exp: payload.exp };
  } catch {
    return null;
  }
}
