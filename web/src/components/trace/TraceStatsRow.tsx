// Header 紧凑指标徽章行（参照 Langfuse TraceDetailViewHeader 思路）：
// 替代原 grid-4 统计卡，把 trace 级关键指标收敛为一行徽章，避免卡片堆叠。
// 纯展示组件，服务端/客户端均可渲染。

import { formatCost, formatDuration, formatTokens } from "../../lib/format";

type Tone = "success" | "danger" | "warn" | undefined;

export function TraceStatsRow({
  spanMs,
  obsCount,
  totalTokens,
  totalCost,
  costCount,
  errorCount,
  warningCount,
  avgScore,
  scoreCount,
}: {
  spanMs: number;
  obsCount: number;
  totalTokens: number;
  totalCost: number;
  costCount: number;
  errorCount: number;
  warningCount: number;
  avgScore: number | null;
  scoreCount: number;
}) {
  const chips: { label: string; value: string; hint: string; tone: Tone }[] = [
    {
      label: "耗时",
      value: formatDuration(spanMs),
      hint: "trace 时间跨度",
      tone: undefined,
    },
    {
      label: "Token",
      value: formatTokens(totalTokens),
      hint: `${obsCount} obs 合计`,
      tone: undefined,
    },
    ...(costCount > 0
      ? [
          {
            label: "成本",
            value: formatCost(totalCost),
            hint: `${costCount} 个 obs 含成本`,
            tone: "success" as Tone,
          },
        ]
      : []),
    {
      label: "异常",
      value: errorCount > 0 ? `${errorCount} ERROR` : "0 ERROR",
      hint: `${warningCount} WARNING`,
      tone: errorCount > 0 ? ("danger" as Tone) : undefined,
    },
    {
      label: "平均分",
      value: avgScore != null ? avgScore.toFixed(3) : "—",
      hint: `${scoreCount} 个 NUMERIC 评分`,
      tone:
        avgScore == null
          ? undefined
          : avgScore >= 0.8
            ? ("success" as Tone)
            : avgScore >= 0.5
              ? ("warn" as Tone)
              : ("danger" as Tone),
    },
  ];

  return (
    <div className="trace-stats">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`stat-chip${c.tone ? ` tone-${c.tone}` : ""}`}
          title={c.hint}
        >
          <span className="stat-chip-label">{c.label}</span>
          <span className="stat-chip-value">{c.value}</span>
        </span>
      ))}
    </div>
  );
}
