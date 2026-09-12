import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = [7, 14, 30];

// 旧下钻路由（/analytics/models?model=...）：Model 已提升为一等实体，
// 目录与详情收敛到 /models、/models/[name]（含调用量/Trace 数/成功率/Agent 分布/
// 调用明细/会话/评分）。此处仅保留重定向，兼容历史链接与书签。
export default async function LegacyModelDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const model = (str(sp.model) ?? "").trim();
  if (!model) redirect("/models");

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;

  redirect(`/models/${encodeURIComponent(model)}?days=${days}`);

  return null;
}
