import { describe, it, expect } from "vitest";
import { generateApiKey, maskPublicKey } from "./apiKeys";

describe("generateApiKey", () => {
  it("带 pk-machora- / sk-machora- 前缀", () => {
    const { publicKey, secretKey } = generateApiKey();
    expect(publicKey).toMatch(/^pk-machora-[A-Za-z0-9_-]+$/);
    expect(secretKey).toMatch(/^sk-machora-[A-Za-z0-9_-]+$/);
  });
  it("publicKey 与 secretKey 足够长", () => {
    const { publicKey, secretKey } = generateApiKey();
    expect(publicKey.length).toBeGreaterThan(20);
    expect(secretKey.length).toBeGreaterThan(30);
  });
  it("两次生成互不相同", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });
});

describe("maskPublicKey", () => {
  it("保留末尾几位", () => {
    const masked = maskPublicKey("pk-machora-abcdef123456");
    expect(masked.endsWith("3456")).toBe(true);
    expect(masked).toContain("****");
  });
  it("短 key 原样返回", () => {
    expect(maskPublicKey("abc", 4)).toBe("abc");
  });
});
