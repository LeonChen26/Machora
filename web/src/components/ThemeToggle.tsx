"use client";

import { useEffect, useState } from "react";

const ICONS: Record<string, string> = {
  light: "☀",
  dark: "🌙",
  system: "◇",
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

export function ThemeToggle() {
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
      className="theme-toggle"
      onClick={toggle}
      title={`主题：${LABELS[theme]}（点击切换）`}
    >
      <span aria-hidden>{ICONS[theme]}</span>
      <span className="muted">{LABELS[theme]}</span>
    </button>
  );
}
