/**
 * SQLite 表结构迁移工具测试
 *
 * 覆盖 ensureColumn / ensureColumnWithFk 的核心不变量：
 *   1. 补列幂等（已存在则 no-op）
 *   2. 表重建能补上**带外键**的列（ALTER TABLE ADD COLUMN 做不到）
 *   3. 重建过程数据不丢
 *   4. 重建后索引被恢复（DROP TABLE 会连带删除索引）
 *   5. 重建期间 foreign_keys 临时关闭再恢复，不误触发级联删除
 *   6. 重建失败时事务回滚、不留半成品
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureColumn, ensureColumnWithFk, tableColumns, tableIndexes } from "./sqlite-migrate.ts";
import { applySchemaSql, splitSqlStatements, tableNames } from "./sqlite-migrate.ts";
import { detectLegacySchema } from "./sqlite-migrate.ts";

let tmp: string;
let db: InstanceType<typeof Database>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "machora-migrate-"));
  db = new Database(join(tmp, "t.db"));
  db.pragma("foreign_keys = ON");
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** 造一个「旧版」schema：Evaluation 缺 datasetItemId，且无外键 */
function seedLegacy() {
  db.exec(`
    CREATE TABLE "Project" (id TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "DatasetItem" (id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "EvaluationConfig" (
      id TEXT NOT NULL PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
      evaluatorType TEXT NOT NULL, config TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE "Evaluation" (
      id TEXT NOT NULL PRIMARY KEY, projectId TEXT NOT NULL,
      traceId TEXT REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      name TEXT NOT NULL, evaluatorType TEXT NOT NULL, config TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING', error TEXT, result TEXT,
      createdAt INTEGER, updatedAt INTEGER NOT NULL
    );
    CREATE INDEX "Evaluation_projectId_createdAt_idx" ON "Evaluation"("projectId","createdAt");
    CREATE INDEX "Evaluation_traceId_idx" ON "Evaluation"("traceId");
    CREATE INDEX "Evaluation_status_idx" ON "Evaluation"("status");
    INSERT INTO "Project" (id) VALUES ('p1');
    INSERT INTO "DatasetItem" (id,name) VALUES ('d1','item1');
    INSERT INTO "Trace" (id) VALUES ('tr1');
    INSERT INTO "Evaluation" (id,projectId,traceId,name,evaluatorType,status,updatedAt)
      VALUES ('e1','p1','tr1','run1','llm','PENDING',1);
  `);
}

const EVALUATION_DDL = `CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "traceId" TEXT REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "datasetItemId" TEXT REFERENCES "DatasetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mode" TEXT NOT NULL DEFAULT 'EXPERIMENT',
    "error" TEXT,
    "result" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    "updatedAt" INTEGER NOT NULL
)`;

const EVALUATION_INDEXES = [
  {
    name: "Evaluation_projectId_createdAt_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_projectId_createdAt_idx" ON "Evaluation"("projectId", "createdAt")`,
  },
  {
    name: "Evaluation_traceId_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_traceId_idx" ON "Evaluation"("traceId")`,
  },
  {
    name: "Evaluation_status_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_status_idx" ON "Evaluation"("status")`,
  },
  {
    name: "Evaluation_datasetItemId_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_datasetItemId_idx" ON "Evaluation"("datasetItemId")`,
  },
];

describe("ensureColumn（无外键列的轻量补列）", () => {
  it("列不存在时补上，返回 true", () => {
    seedLegacy();
    expect(tableColumns(db, "EvaluationConfig")).not.toContain("autoRun");
    expect(ensureColumn(db, "EvaluationConfig", "autoRun", `"autoRun" INTEGER NOT NULL DEFAULT 0`)).toBe(true);
    expect(tableColumns(db, "EvaluationConfig")).toContain("autoRun");
  });

  it("列已存在时 no-op，返回 false（幂等）", () => {
    seedLegacy();
    ensureColumn(db, "EvaluationConfig", "autoRun", `"autoRun" INTEGER NOT NULL DEFAULT 0`);
    expect(ensureColumn(db, "EvaluationConfig", "autoRun", `"autoRun" INTEGER NOT NULL DEFAULT 0`)).toBe(false);
  });
});

describe("ensureColumnWithFk（表重建补带外键的列）", () => {
  it("补上带外键的列，且外键定义正确", () => {
    seedLegacy();
    const did = ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });
    expect(did).toBe(true);
    expect(tableColumns(db, "Evaluation")).toContain("datasetItemId");

    const fks = (db.prepare(`PRAGMA foreign_key_list("Evaluation")`).all() as {
      table: string;
      from: string;
    }[]).map((f) => `${f.table}.${f.from}`);
    expect(fks).toContain("DatasetItem.datasetItemId");
    expect(fks).toContain("Trace.traceId");
  });

  it("重建后删除 DatasetItem 能级联清除 Evaluation（修复的核心目标）", () => {
    seedLegacy();
    ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });

    db.exec(`INSERT INTO "Evaluation" (id,projectId,traceId,datasetItemId,name,evaluatorType,status,updatedAt)
             VALUES ('e2','p1','tr1','d1','run2','llm','PENDING',2)`);
    expect((db.prepare(`SELECT count(*) n FROM "Evaluation"`).get() as { n: number }).n).toBe(2);

    db.exec(`DELETE FROM "DatasetItem" WHERE id = 'd1'`);
    // 只有 e2 关联 d1，级联后应只剩 e1
    const left = db.prepare(`SELECT id FROM "Evaluation" ORDER BY id`).all() as { id: string }[];
    expect(left.map((r) => r.id)).toEqual(["e1"]);
  });

  it("重建过程数据不丢（公共列全部保留）", () => {
    seedLegacy();
    ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });
    const row = db.prepare(`SELECT * FROM "Evaluation" WHERE id = 'e1'`).get() as Record<string, unknown>;
    expect(row.projectId).toBe("p1");
    expect(row.traceId).toBe("tr1");
    expect(row.name).toBe("run1");
    expect(row.evaluatorType).toBe("llm");
    expect(row.datasetItemId).toBeNull();
  });

  it("重建后索引被恢复（不是只剩 autoindex）", () => {
    seedLegacy();
    ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });
    const idx = tableIndexes(db, "Evaluation");
    for (const name of EVALUATION_INDEXES.map((i) => i.name)) {
      expect(idx).toContain(name);
    }
  });

  it("列已存在时 no-op，返回 false（幂等）", () => {
    seedLegacy();
    ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });
    expect(
      ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
        targetDdl: EVALUATION_DDL,
        indexes: EVALUATION_INDEXES,
      }),
    ).toBe(false);
  });

  it("重建后 foreign_keys 恢复为 ON", () => {
    seedLegacy();
    ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("DDL 非法时抛错、回滚，且不残留临时表", () => {
    seedLegacy();
    expect(() =>
      ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
        targetDdl: `CREATE TABLE "Evaluation" (this is not valid sql`,
      }),
    ).toThrow();

    // 原表完好
    expect(tableColumns(db, "Evaluation")).toContain("name");
    expect((db.prepare(`SELECT count(*) n FROM "Evaluation"`).get() as { n: number }).n).toBe(1);
    // 无残留临时表
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[]).map((t) => t.name);
    expect(tables).not.toContain("Evaluation__rebuild");
    // foreign_keys 已恢复
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// schema.sql 容错执行
// ---------------------------------------------------------------------------

describe("splitSqlStatements", () => {
  it("按分号拆分，忽略行注释与块注释", () => {
    const stmts = splitSqlStatements(`
      -- 顶部说明
      CREATE TABLE "A" (id TEXT); -- 行尾注释
      /* 块注释
         跨多行 */
      CREATE TABLE "B" (id TEXT);
    `);
    expect(stmts).toEqual([`CREATE TABLE "A" (id TEXT)`, `CREATE TABLE "B" (id TEXT)`]);
  });

  it("分号出现在字符串字面量里不会被误拆", () => {
    const stmts = splitSqlStatements(`INSERT INTO "A" VALUES ('a;b'); SELECT 1;`);
    expect(stmts).toEqual([`INSERT INTO "A" VALUES ('a;b')`, `SELECT 1`]);
  });

  it("成对引号转义不会提前结束字符串", () => {
    const stmts = splitSqlStatements(`INSERT INTO "A" VALUES ('it''s; fine'); SELECT 2;`);
    expect(stmts.length).toBe(2);
    expect(stmts[0]).toContain("it''s; fine");
  });

  it("无尾分号的最后一条也会被收集", () => {
    expect(splitSqlStatements(`SELECT 1`)).toEqual(["SELECT 1"]);
  });
});

describe("applySchemaSql", () => {
  it("空库上跑完整 schema.sql：全部应用、无跳过", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, "..", "sql", "schema.sql"), "utf8");

    const r = applySchemaSql(db, sql);
    expect(r.skipped).toEqual([]);
    expect(r.applied).toBeGreaterThan(10);
    expect(tableNames(db)).toContain("Evaluation");
  });

  it("旧库缺列时跳过对应索引而不是抛错（关键回归）", () => {
    // 造一个「旧 SQLite 版本」的库：Trace 的时间列叫 createdAt，没有 timestamp
    db.exec(`
      CREATE TABLE "Project" (id TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "Trace" (
        id TEXT NOT NULL PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX "Trace_projectId_createdAt_idx" ON "Trace"("projectId","createdAt");
    `);

    // 这条索引引用了旧库不存在的 timestamp 列
    const sql = `CREATE INDEX IF NOT EXISTS "Trace_projectId_timestamp_idx" ON "Trace"("projectId", "timestamp");`;
    expect(() => db.exec(sql)).toThrow(/no such column/); // 直连 exec 会炸

    const r = applySchemaSql(db, sql);
    expect(r.applied).toBe(0);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0].missing).toEqual(["timestamp"]);
    // 库没被破坏
    expect(tableColumns(db, "Trace")).toContain("createdAt");
  });

  it("列补齐后重跑可把跳过的索引建回来", () => {
    db.exec(`CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY, projectId TEXT NOT NULL)`);
    const sql = `CREATE INDEX IF NOT EXISTS "Trace_projectId_timestamp_idx" ON "Trace"("projectId", "timestamp");`;

    expect(applySchemaSql(db, sql).skipped.length).toBe(1);

    db.exec(`ALTER TABLE "Trace" ADD COLUMN "timestamp" INTEGER NOT NULL DEFAULT 0`);
    const r2 = applySchemaSql(db, sql);
    expect(r2.skipped).toEqual([]);
    expect(r2.applied).toBe(1);
    expect(tableIndexes(db, "Trace")).toContain("Trace_projectId_timestamp_idx");
  });

  it("建表语句不受影响（表不存在时照常创建）", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS "NewT" (id TEXT NOT NULL PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS "NewT_id_idx" ON "NewT"("id");
    `;
    const r = applySchemaSql(db, sql);
    expect(r.skipped).toEqual([]);
    expect(r.applied).toBe(2);
  });

  it("部分索引 / 排序方向也能解析出被索引的列", () => {
    db.exec(`CREATE TABLE "T" (id TEXT NOT NULL PRIMARY KEY, a TEXT)`);
    const sql = `CREATE INDEX IF NOT EXISTS "T_partial_idx" ON "T" ("a" DESC)`;
    expect(applySchemaSql(db, sql).applied).toBe(1);
  });
});

describe("tableNames", () => {
  it("返回库中表名且不含 sqlite 内部表", () => {
    db.exec(`CREATE TABLE "Foo" (id TEXT PRIMARY KEY)`);
    const names = tableNames(db);
    expect(names).toContain("Foo");
    expect(names.some((n) => n.startsWith("sqlite_"))).toBe(false);
  });
});

describe("detectLegacySchema", () => {
  it("全新库（无 Trace 表）不报问题", () => {
    expect(detectLegacySchema(db)).toEqual([]);
  });

  it("旧库 Trace.createdAt 会被识别（新版需要 timestamp）", () => {
    db.exec(`CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY, projectId TEXT, createdAt INTEGER NOT NULL)`);
    const issues = detectLegacySchema(db);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({
      table: "Trace",
      legacyColumn: "createdAt",
      expectedColumn: "timestamp",
    });
  });

  it("新结构（timestamp）不报问题", () => {
    db.exec(`CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY, projectId TEXT, timestamp INTEGER NOT NULL)`);
    expect(detectLegacySchema(db)).toEqual([]);
  });

  it("两列并存时不阻断（视为已兼容）", () => {
    db.exec(
      `CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY, createdAt INTEGER, timestamp INTEGER NOT NULL)`,
    );
    expect(detectLegacySchema(db)).toEqual([]);
  });

  it("既无 createdAt 也无 timestamp 时不误报", () => {
    db.exec(`CREATE TABLE "Trace" (id TEXT NOT NULL PRIMARY KEY, projectId TEXT)`);
    expect(detectLegacySchema(db)).toEqual([]);
  });
});
