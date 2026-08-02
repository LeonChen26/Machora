import type { Metadata } from "next";
import { Link } from "../components/NativeLink";
import { getProjectContext } from "../server/project";
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
      <span aria-hidden style={{ width: 16, textAlign: "center" }}>
        {icon}
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

  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <img src="/icon.jpg" alt="Machora" className="logo-img" />
              <span className="name">Machora</span>
            </div>
            <ProjectSwitcher projects={projects} currentId={currentId} />
            <div className="nav-section">监控</div>
            <NavItem href="/" label="概览" icon="◉" />
            <NavItem href="/traces" label="Traces" icon="≡" />
            <NavItem href="/analytics" label="模型分析" icon="▦" />
            <NavItem href="/scores" label="Scores" icon="★" />
            <NavItem href="/sessions" label="Sessions" icon="◔" />
            <NavItem href="/users" label="Users" icon="◉" />
            <div className="nav-section">项目</div>
            <NavItem href="/projects" label="Projects" icon="▤" />
            <NavItem href="/api-keys" label="API Keys" icon="⚿" />
            <div className="nav-section">接入</div>
            <NavItem href="/docs" label="接入文档" icon="?" />
            <ThemeToggle />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
