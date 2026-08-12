"use client";

import { useEffect, useState, type ReactNode } from "react";

// SVG stroke 图标（与侧边栏导航图标体系一致）
const ICONS: Record<string, ReactNode> = {
  light: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/></svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 14.5A8.5 8.5 0 019.5 3.5a8.5 8.5 0 1011 11z"/></svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="4.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 17.5V21"/></svg>
  ),
};
const LABELS: Record<string, string> = {
  light: "亮色",
  dark: "暗色",
  system: "跟随系统",
};

declare global {
  interface Window {
    __machoraTheme?: {
      current(): string;
      cycle(): string;
    };
  }
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<string>("system");

  useEffect(() => {
    setTheme(window.__machoraTheme?.current() ?? "system");
  }, []);

  const toggle = () => {
    const next = window.__machoraTheme?.cycle() ?? "system";
    setTheme(next);
  };

  return (
    <button
      type="button"
      className={`theme-toggle${compact ? " compact" : ""}`}
      onClick={toggle}
      title={`主题：${LABELS[theme]}（点击切换）`}
    >
      <span aria-hidden>{ICONS[theme]}</span>
      {!compact && <span className="muted">{LABELS[theme]}</span>}
    </button>
  );
}
