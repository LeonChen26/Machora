import { redirect } from "next/navigation";
import { passThroughQuery } from "../../lib/legacyRedirect";

export const dynamic = "force-dynamic";

// 旧路径：Analytics 总览的「全局指标 + 趋势 + 延迟分布」已并入 Overview（/）。
// 其子页也已各自独立：拓扑 → /topology，Generations → /generations。
// 保留查询参数（days / metric）后重定向，兼容历史链接与书签。
export default async function LegacyAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const qs = passThroughQuery(await searchParams);
  redirect(`/${qs ? `?${qs}` : ""}`);
  return null;
}
