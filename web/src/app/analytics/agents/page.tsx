import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = [7, 14, 30];

// 旧下钻路由（/analytics/agents?name=...）：Agent 对象视角已收敛到
// /agents/[name]（含 Trace 数、成功率、版本演进、工具/模型、会话、评分），
// 此处仅保留重定向，兼容历史链接与书签。
export default async function LegacyAgentDrilldownPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const agent = (str(sp.name) ?? "").trim();
  if (!agent) redirect("/agents");

  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = DAY_OPTIONS.includes(rawDays) ? rawDays : 7;

  redirect(`/agents/${encodeURIComponent(agent)}?days=${days}`);

  return null;
}
