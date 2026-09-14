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
 * 转义 LIKE 模式中的特殊字符。
 *
 * 若用户输入里含 % / _（或转义符 \ 本身），不转义会被 SQLite 当作通配符：
 * 搜 "_" 会退化成 "匹配任意非空值"（命中整表），搜 "100%" 会放大命中范围。
 *
 * 统一用反斜杠作为转义符，并在 SQL 中显式声明 ESCAPE '\'。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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
  return sql`${col} LIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`;
}

/**
 * 标签包含判断（AND 语义：行的 tags 必须包含给定的全部标签）。
 * 对应原 Postgres 的 `tags @> ARRAY[...]` / drizzle arrayContains。
 *
 * SQLite 实现：tags 以 JSON 文本存储，用 json_each 展开后逐个判断存在性。
 *
 * 前置 json_valid 防护：json_each 遇到非法 JSON 文本会抛 "malformed JSON"
 * 并使**整个查询失败**（而非跳过该行）。写入路径虽都经 drizzle json 序列化，
 * 但手工改库 / 早期版本遗留的脏数据不应让列表页 500，故对每个条件加有效性判断，
 * 非法值直接判定为"不含该标签"。
 *
 * 性能说明：调用方（buildTraceWhere / public traces API）通常同时带上
 * timestamp 条件（有 Trace_timestamp_idx 索引），json_each 只在已收窄的结果集上执行，
 * 不至于退化为全表扫描。
 */
export function hasTags(col: AnyColumn, tags: string[]): SQL {
  // 空数组会生成 `WHERE ` 这样的非法 SQL（sql.join([]) 展开为空）；
  // 语义上「要求包含 0 个标签」恒真，直接返回恒真条件
  if (tags.length === 0) return sql`1 = 1`;
  const conds = tags.map(
    (t) =>
      sql`(${col} IS NOT NULL AND json_valid(${col}) AND EXISTS (SELECT 1 FROM json_each(${col}) je WHERE je.value = ${t}))`,
  );
  return sql.join(conds, sql` AND `);
}
