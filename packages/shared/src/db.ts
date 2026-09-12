import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "./drizzle/schema.ts";

type MachoraDb = BetterSQLite3Database<typeof schema>;

// 单例 Drizzle db（SQLite 嵌入式，standalone 模式下整个进程共享）。
//
// 缓存必须全环境生效（含 production）：better-sqlite3 是进程内句柄，
// 对同一个 .db 文件重复 new Database 会产生多个写句柄，并发写时触发
// SQLITE_BUSY；standalone/worker 与 Next.js web bundle 必须共用同一句柄。
declare global {
  // eslint-disable-next-line no-var
  var __machoraDrizzle: MachoraDb | undefined;
  // eslint-disable-next-line no-var
  var __machoraSqlite: Database.Database | undefined;
}

/** 数据库文件路径：DATA_DIR/machora.db（删除 DATA_DIR 即清空，与原 PGlite 语义一致） */
export function getDbPath(): string {
  const dir = resolve(process.cwd(), process.env.DATA_DIR ?? "./.machora-data");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "machora.db");
}

function createDb(): MachoraDb {
  const sqlite = new Database(getDbPath());

  // WAL：读写并发（读不阻塞写），对应原 PGlite relaxedDurability 的取舍
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  // 必须显式开启：否则 schema 中 8 个 ON DELETE CASCADE 会静默失效，
  // 删除 Project 后会残留孤儿 Trace/Observation/Score
  sqlite.pragma("foreign_keys = ON");
  // 并发写入排队等待而非立即抛 SQLITE_BUSY（批量写入场景）
  sqlite.pragma("busy_timeout = 5000");

  globalThis.__machoraSqlite = sqlite;
  return drizzle(sqlite, { schema });
}

/**
 * 惰性获取 db 单例。
 *
 * 必须惰性：模块加载时 env（DATA_DIR）可能尚未注入（standalone 的
 * setupEnvironment 之前 / 单元测试环境），此时打开文件会落到错误目录，
 * 甚至在只读或异常文件系统上直接抛错。语义对齐原 pg Pool 的"首次查询才建连"。
 */
function resolveDb(): MachoraDb {
  if (!globalThis.__machoraDrizzle) {
    globalThis.__machoraDrizzle = createDb();
  }
  return globalThis.__machoraDrizzle;
}

/**
 * 对外仍以 `db` 常量形式导出（保持全仓库约 200 处 `db.xxx` 调用不变），
 * 底层用 Proxy 转发到惰性初始化的真实实例。
 */
export const db: MachoraDb = new Proxy({} as MachoraDb, {
  get(_target, prop, receiver) {
    const real = resolveDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
  has(_target, prop) {
    return Reflect.has(resolveDb() as object, prop);
  },
  ownKeys() {
    return Reflect.ownKeys(resolveDb() as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(resolveDb() as object, prop);
  },
});

/** 底层 better-sqlite3 句柄类型（供 standalone 等消费方标注，避免重复依赖） */
export type SqliteHandle = Database.Database;

/** 底层 better-sqlite3 句柄：供 standalone 执行 schema.sql、PRAGMA 检查与优雅关闭 */
export function getSqliteHandle(): SqliteHandle {
  resolveDb();
  return globalThis.__machoraSqlite!;
}
