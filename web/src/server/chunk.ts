/** SQLite 单条语句绑定参数上限（旧版 999 / 新版 32766，取保守值）。 */
export const SQLITE_PARAM_CHUNK = 400;

/**
 * 把数组按固定大小切分，用于规避 SQLite `IN (...)` 绑定参数上限：
 * 窗口内命中的 traceId 规模不受控（热门对象可达数万），一次性展开会直接抛错。
 */
export function chunk<T>(arr: readonly T[], size = SQLITE_PARAM_CHUNK): T[][] {
  if (arr.length === 0) return [];
  if (size <= 0 || arr.length <= size) return [Array.from(arr)];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
