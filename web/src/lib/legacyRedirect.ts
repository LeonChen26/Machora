/** 旧路径兼容：把 searchParams 原样拼成查询串（数组取首值，跳过 null/undefined） */
export function passThroughQuery(
  sp: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    params.set(k, Array.isArray(v) ? v[0] : v);
  }
  return params.toString();
}
