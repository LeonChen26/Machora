import { describe, expect, it } from "vitest";
import {
  signSessionToken,
  verifySessionToken,
  SESSION_TTL_SECONDS,
} from "./session.ts";

const SECRET = "test-secret-0123456789abcdef";

describe("session token", () => {
  it("签名后能被正确验证并还原 payload", async () => {
    const token = await signSessionToken({ uid: "user-1" }, SECRET);
    const payload = await verifySessionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe("user-1");
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("篡改 token 任意部分都会被拒绝", async () => {
    const token = await signSessionToken({ uid: "user-1" }, SECRET);
    // 篡改 payload（翻转首字符保证 base64 内容真正变化）
    const dot = token.lastIndexOf(".");
    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const flip = data[0] === "A" ? "B" : "A";
    const tamperedPayload = flip + data.slice(1) + "." + sig;
    expect(await verifySessionToken(tamperedPayload, SECRET)).toBeNull();
    // 篡改签名（翻转首字符：base64 首字符必编码到第 0 字节，字节必然变化；
    // 末字符低 2 位超出 32 字节边界，翻转后可能解码出相同字节，不具确定性）
    const sigFlip = sig[0] === "A" ? "B" : "A";
    const tamperedSig = data + "." + sigFlip + sig.slice(1);
    expect(await verifySessionToken(tamperedSig, SECRET)).toBeNull();
  });

  it("错误 secret 无法验证", async () => {
    const token = await signSessionToken({ uid: "user-1" }, SECRET);
    expect(await verifySessionToken(token, "wrong-secret")).toBeNull();
  });

  it("过期 token 被拒绝", async () => {
    const token = await signSessionToken(
      { uid: "user-1" },
      SECRET,
      -10, // 已过期
    );
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("畸形 token 返回 null 而非抛错", async () => {
    expect(await verifySessionToken("", SECRET)).toBeNull();
    expect(await verifySessionToken("no-dot", SECRET)).toBeNull();
    expect(await verifySessionToken("..", SECRET)).toBeNull();
    expect(await verifySessionToken("a.b", SECRET)).toBeNull();
    expect(await verifySessionToken("!!!.###", SECRET)).toBeNull();
  });

  it("TTL 默认 7 天", () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
