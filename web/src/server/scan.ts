// 批量扫描 + 事件循环让路原语
//
// 背景：存储引擎是 better-sqlite3（同步驱动）。一次「全量 select → 在 JS 里聚合」会
// 在整段扫描 + 循环期间独占事件循环；standalone 又是单进程同时承载 Next HTTP 与写入。
// 这里把大结果集拆成 keyset 批次，每批之间 await 一次让出事件循环，并设行数硬上限，
// 使单次请求的阻塞有界、可被其他请求穿插。
//
// 约定：调用方负责在 fetch 内把「游标条件 + ORDER BY (ts, id) 升序」落到 SQL，
// 本模块只负责分批、让路、截断保护。

import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** 单批行数：够大以摊薄查询开销，够小以限制单次同步阻塞时长 */
export const SCAN_BATCH_SIZE = 1000;
/** 单次扫描的硬上限：防异常大的时间窗把单进程拖死（超出即截断并回调） */
export const SCAN_MAX_ROWS = 200_000;

/** keyset 游标：按 (时间列, 主键) 升序翻页 */
export interface ScanCursor {
  ts: Date;
  id: string;
}

/** 让出事件循环（同步驱动下，长任务之间必须显式让路） */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * keyset 游标条件（升序）：`(ts, id) > (cur.ts, cur.id)`。
 *
 * 用行值比较而非 `ts > ? OR (ts = ? AND id > ?)`：SQLite 3.15+ 能对行值比较使用
 * (ts, id) 复合索引做范围扫描，OR 形式则往往退化成全表 + 排序。
 * after 为 null（首页）返回 undefined。
 */
export function afterCursor(
  tsCol: AnySQLiteColumn,
  idCol: AnySQLiteColumn,
  after: ScanCursor | null,
): SQL<unknown> | undefined {
  if (!after) return undefined;
  return sql`(${tsCol}, ${idCol}) > (${after.ts.getTime()}, ${after.id})`;
}

export interface ScanBatchesOptions {
  batchSize?: number;
  /** 行数上限，超出即停止并触发 onTruncate；传 Infinity 关闭 */
  maxRows?: number;
  onTruncate?: (rows: number) => void;
}

/**
 * 按批次产出结果。
 *
 * - 调用方 fetch(after, limit) 需返回按 (ts, id) 升序、带游标条件的前 limit 行；
 * - 每批之间 await 让出事件循环；批不满 limit 视为结束；
 * - 累计到 maxRows 即停止；仅当确实还有未读行时才回调 onTruncate
 *   （到界时多探一行区分「刚好用尽」与「被截断」，避免误报/漏报）。
 */
export async function* scanBatches<T>(
  fetch: (after: ScanCursor | null, limit: number) => Promise<T[]>,
  cursorOf: (row: T) => ScanCursor,
  opts: ScanBatchesOptions = {},
): AsyncGenerator<T[]> {
  const batchSize = opts.batchSize ?? SCAN_BATCH_SIZE;
  const maxRows = opts.maxRows ?? SCAN_MAX_ROWS;
  let after: ScanCursor | null = null;
  let scanned = 0;

  while (true) {
    const batch = await fetch(after, batchSize);
    if (batch.length === 0) return;

    const remaining = maxRows - scanned;
    if (batch.length >= remaining) {
      if (remaining > 0) yield batch.slice(0, remaining);
      const reached = scanned + Math.min(batch.length, remaining);
      const dropped = batch.length > remaining;
      const more =
        dropped ||
        (await fetch(cursorOf(batch[batch.length - 1]!), 1)).length > 0;
      if (more) opts.onTruncate?.(reached);
      return;
    }

    yield batch;
    scanned += batch.length;
    if (batch.length < batchSize) return;

    after = cursorOf(batch[batch.length - 1]!);
    await yieldToEventLoop();
  }
}
