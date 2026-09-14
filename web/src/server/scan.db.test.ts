/**
 * afterCursor（行值比较）+ scanBatches 对真实 SQLite 的 keyset 分页校验。
 * 重点覆盖「同一 startTime 有多行」时不漏不重——这正是 OR 形式容易退化的地方。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { db, getSqliteHandle, observation, trace } from "@machora/shared";
import { afterCursor, scanBatches, type ScanCursor } from "./scan";

let tmp: string;
const base = new Date("2026-05-01T08:00:00.000Z");

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "machora-scan-"));
  process.env.DATA_DIR = tmp;

  const schemaPath = resolve(
    import.meta.dirname,
    "../../../packages/shared/sql/schema.sql",
  );
  getSqliteHandle().exec(readFileSync(schemaPath, "utf8"));

  await db.insert(trace).values({ id: "T1", name: "t", timestamp: base, tags: [] });
  // 每 3 行共享同一 startTime，验证 (ts, id) 复合次序
  await db.insert(observation).values(
    Array.from({ length: 10 }, (_, i) => ({
      id: `o${String(i).padStart(2, "0")}`,
      traceId: "T1",
      type: "LLM",
      startTime: new Date(base.getTime() + Math.floor(i / 3) * 1000),
      level: "DEFAULT",
    })),
  );
});

afterAll(() => {
  try {
    getSqliteHandle().close();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("scanBatches + afterCursor（真实 SQLite）", () => {
  it("小批次翻页无漏无重（含同一时间戳多行）", async () => {
    const fetch = (after: ScanCursor | null, limit: number) => {
      const cur = afterCursor(observation.startTime, observation.id, after);
      return db
        .select({ id: observation.id, startTime: observation.startTime })
        .from(observation)
        .where(
          cur
            ? and(eq(observation.traceId, "T1"), cur)
            : eq(observation.traceId, "T1"),
        )
        .orderBy(asc(observation.startTime), asc(observation.id))
        .limit(limit);
    };

    const seen: string[] = [];
    let batches = 0;
    for await (const b of scanBatches(
      fetch,
      (r) => ({ ts: r.startTime, id: r.id }),
      { batchSize: 3 },
    )) {
      batches++;
      for (const r of b) seen.push(r.id);
    }

    expect(batches).toBe(4); // 3 + 3 + 3 + 1
    expect(seen).toEqual([
      "o00", "o01", "o02", "o03", "o04", "o05", "o06", "o07", "o08", "o09",
    ]);
    expect(new Set(seen).size).toBe(10); // 无重复
  });
});
