import { describe, it, expect } from "vitest";
import { AGENT_UNKNOWN, resolveAgentName } from "./attribution";
import { chunk } from "./chunk";
import {
  cursorCond,
  decodeCursor,
  encodeCursor,
  nextCursorOf,
  omitCursorFields,
  withCursorFields,
} from "./publicQuery";
import { parseDays } from "./traceQuery";

describe("resolveAgentName", () => {
  it("trace 级优先（与 SQL COALESCE 口径一致）", () => {
    expect(resolveAgentName("trace-agent", "obs-agent")).toBe("trace-agent");
  });

  it("trace 为空时回落到 observation", () => {
    expect(resolveAgentName(null, "obs-agent")).toBe("obs-agent");
    expect(resolveAgentName(undefined, "obs-agent")).toBe("obs-agent");
  });

  it("两者皆空归 unknown", () => {
    expect(resolveAgentName(null, null)).toBe(AGENT_UNKNOWN);
  });
});

describe("chunk", () => {
  it("空数组返回空（不产生一次无谓的 IN () 查询）", () => {
    expect(chunk([])).toEqual([]);
  });

  it("不超过块大小时单块返回", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("超过块大小时按块切分", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("keyset 游标", () => {
  const ts = new Date("2026-01-02T03:04:05.678Z");

  it("编码后可还原 (timestamp, id)", () => {
    const decoded = decodeCursor(encodeCursor(ts, "abc-123"));
    expect(decoded).toEqual({ ts: ts.getTime(), id: "abc-123" });
  });

  it("非法游标返回 null / 不产生条件", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(cursorCond(undefined as never, undefined as never, undefined)).toBeUndefined();
    expect(cursorCond(undefined as never, undefined as never, "!!!!")).toBeUndefined();
  });

  it("nextCursorOf 取当前页最后一条（不是多取的 lookahead 行）", () => {
    const items = [
      { id: "a", timestamp: new Date(1000) },
      { id: "b", timestamp: new Date(900) },
      { id: "c", timestamp: new Date(800) },
    ];
    // limit=2：多取了一条 c，游标应指向页内最后一条 b
    expect(nextCursorOf(items, 2, "timestamp", "id")).toBe(
      encodeCursor(new Date(900), "b"),
    );
    // 无多余行 → 无下一页
    expect(nextCursorOf(items.slice(0, 2), 2, "timestamp", "id")).toBeNull();
  });

  it("select 子集时补上游标列、返回前再裁掉", () => {
    const requested = ["name"];
    const withCursor = withCursorFields(requested, ["id", "timestamp"]);
    expect(withCursor).toEqual(["name", "id", "timestamp"]);
    expect(
      omitCursorFields(
        { name: "t", id: "x", timestamp: new Date(0) },
        requested,
        ["id", "timestamp"],
      ),
    ).toEqual({ name: "t" });
    // 未使用 select（全字段）时原样返回
    expect(withCursorFields(undefined, ["id"])).toBeUndefined();
  });
});

describe("parseDays", () => {
  it("合法值原样返回，0 表示不限", () => {
    expect(parseDays("7", 7)).toBe(7);
    expect(parseDays("0", 7)).toBe(0);
  });

  it("空 / 非法 / 负数回退默认（避免 NaN → 全表扫描）", () => {
    expect(parseDays(undefined, 7)).toBe(7);
    expect(parseDays("abc", 7)).toBe(7);
    expect(parseDays("-3", 7)).toBe(7);
  });

  it("超大值被钳制", () => {
    expect(parseDays("100000", 7)).toBe(365);
  });
});
