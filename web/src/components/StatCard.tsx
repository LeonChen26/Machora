import type { ReactNode } from "react";

// 统计卡：label + value + hint 三行式（统一各页手写卡片）
// 支持语义色（tone）、图标（icon）、左侧强调条（accent）、错误强调背景（alert）
const TONE_CLASS: Record<string, string> = {
  success: "text-success",
  danger: "text-danger",
  warn: "text-warn",
  accent: "text-accent",
};

export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
  size = "lg",
  accent = false,
  alert = false,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "success" | "danger" | "warn" | "accent";
  icon?: string;
  size?: "lg" | "md" | "sm";
  accent?: boolean;
  alert?: boolean;
}) {
  const cardCls = ["card", accent ? "stat-accent" : "", alert ? "card-error" : ""]
    .filter(Boolean)
    .join(" ");
  const valueCls = [
    "value",
    size === "md" ? "value-md" : size === "sm" ? "value-sm" : "",
    tone ? TONE_CLASS[tone] : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cardCls}>
      <div className="label">
        {icon && (
          <span className="stat-icon" aria-hidden>
            {icon}
          </span>
        )}
        {label}
      </div>
      <div className={valueCls}>{value}</div>
      {hint != null && <div className="hint">{hint}</div>}
    </div>
  );
}
