import { describe, it, expect } from "vitest";
import { scanBatches, type ScanCursor } from "./scan";

/** 用内存数据模拟 fetch(after, limit)：按 (ts, id) 升序返回游标之后的 limit 行 */
function makeFetch(all: { ts: Date; id: string }[]) {
  const calls: (ScanCursor | null)[] = [];
  const fetch = async (after: ScanCursor | null, limit: number) => {
    calls.push(after);
    const start = after
      ? all.findIndex(
          (r) => r.ts.getTime() === after.ts.getTime() && r.id === after.id,
        ) + 1
      : 0;
    return all.slice(start, start + limit);
  };
  return { fetch, calls };
}

const rows = Array.from({ length: 5 }, (_, i) => ({
  ts: new Date(i * 1000),
  id: `o${i}`,
}));
const cursorOf = (r: { ts: Date; id: string }): ScanCursor => ({
  ts: r.ts,
  id: r.id,
});

describe("scanBatches", () => {
  it("按批次产出全部行，并在批间推进游标", async () => {
    const { fetch, calls } = makeFetch(rows);
    const batches: string[][] = [];
    for await (const b of scanBatches(fetch, cursorOf, { batchSize: 2 })) {
      batches.push(b.map((r) => r.id));
    }
    expect(batches).toEqual([["o0", "o1"], ["o2", "o3"], ["o4"]]);
    // 首批无游标，其后每次带上一批最后一行的游标
    expect(calls.map((c) => c?.id ?? null)).toEqual([null, "o1", "o3"]);
  });

  it("批不满 batchSize 即结束（不额外多查一次）", async () => {
    const { fetch, calls } = makeFetch(rows);
    const sizes: number[] = [];
    for await (const b of scanBatches(fetch, cursorOf, { batchSize: 3 })) {
      sizes.push(b.length);
    }
    expect(sizes).toEqual([3, 2]);
    expect(calls).toHaveLength(2);
  });

  it("触及 maxRows 时截断并回调 onTruncate", async () => {
    const { fetch } = makeFetch(rows);
    const seen: string[] = [];
    let truncated = -1;
    for await (const b of scanBatches(fetch, cursorOf, {
      batchSize: 2,
      maxRows: 3,
      onTruncate: (n) => {
        truncated = n;
      },
    })) {
      for (const r of b) seen.push(r.id);
    }
    expect(seen).toEqual(["o0", "o1", "o2"]);
    expect(truncated).toBe(3);
  });

  it("数据恰好等于上限且无剩余时不误报截断", async () => {
    const { fetch } = makeFetch(rows.slice(0, 4));
    const seen: string[] = [];
    let truncated = false;
    for await (const b of scanBatches(fetch, cursorOf, {
      batchSize: 2,
      maxRows: 4,
      onTruncate: () => {
        truncated = true;
      },
    })) {
      for (const r of b) seen.push(r.id);
    }
    expect(seen).toEqual(["o0", "o1", "o2", "o3"]);
    expect(truncated).toBe(false);
  });

  it("恰好用尽上限后仍有剩余行时报告截断", async () => {
    const { fetch } = makeFetch(rows); // 5 行
    const seen: string[] = [];
    let truncated = -1;
    for await (const b of scanBatches(fetch, cursorOf, {
      batchSize: 2,
      maxRows: 4,
      onTruncate: (n) => {
        truncated = n;
      },
    })) {
      for (const r of b) seen.push(r.id);
    }
    expect(seen).toEqual(["o0", "o1", "o2", "o3"]); // 第 5 行被截断
    expect(truncated).toBe(4);
  });

  it("空结果直接结束", async () => {
    const { fetch, calls } = makeFetch([]);
    const sizes: number[] = [];
    for await (const b of scanBatches(fetch, cursorOf)) {
      sizes.push(b.length);
    }
    expect(sizes).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
