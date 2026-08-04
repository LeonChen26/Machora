import type { ReactNode } from "react";

// 统计卡：label + value + hint 三行式（统一各页手写卡片）
// 支持语义色（tone）、图标（icon）、左侧强调条（accent）、错误强调背景（alert）
const TONE_CLASS: Record<string, string> = {
  success: "text-success",
  danger: "text-danger",
  warn: "text-warn",
  accent: "text-accent",
};

// 统计卡图标集：stroke 风格（与侧边导航一致），14px 跟随 currentColor
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const STAT_ICONS: Record<string, ReactNode> = {
  list: (
    <Svg>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  boxes: (
    <Svg>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Svg>
  ),
  star: (
    <Svg>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.6 1-5.8-4.2-4.1 5.9-.9z" />
    </Svg>
  ),
  folder: (
    <Svg>
      <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </Svg>
  ),
  bolt: (
    <Svg>
      <path d="M13 2L4 14h6l-1 8 9-12h-6z" />
    </Svg>
  ),
  hash: (
    <Svg>
      <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" />
    </Svg>
  ),
  coin: (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10M9.5 9.3c0-1.2 1.2-1.8 2.5-1.8s2.5.6 2.5 1.8c0 1-.7 1.5-1.8 1.9l-1.4.5c-1.1.4-1.8.9-1.8 2 0 1.2 1.2 1.8 2.5 1.8s2.5-.6 2.5-1.8" />
    </Svg>
  ),
  alert: (
    <Svg>
      <path d="M12 3L2.5 20h19z" />
      <path d="M12 10v4.5M12 17.2v.1" />
    </Svg>
  ),
  clock: (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Svg>
  ),
  gauge: (
    <Svg>
      <path d="M4 14a8 8 0 0116 0" />
      <path d="M12 14l3.2-3" />
    </Svg>
  ),
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
            {STAT_ICONS[icon] ?? icon}
          </span>
        )}
        {label}
      </div>
      <div className={valueCls}>{value}</div>
      {hint != null && <div className="hint">{hint}</div>}
    </div>
  );
}
