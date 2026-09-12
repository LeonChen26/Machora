"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Link } from "./NativeLink";

// 导航 SVG 图标（stroke 风格，跟随 nav-link 颜色）
const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
  ),
  traces: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>
  ),
  analytics: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
  ),
  cube: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>
  ),
  scores: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.6 1-5.8-4.2-4.1 5.9-.9z"/></svg>
  ),
  evaluations: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l4 4L20 6"/><path d="M12 20h8"/></svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="9.2" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M9.5 16.2h5"/></svg>
  ),
  metrics: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="20" x2="20" y2="20"/><polyline points="6,16 10,10 14,13 20,5"/></svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4a2 2 0 012-2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>
  ),
};

export function NavItem({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: string;
}) {
  const pathname = usePathname();
  // 首页精确匹配；其余命中自身或子路由（如 /traces/xxx → Traces）
  const active =
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      prefetch={false}
      className={`nav-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span aria-hidden style={{ width: 16, textAlign: "center", display: "inline-flex", justifyContent: "center" }}>
        {ICONS[icon]}
      </span>
      {label}
    </Link>
  );
}
