import { redirect } from "next/navigation";
import { passThroughQuery } from "../../../lib/legacyRedirect";

export const dynamic = "force-dynamic";

// 旧路径：Agent 拓扑已从 Analytics 子页提升到「资产」分组的 /topology。
// 保留全部查询参数后重定向，兼容历史链接与书签。
export default async function LegacyTopologyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const qs = passThroughQuery(await searchParams);
  redirect(`/topology${qs ? `?${qs}` : ""}`);
  return null;
}
