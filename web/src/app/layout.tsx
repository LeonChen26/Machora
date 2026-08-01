import type { Metadata } from "next";
import Link from "next/link";
import { getProjectContext } from "../server/project";
import { ProjectSwitcher } from "../components/ProjectSwitcher";
import "./globals.css";

export const metadata: Metadata = {
  title: "Machora",
  description: "简化版 LLM 可观测平台（standalone）",
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
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <span className="logo">M</span>
              <span className="name">Machora</span>
            </div>
            <ProjectSwitcher projects={projects} currentId={currentId} />
            <div className="nav-section">监控</div>
            <NavItem href="/" label="概览" icon="◉" />
            <NavItem href="/traces" label="Traces" icon="≡" />
            <NavItem href="/analytics" label="模型分析" icon="▦" />
            <NavItem href="/scores" label="Scores" icon="★" />
            <NavItem href="/sessions" label="Sessions" icon="◔" />
            <div className="nav-section">项目</div>
            <NavItem href="/projects" label="Projects" icon="▤" />
            <NavItem href="/api-keys" label="API Keys" icon="⚿" />
            <div className="nav-section">接入</div>
            <NavItem href="/docs" label="接入文档" icon="?" />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
