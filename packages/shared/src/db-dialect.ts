/**
 * SQL 方言隔离层
 *
 * 目的：把数据库方言相关的表达式收敛到单一模块，使底层引擎切换（Postgres ↔ SQLite）
 * 只需改动本文件，而非散落在查询层的数十个调用点。
 *
 * 约定：查询层一律通过 textSearch / hasTags 构造条件，禁止直接 import
 * drizzle-orm 的 ilike / arrayContains 或手写方言 SQL 片段。
 */

import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/**
 * 大小写不敏感的模糊匹配（对应原 Postgres 的 ILIKE '%q%'）。
 *
 * SQLite 实现：内置 LIKE 对 ASCII 默认即大小写不敏感
 * （PRAGMA case_sensitive_like 默认 OFF），无需列级 COLLATE NOCASE。
 *
 * 刻意不给列加 COLLATE NOCASE：那会连带把 = 精确匹配也变成大小写不敏感，
 * 而 userId / sessionId / model 等身份字段的 eq() 查询依赖精确语义（与 PG 一致）。
 * 局限：SQLite 的 LIKE 仅对 ASCII 大小写不敏感；中文无大小写概念，不受影响。
 */
export function textSearch(col: AnyColumn, q: string): SQL {
  return sql`${col} LIKE ${`%${q}%`}`;
}

/**
 * 标签包含判断（AND 语义：行的 tags 必须包含给定的全部标签）。
 * 对应原 Postgres 的 `tags @> ARRAY[...]` / drizzle arrayContains。
 *
 * SQLite 实现：tags 以 JSON 文本存储，用 json_each 展开后逐个判断存在性。
 * 性能说明：调用方（buildTraceWhere / public traces API）始终同时带上
 * projectId + timestamp 条件，这两列有复合索引 Trace_projectId_timestamp_idx，
 * json_each 只在已收窄的结果集上执行，不会退化为全表扫描。
 */
export function hasTags(col: AnyColumn, tags: string[]): SQL {
  const conds = tags.map(
    (t) => sql`EXISTS (SELECT 1 FROM json_each(${col}) je WHERE je.value = ${t})`,
  );
  return sql.join(conds, sql` AND `);
}
