import type { Metadata } from "next";
import { Link } from "../components/NativeLink";
import { getProjectContext } from "../server/project";
import { getSessionUser } from "../server/session";
import { ProjectSwitcher } from "../components/ProjectSwitcher";
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

// 导航 SVG 图标（stroke 风格，跟随 nav-link 颜色）
const ICONS: Record<string, React.ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>
  ),
  traces: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>
  ),
  generations: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 4.9L19 9.8l-5.1 1.9L12 17l-1.9-5.3L5 9.8l5.1-1.9z"/></svg>
  ),
  models: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
  ),
  scores: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.6 1-5.8-4.2-4.1 5.9-.9z"/></svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><path d="M16 5.5a3.5 3.5 0 010 6.6M17.5 15c2.3.6 3.7 2.2 4.2 5"/></svg>
  ),
  metrics: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="20" x2="20" y2="20"/><polyline points="6,16 10,10 14,13 20,5"/></svg>
  ),
  projects: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
  ),
  keys: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M15.5 7.5l3 3M13 10l2 2"/></svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4a2 2 0 012-2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>
  ),
};

function NavItem({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: string;
  active?: boolean;
}) {
  return (
    <Link href={href} prefetch={false} className={`nav-link${active ? " active" : ""}`}>
      <span aria-hidden style={{ width: 16, textAlign: "center", display: "inline-flex", justifyContent: "center" }}>
        {ICONS[icon]}
      </span>
      {label}
    </Link>
  );
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { projects, currentId } = await getProjectContext();
  const user = await getSessionUser();

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
            <ProjectSwitcher projects={projects} currentId={currentId} />
            <div className="nav-section">监控</div>
            <NavItem href="/" label="Overview" icon="dashboard" />
            <NavItem href="/traces" label="Traces" icon="traces" />
            <NavItem href="/generations" label="Generations" icon="generations" />
            <NavItem href="/analytics" label="Analytics" icon="models" />
            <NavItem href="/scores" label="Scores" icon="scores" />
            <NavItem href="/sessions" label="Sessions" icon="sessions" />
            <NavItem href="/users" label="Users" icon="users" />
            <NavItem href="/metrics" label="Metrics" icon="metrics" />
            <div className="nav-section">项目</div>
            <NavItem href="/projects" label="Projects" icon="projects" />
            <NavItem href="/api-keys" label="API Keys" icon="keys" />
            <div className="nav-section">接入</div>
            <NavItem href="/docs" label="Docs" icon="docs" />
            <div className="nav-section">系统</div>
            <NavItem href="/system" label="System" icon="system" />
            {user && (
              <div className="sidebar-user">
                <div className="user-meta">
                  <div className="user-name">{user.name ?? "Admin"}</div>
                  <div className="user-mail">{user.email}</div>
                </div>
                <form action="/api/auth/logout" method="post">
                  <button type="submit" className="logout-btn" aria-label="退出登录" title="退出登录">
                    ⏻
                  </button>
                </form>
              </div>
            )}
            <ThemeToggle />
          </aside>
          <main className="main" id="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}
