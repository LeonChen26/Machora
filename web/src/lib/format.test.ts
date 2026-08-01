import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatDateTime,
  formatRelative,
  shortId,
  prettyJson,
  durationMs,
  formatTokens,
  formatCost,
} from "../lib/format";

describe("formatDuration", () => {
  it("毫秒格式", () => {
    expect(formatDuration(480)).toBe("480ms");
    expect(formatDuration(0)).toBe("0.00ms");
  });
  it("秒格式", () => {
    expect(formatDuration(1250)).toBe("1.25s");
    expect(formatDuration(999)).toBe("999ms");
  });
  it("分秒格式", () => {
    expect(formatDuration(65000)).toBe("1m5s");
  });
  it("null/NaN 返回占位", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("本地时间格式化为 YYYY-MM-DD HH:mm:ss", () => {
    const d = new Date(2026, 7, 1, 8, 30, 5);
    expect(formatDateTime(d)).toBe("2026-08-01 08:30:05");
  });
  it("接受 ISO 字符串", () => {
    const iso = new Date(2026, 7, 1, 8, 30, 5).toISOString();
    expect(formatDateTime(iso)).toBe("2026-08-01 08:30:05");
  });
});

describe("formatRelative", () => {
  it("过去秒", () => {
    expect(formatRelative(new Date(Date.now() - 3000))).toMatch(/^\d+s ago$/);
  });
  it("过去分钟", () => {
    expect(formatRelative(new Date(Date.now() - 5 * 60 * 1000))).toMatch(/^\d+m ago$/);
  });
  it("未来", () => {
    expect(formatRelative(new Date(Date.now() + 5000))).toMatch(/^in \d+s$/);
  });
});

describe("durationMs", () => {
  it("计算起止差", () => {
    const s = new Date(2026, 7, 1, 8, 0, 0);
    const e = new Date(2026, 7, 1, 8, 0, 1);
    expect(durationMs(s, e)).toBe(1000);
  });
  it("无 end 返回 null", () => {
    expect(durationMs(new Date(), null)).toBeNull();
    expect(durationMs(new Date(), undefined)).toBeNull();
  });
});

describe("shortId", () => {
  it("短 id 原样返回", () => {
    expect(shortId("abc")).toBe("abc");
  });
  it("长 id 截断加省略号", () => {
    expect(shortId("abcdefghijklmn", 8)).toBe("abcdefgh…");
  });
});

describe("prettyJson", () => {
  it("格式化对象", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("null 返回空串", () => {
    expect(prettyJson(null)).toBe("");
  });
});

describe("formatTokens", () => {
  it("千分位缩写", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(1234567)).toBe("1.2M");
  });
  it("null/NaN 返回占位", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
  });
});

describe("formatCost", () => {
  it("小额成本保留 6 位小数", () => {
    expect(formatCost(0.0000525)).toBe("$0.000053");
  });
  it("常规金额保留 4 位小数", () => {
    expect(formatCost(0.123456)).toBe("$0.1235");
    expect(formatCost(1.5)).toBe("$1.5000");
  });
  it("零与极小额", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0000001)).toBe("<$0.000001");
  });
  it("null/NaN 返回占位", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
  });
});
