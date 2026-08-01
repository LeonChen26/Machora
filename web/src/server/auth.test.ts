import { describe, it, expect } from "vitest";
import { parseBasicAuth } from "./auth";

const basic = (u: string, p: string) =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("parseBasicAuth", () => {
  it("解析 Basic header", () => {
    expect(parseBasicAuth(basic("pk-1", "sk-1"))).toEqual({
      publicKey: "pk-1",
      secretKey: "sk-1",
    });
  });

  it("publicKey 可含冒号，取第一个冒号分割", () => {
    expect(parseBasicAuth(basic("pk:extra", "sk"))).toEqual({
      publicKey: "pk",
      secretKey: "extra:sk",
    });
  });

  it("缺失 header 返回 null", () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth("")).toBeNull();
  });

  it("非 Basic 方案返回 null", () => {
    expect(parseBasicAuth("Bearer token123")).toBeNull();
  });

  it("非法 base64 返回 null", () => {
    expect(parseBasicAuth("Basic !!!")).toBeNull();
  });

  it("无冒号返回 null", () => {
    expect(parseBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeNull();
  });
});
