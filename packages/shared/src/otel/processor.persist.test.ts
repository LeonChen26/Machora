/**
 * persistOtelRecords 落库语义测试
 *
 * 覆盖 SQLite 迁移中改动过的两处行为：
 *   1. upsert 时 tags 为空数组不覆盖已落库的非空标签（与 userId 等 null 不覆盖策略一致）
 *   2. 整批写入包进单个事务后，"单条失败不中断整批"的语义仍需保持
 *
 * 用临时目录起真实 SQLite 文件，执行真实的 sql/schema.sql，不 mock。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { eq } from "drizzle-orm";

let tmp: string;
let db: typeof import("../db.ts")["db"];
let getSqliteHandle: typeof import("../db.ts")["getSqliteHandle"];
let s: typeof import("../drizzle/schema.ts");
let processor: typeof import("./processor.ts");

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "machora-proc-"));
  process.env.DATA_DIR = tmp;

  const dbMod = await import("../db.ts");
  db = dbMod.db;
  getSqliteHandle = dbMod.getSqliteHandle;
  s = await import("../drizzle/schema.ts");
  processor = await import("./processor.ts");

  getSqliteHandle().exec(
    readFileSync(resolve(import.meta.dirname, "..", "..", "sql", "schema.sql"), "utf8"),
  );
  await db.insert(s.project).values({ id: "p1", name: "P1" });
});

afterAll(() => {
  try {
    getSqliteHandle().close();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** 构造最小 TraceRecord */
const mkTrace = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "run",
  timestamp: new Date("2026-05-01T08:00:00.000Z"),
  environment: "default",
  userId: null,
  sessionId: null,
  agentName: null,
  workflowName: null,
  skillName: null,
  input: null,
  output: null,
  metadata: null,
  tags: [] as string[],
  ...over,
}) as Parameters<typeof processor.persistOtelRecords>[1][number];

describe("persistOtelRecords: tags 覆盖语义", () => {
  it("空 tags 不覆盖已落库的非空标签", async () => {
    // 首批带标签
    await processor.persistOtelRecords("p1", [mkTrace({ id: "tt1", tags: ["prod", "v1"] })], []);
    const first = await db.select().from(s.trace).where(eq(s.trace.id, "tt1"));
    expect(first[0].tags).toEqual(["prod", "v1"]);

    // 后续批次没带标签（解析层兜底为 []）
    await processor.persistOtelRecords("p1", [mkTrace({ id: "tt1", tags: [] })], []);
    const after = await db.select().from(s.trace).where(eq(s.trace.id, "tt1"));
    expect(after[0].tags).toEqual(["prod", "v1"]); // 未被洗成 []
  });

  it("非空 tags 正常覆盖（可追加/更新标签）", async () => {
    await processor.persistOtelRecords("p1", [mkTrace({ id: "tt2", tags: ["a"] })], []);
    await processor.persistOtelRecords("p1", [mkTrace({ id: "tt2", tags: ["a", "b"] })], []);
    const rows = await db.select().from(s.trace).where(eq(s.trace.id, "tt2"));
    expect(rows[0].tags).toEqual(["a", "b"]);
  });
});

describe("persistOtelRecords: 事务内单条失败不中断整批", () => {
  it("外键失败的 observation 被记录，其余行正常落库", async () => {
    const obs = (id: string, traceId: string) => ({
      id,
      traceId,
      projectId: "p1",
      type: "LLM",
      name: null,
      parentObservationId: null,
      startTime: new Date("2026-05-01T08:00:00.000Z"),
      endTime: null,
      model: null,
      agentName: null,
      workflowName: null,
      skillName: null,
      input: null,
      output: null,
      metadata: null,
      level: "DEFAULT",
      usage: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      totalCost: null,
    });

    await processor.persistOtelRecords("p1", [mkTrace({ id: "host" })], []);
    const res = await processor.persistOtelRecords(
      "p1",
      [],
      [
        obs("ok1", "host") as never,
        obs("bad", "NONEXISTENT-TRACE") as never, // 外键失败
        obs("ok2", "host") as never,
      ],
    );

    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].id).toBe("bad");

    const ids = (await db.select({ id: s.observation.id }).from(s.observation)).map((r) => r.id);
    expect(ids).toContain("ok1");
    expect(ids).toContain("ok2");
    expect(ids).not.toContain("bad");
  });
});
