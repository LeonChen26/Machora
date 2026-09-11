/**
 * SQLite 表结构迁移工具
 *
 * 背景：SQLite 的 DDL 能力远弱于 Postgres ——
 *   - 不支持 ADD COLUMN IF NOT EXISTS（需先查 PRAGMA table_info）
 *   - 不支持 ADD CONSTRAINT，即 ADD COLUMN 无法附加 REFERENCES 外键
 *   - CREATE INDEX IF NOT EXISTS 只对「索引名」去重，**不校验被索引的列是否存在**；
 *     列缺失时整条语句直接抛 "no such column"，且已在同一 exec 中执行的
 *     CREATE TABLE 不会回滚 → 库处于半升级状态
 *
 * 因此：
 *   - 「带外键的列」只能走表重建：建新表 → 拷公共列 → 删旧表 → 改名 → 重建索引
 *   - schema.sql 需按语句拆分「容错」执行，跳过引用了尚不存在列的索引
 *
 * 本模块把这套操作收敛成可测试的纯函数，供 standalone 启动时的 schema 同步复用。
 */
import type { SqliteHandle } from "./db.ts";

export type SqliteDb = SqliteHandle;

/** 表列名列表（PRAGMA table_info） */
export function tableColumns(db: SqliteDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

/** 表上的索引名列表（PRAGMA index_list，排除 SQLite 自动创建的 sqlite_autoindex_*） */
export function tableIndexes(db: SqliteDb, table: string): string[] {
  return (db.prepare(`PRAGMA index_list("${table}")`).all() as { name: string }[])
    .map((i) => i.name)
    .filter((n) => !n.startsWith("sqlite_autoindex_"));
}

/**
 * 增量补列。**仅用于无外键的列** —— 带外键请用 ensureColumnWithFk。
 * 对应原 Postgres schema.sql 末尾的 ALTER TABLE ... ADD COLUMN IF NOT EXISTS。
 *
 * @returns 是否实际执行了补列（false = 列已存在，no-op）
 */
export function ensureColumn(db: SqliteDb, table: string, column: string, ddl: string): boolean {
  if (tableColumns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  return true;
}

export interface RebuildOptions {
  /** 目标表的完整 CREATE TABLE 语句（必须与 schema.sql 一致，含所有外键） */
  targetDdl: string;
  /** 重建后需要恢复的索引（DROP TABLE 会连同索引一起删除） */
  indexes?: { name: string; ddl: string }[];
}

/**
 * 通过表重建补齐一个**带外键**的列。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 无法附加 REFERENCES，故必须重建：
 *   建新表（用 targetDdl）→ 拷贝两版共有的列 → DROP 旧表 → RENAME 新表
 *
 * 注意事项：
 *   - 全程包在单事务里；出错回滚，不留半成品
 *   - foreign_keys 在事务外临时关闭（SQLite 要求 PRAGMA 不能在事务内切换），
 *     否则 DROP TABLE 会触发级联删除把关联数据清掉
 *   - 索引随 DROP TABLE 一起消失，必须按 indexes 重建，否则静默丢索引
 *
 * @returns 是否实际执行了重建（false = 列已存在，no-op）
 */
export function ensureColumnWithFk(
  db: SqliteDb,
  table: string,
  column: string,
  options: RebuildOptions,
): boolean {
  const oldCols = tableColumns(db, table);
  if (oldCols.includes(column)) return false;

  const { targetDdl, indexes = [] } = options;
  const tmpName = `${table}__rebuild`;
  const tmpDdl = targetDdl.replace(new RegExp(`"${table}"`), `"${tmpName}"`);

  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(tmpDdl);
    const newCols = tableColumns(db, tmpName);
    const common = newCols.filter((c) => oldCols.includes(c));
    if (common.length > 0) {
      // 逐列判断目标表是否 NOT NULL 且有默认值：旧数据可能在该列为 NULL
      // （旧版 DDL 较宽松），直接拷贝会触发 NOT NULL 约束失败。
      // 对这类列用 COALESCE(旧值, 默认值) 兜底，保证可重建。
      const notNullDefaults = new Map<string, string>();
      const info = db.prepare(`PRAGMA table_info("${tmpName}")`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      for (const c of info) {
        if (c.notnull === 1 && c.dflt_value != null) notNullDefaults.set(c.name, c.dflt_value);
      }

      const selectExprs = common.map((c) =>
        notNullDefaults.has(c) ? `COALESCE("${c}", ${notNullDefaults.get(c)})` : `"${c}"`,
      );
      const quoted = common.map((c) => `"${c}"`).join(", ");
      db.exec(
        `INSERT INTO "${tmpName}" (${quoted}) SELECT ${selectExprs.join(", ")} FROM "${table}"`,
      );
    }
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${tmpName}" RENAME TO "${table}"`);
    for (const idx of indexes) db.exec(idx.ddl);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已自动回滚 */
    }
    // 回滚后可能残留临时表；尽力清理，避免影响下次启动
    try {
      db.exec(`DROP TABLE IF EXISTS "${tmpName}"`);
    } catch {
      /* 忽略 */
    }
    throw e;
  } finally {
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON");
  }
  return true;
}

// ---------------------------------------------------------------------------
// schema.sql 容错执行
// ---------------------------------------------------------------------------

/**
 * 库中已存在的表名（排除 sqlite 内部表）。
 *
 * 行注释（双横线）与块注释都会被忽略，
 * 因此 schema.sql 里被注释掉的 DDL 不会被误判为「已存在」。
 */
export function tableNames(db: SqliteDb): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * 把多语句 SQL 拆成单条语句。
 *
 * 面向 schema.sql 这种「无存储过程、无触发器」的纯 DDL 文件，
 * 只需正确处理：单引号字符串（含成对引号转义）、双引号标识符、
 * 行注释、块注释，以及分号分隔。
 *
 * 之所以要拆分：better-sqlite3 的 `exec()` 在遇到报错时会中断，
 * 但在同一次调用中**已经执行过的语句不会回滚**（DDL 无隐式事务），
 * 于是「某条索引引用了旧库缺失的列」会让整个启动崩在
 * 「前面几条建表语句已生效、后面全部没跑」的中间态。
 * 逐条执行并跳过可预期的失败，才能让升级继续走下去。
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        buf += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (next === "'") {
          buf += next; // '' 转义
          i++;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"') {
        if (next === '"') {
          buf += next; // "" 转义
          i++;
        } else {
          inDouble = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
    } else if (ch === '"') {
      inDouble = true;
      buf += ch;
    } else if (ch === "-" && next === "-") {
      inLineComment = true;
      i++;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (ch === ";") {
      const s = buf.trim();
      if (s) statements.push(s);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * CREATE INDEX 语句中引用的表与列。
 * 用于在旧库缺列时提前判断该索引可跳过（避免依赖错误信息做脆弱的字符串匹配）。
 */
function parseIndexTarget(stmt: string): { table: string; columns: string[] } | null {
  const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\S+)\s+ON\s+("[^"]+"|\S+)\s*\(([\s\S]*)\)\s*$/i.exec(
    stmt,
  );
  if (!m) return null;
  const table = m[1].replace(/^"|"$/g, "");
  const columns = m[2]
    .split(",")
    .map((c) => c.trim())
    // 去掉排序方向 / 排序规则 / 表达式索引的部分
    .map((c) => /^"([^"]+)"/.exec(c)?.[1] ?? /^([A-Za-z_][\w$]*)/.exec(c)?.[1])
    .filter((c): c is string => Boolean(c));
  return { table, columns };
}

export interface ApplySchemaResult {
  /** 实际执行成功的语句数 */
  applied: number;
  /** 因「索引引用了尚不存在的列」而主动跳过的语句 */
  skipped: { statement: string; missing: string[] }[];
}

/**
 * 容错执行 schema.sql。
 *
 * 与直接 `db.exec(全文件)` 的区别：逐条执行，遇到
 * **引用了当前库中尚不存在列的 CREATE INDEX** 时跳过并记录，
 * 由调用方先跑补列/表重建（如 `ensureColumnWithFk`）补齐列，
 * 再重跑一次本函数把索引建回来，或干脆依赖补列后的重建逻辑恢复索引。
 *
 * 这样「旧版本建过库的用户」升级时不会因为一条索引语句就启动失败。
 */
export function applySchemaSql(db: SqliteDb, sql: string): ApplySchemaResult {
  const result: ApplySchemaResult = { applied: 0, skipped: [] };

  for (const stmt of splitSqlStatements(sql)) {
    const target = parseIndexTarget(stmt);
    if (target) {
      const existingTables = tableNames(db);
      if (existingTables.includes(target.table)) {
        const cols = tableColumns(db, target.table);
        const missing = target.columns.filter((c) => !cols.includes(c));
        if (missing.length > 0) {
          result.skipped.push({ statement: stmt, missing });
          continue;
        }
      }
    }
    db.exec(stmt);
    result.applied++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 旧版 schema 检测
// ---------------------------------------------------------------------------

export interface LegacySchemaIssue {
  /** 出问题的表 */
  table: string;
  /** 旧库中存在的列（旧命名） */
  legacyColumn: string;
  /** 新版代码期望的列（新命名） */
  expectedColumn: string;
}

/**
 * 检测无法安全自动迁移的「旧版 SQLite schema」。
 *
 * 已知的历史漂移：
 *   - `Trace` 的时间列由 `createdAt` 改名为 `timestamp`
 *
 * 为什么不能自动迁移：SQLite 没有「重命名列并保证语义一致」的安全路径 ——
 * 当旧列与新列语义并不完全等价时，盲目 `ALTER TABLE RENAME COLUMN` 会把
 * 错误的数据当成正确的用。而 `CREATE TABLE IF NOT EXISTS` 又不会改动旧表，
 * 于是库停留在旧结构上：进程能启动，但所有按新列名取数的查询都会抛
 * `no such column: timestamp`，「起得来、用不了」。
 *
 * 调用方应在执行任何 DDL **之前**调用本函数，命中则中止启动并给出人工指引。
 *
 * @returns 命中的问题列表；空数组表示结构兼容
 */
export function detectLegacySchema(db: SqliteDb): LegacySchemaIssue[] {
  const issues: LegacySchemaIssue[] = [];
  const known: { table: string; legacyColumn: string; expectedColumn: string }[] = [
    { table: "Trace", legacyColumn: "createdAt", expectedColumn: "timestamp" },
  ];

  const tables = new Set(tableNames(db));
  for (const k of known) {
    if (!tables.has(k.table)) continue; // 表不存在 = 全新库，会按新结构建
    const cols = tableColumns(db, k.table);
    // 新列已存在（或两列并存）= 结构兼容，不阻断
    if (cols.includes(k.expectedColumn)) continue;
    if (!cols.includes(k.legacyColumn)) continue;
    issues.push(k);
  }
  return issues;
}
