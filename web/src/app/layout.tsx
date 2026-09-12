import type { Metadata } from "next";
import { NavItem } from "../components/NavItem";
import { ThemeToggle } from "../components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Machora",
  description: "简化版 LLM 可观测平台（standalone）",
};

// 首帧前应用主题（防闪烁）：读 localStorage，system 模式跟随系统并监听变化
const THEME_INIT_SCRIPT = `(function () {
  var KEY = "machora-theme";
  var mq = window.matchMedia("(prefers-color-scheme: light)");
  function current() { return localStorage.getItem(KEY) || "system"; }
  function apply() {
    var t = current();
    var light = t === "light" || (t === "system" && mq.matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
  }
  apply();
  mq.addEventListener("change", function () { if (current() === "system") apply(); });
  // Next.js RSC 导航协调 <html> 时会移除客户端脚本设置的 data-theme，
  // CSS 变量随之回退到 :root 暗色默认（页面局部变暗）；监听属性变化，
  // 被移除时立即重新应用（apply 重新赋值不再触发，无循环）。
  new MutationObserver(function () {
    if (!document.documentElement.dataset.theme) apply();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.__machoraTheme = {
    current: current,
    cycle: function () {
      var order = ["light", "dark", "system"];
      var next = order[(order.indexOf(current()) + 1) % order.length];
      localStorage.setItem(KEY, next);
      apply();
      return next;
    }
  };
})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <a href="#main-content" className="skip-link">跳到主内容</a>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <img src="/icon.jpg" alt="" className="logo-img" />
              <span className="name">Machora</span>
            </div>
            <div className="nav-section">观测</div>
            <NavItem href="/" label="Overview" icon="dashboard" />
            <NavItem href="/traces" label="Traces" icon="traces" />
            <NavItem href="/sessions" label="Sessions" icon="sessions" />
            <NavItem href="/agents" label="Agents" icon="agents" />
            <NavItem href="/models" label="Models" icon="cube" />
            <NavItem href="/analytics" label="Analytics" icon="analytics" />
            <div className="nav-section">质量</div>
            <NavItem href="/scores" label="Scores" icon="scores" />
            <NavItem href="/evaluations" label="Evaluations" icon="evaluations" />
            <div className="nav-section">平台</div>
            <NavItem href="/system" label="System" icon="system" />
            <NavItem href="/docs" label="Docs" icon="docs" />
            <div className="sidebar-footer">
              <ThemeToggle />
            </div>
          </aside>
          <main className="main" id="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
