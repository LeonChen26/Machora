import { redirect } from "next/navigation";
import { passThroughQuery } from "../../../lib/legacyRedirect";

export const dynamic = "force-dynamic";

// 旧路径：Generations 已从 Analytics 子页提升为一级页面 /generations。
// 保留全部查询参数后重定向，兼容历史链接与书签。
export default async function LegacyGenerationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const qs = passThroughQuery(await searchParams);
  redirect(`/generations${qs ? `?${qs}` : ""}`);
  return null;
}
