/**
 * 查询层不变量测试（SQLite 迁移安全网）
 *
 * 覆盖 PGlite → SQLite 切换中语义最易静默劣化的四类点：
 *   1. textSearch：大小写不敏感模糊匹配（替代 PG 的 ILIKE）
 *   2. hasTags：标签包含 AND 语义（替代 PG 的 tags @> ARRAY[...]）
 *   3. 外键级联删除（依赖 PRAGMA foreign_keys=ON）
 *   4. JSON 列与 timestamp_ms 往返、RQB 关系查询结构
 *
 * 用临时目录起真实 SQLite 文件，执行真实的 sql/schema.sql，不 mock。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

let tmp: string;
let db: typeof import("./db.ts")["db"];
let closeDb: () => void;
let s: typeof import("./drizzle/schema.ts");
let dialect: typeof import("./db-dialect.ts");

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "machora-test-"));
  process.env.DATA_DIR = tmp;

  const dbMod = await import("./db.ts");
  s = await import("./drizzle/schema.ts");
  dialect = await import("./db-dialect.ts");
  db = dbMod.db;
  closeDb = () => dbMod.getSqliteHandle().close();

  // 执行真实 DDL（同时验证 schema.sql 对 SQLite 合法）
  const sqlPath = resolve(import.meta.dirname, "..", "sql", "schema.sql");
  dbMod.getSqliteHandle().exec(readFileSync(sqlPath, "utf8"));

  const now = new Date("2026-05-01T08:00:00.000Z");
  await db.insert(s.trace).values([
    {
      id: "t1", name: "MyAgent Run", timestamp: now,
      userId: "Alice", tags: ["prod", "agent"],
      input: { messages: [{ role: "user", content: "你好，世界" }] },
    },
    { id: "t2", name: "other run", timestamp: now, tags: ["prod"] },
    { id: "t3", name: "third", timestamp: now, tags: [] },
    // t4：name 含字面量 '%'，用于验证 LIKE 通配符转义
    { id: "t4", name: "progress 50% done", timestamp: now, tags: [] },
  ]);
  await db.insert(s.observation).values([
    { id: "o1", traceId: "t1", type: "LLM", startTime: now, endTime: new Date(now.getTime() + 1200), model: "GPT-4o", totalCost: 0.0125, output: { text: "hi" } },
    { id: "o2", traceId: "t1", type: "TOOL", startTime: now },
  ]);
  await db.insert(s.score).values({ id: "sc1", traceId: "t1", name: "quality", value: 0.9, dataType: "NUMERIC", source: "API" });
});

afterAll(() => {
  // Windows 下必须先关闭 SQLite 句柄，否则临时目录被占用导致 EPERM
  try {
    closeDb();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("textSearch（替代 ILIKE）", () => {
  it("大小写不敏感命中（SQLite LIKE 默认 ASCII 不区分大小写）", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "myagent"));
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("原始大小写同样命中", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "MyAgent"));
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("子串匹配而非前缀匹配", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "run"));
    expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  });

  it("对 observation.model 生效", async () => {
    const rows = await db.select({ id: s.observation.id }).from(s.observation)
      .where(dialect.textSearch(s.observation.model, "gpt-4o"));
    expect(rows.map((r) => r.id)).toEqual(["o1"]);
  });

  it("无匹配返回空", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "nonexistent"));
    expect(rows).toEqual([]);
  });

  it("LIKE 通配符被转义：'_' 不再命中全表", async () => {
    // 修复前 "%%_%%" 会被 SQLite 当通配符，命中所有非空 name
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "_"));
    expect(rows).toEqual([]);
  });

  it("LIKE 通配符被转义：'%' 按字面量匹配", async () => {
    // 只有 t4 的 name 含字面量 '%'（"progress 50% done"）
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "%"));
    expect(rows.map((r) => r.id)).toEqual(["t4"]);
  });

  it("转义符自身可被搜索", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.textSearch(s.trace.name, "\\"));
    expect(rows).toEqual([]);
  });
});

describe("hasTags（替代 @> ARRAY）", () => {
  it("单标签过滤", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.hasTags(s.trace.tags, ["prod"]));
    expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
  });

  it("多标签为 AND 语义（必须全部包含）", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.hasTags(s.trace.tags, ["prod", "agent"]));
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("不存在的标签返回空", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.hasTags(s.trace.tags, ["nope"]));
    expect(rows).toEqual([]);
  });

  it("可与其他条件组合（userId + tag）", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(and(eq(s.trace.userId, "Alice"), dialect.hasTags(s.trace.tags, ["agent"])));
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
  });

  it("空 tags 行不被误命中", async () => {
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(dialect.hasTags(s.trace.tags, ["prod"]));
    expect(rows.map((r) => r.id)).not.toContain("t3");
  });

  it("非法 JSON 的脏数据不致错，且被判为不含标签", async () => {
    // 模拟手工改库 / 早期版本遗留的脏数据：tags 不是合法 JSON 数组。
    // 修复前 json_each 会抛 "malformed JSON" 使整个查询失败（列表页 500）；
    // 修复后应正常返回且不含该行。测后立即清理，避免污染其他用例。
    await db.run(sql`INSERT INTO trace (id, name, timestamp, tags) VALUES ('dirty1', 'dirty', 0, 'not-json')`);
    try {
      const rows = await db.select({ id: s.trace.id }).from(s.trace)
        .where(dialect.hasTags(s.trace.tags, ["prod"]));
      expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]);
      expect(rows.map((r) => r.id)).not.toContain("dirty1");
    } finally {
      await db.run(sql`DELETE FROM trace WHERE id = 'dirty1'`);
    }
  });

  it("空标签数组返回恒真条件（不生成非法 SQL）", async () => {
    // 修复前 sql.join([]) 会生成 `WHERE `，SQLite 报 "incomplete input"
    const rows = await db.select({ id: s.trace.id }).from(s.trace)
      .where(and(dialect.hasTags(s.trace.tags, [])));
    expect(rows.map((r) => r.id).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });
});

describe("列类型往返", () => {
  it("timestamp 读出为 Date 且保持毫秒精度", async () => {
    const row = await db.query.trace.findFirst({ where: eq(s.trace.id, "t1") });
    expect(row?.timestamp).toBeInstanceOf(Date);
    expect(row?.timestamp.toISOString()).toBe("2026-05-01T08:00:00.000Z");
  });

  it("JSON 列保持嵌套结构与中文", async () => {
    const row = await db.query.trace.findFirst({ where: eq(s.trace.id, "t1") });
    expect((row?.input as any).messages[0].content).toBe("你好，世界");
  });

  it("tags 读出为真数组", async () => {
    const row = await db.query.trace.findFirst({ where: eq(s.trace.id, "t1") });
    expect(Array.isArray(row?.tags)).toBe(true);
    expect(row?.tags).toEqual(["prod", "agent"]);
  });

  it("nullable 列返回 null 而非 undefined", async () => {
    const row = await db.query.observation.findFirst({ where: eq(s.observation.id, "o2") });
    expect(row?.endTime).toBeNull();
    expect(row?.totalCost).toBeNull();
  });

  it("real 列保持浮点精度", async () => {
    const row = await db.query.observation.findFirst({ where: eq(s.observation.id, "o1") });
    expect(row?.totalCost).toBeCloseTo(0.0125, 6);
  });

  it("createdAt 默认值生效", async () => {
    const row = await db.query.trace.findFirst({ where: eq(s.trace.id, "t1") });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - row!.createdAt.getTime())).toBeLessThan(60_000);
  });
});

describe("RQB 关系查询", () => {
  it("一对多 + 列裁剪", async () => {
    const rows = await db.query.trace.findMany({
      where: eq(s.trace.userId, "Alice"),
      with: { observations: { columns: { totalCost: true, startTime: true } } },
    });
    const t1 = rows.find((r) => r.id === "t1")!;
    expect(t1.observations).toHaveLength(2);
    expect(t1.observations[0].startTime).toBeInstanceOf(Date);
  });

  it("无关联行返回空数组", async () => {
    const rows = await db.query.trace.findMany({ with: { observations: true } });
    expect(rows.find((r) => r.id === "t3")!.observations).toEqual([]);
  });

  it("多关联同时加载", async () => {
    const row = await db.query.trace.findFirst({
      where: eq(s.trace.id, "t1"),
      with: { observations: true, scores: true },
    });
    expect(row?.observations).toHaveLength(2);
    expect(row?.scores).toHaveLength(1);
    expect((row?.observations.find((o) => o.id === "o1")?.output as any).text).toBe("hi");
  });
});

describe("精确匹配保持大小写敏感（与 Postgres 一致）", () => {
  it("eq() 对 userId 区分大小写", async () => {
    const hit = await db.select({ id: s.trace.id }).from(s.trace)
      .where(eq(s.trace.userId, "Alice"));
    const miss = await db.select({ id: s.trace.id }).from(s.trace)
      .where(eq(s.trace.userId, "alice"));
    expect(hit.map((r) => r.id)).toEqual(["t1"]);
    expect(miss).toEqual([]);
  });

  it("eq() 对 observation.model 区分大小写", async () => {
    const hit = await db.select({ id: s.observation.id }).from(s.observation)
      .where(eq(s.observation.model, "GPT-4o"));
    const miss = await db.select({ id: s.observation.id }).from(s.observation)
      .where(eq(s.observation.model, "gpt-4o"));
    expect(hit.map((r) => r.id)).toEqual(["o1"]);
    expect(miss).toEqual([]);
  });
});

describe("外键级联（PRAGMA foreign_keys=ON）", () => {
  it("删除 Trace 级联清除 Observation / Score", async () => {
    await db.delete(s.trace).where(eq(s.trace.id, "t1"));
    expect(await db.select().from(s.trace)).toHaveLength(3);
    expect(await db.select().from(s.observation)).toHaveLength(0);
    expect(await db.select().from(s.score)).toHaveLength(0);
  });
});
