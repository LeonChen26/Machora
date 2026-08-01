// 项目上下文：当前选中的项目通过 cookie（machora_project）持久化。
// 服务端页面用 getCurrentProjectId() 过滤数据，layout 用 getProjectContext() 渲染切换器。
import { cookies } from "next/headers";
import { prisma } from "@machora/shared";
import { PROJECT_COOKIE } from "../lib/project";

// 返回当前选中（或回退到最早创建）的项目 id；无项目时返回空串
export async function getCurrentProjectId(): Promise<string> {
  const store = await cookies();
  const pid = store.get(PROJECT_COOKIE)?.value;
  if (pid) {
    const p = await prisma.project.findUnique({
      where: { id: pid },
      select: { id: true },
    });
    if (p) return p.id;
  }
  const first = await prisma.project.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return first?.id ?? "";
}

export interface ProjectContext {
  projects: { id: string; name: string }[];
  currentId: string;
  currentProject: { id: string; name: string } | null;
}

export async function getProjectContext(): Promise<ProjectContext> {
  const store = await cookies();
  const pid = store.get(PROJECT_COOKIE)?.value;

  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  let currentId = projects.find((p) => p.id === pid)?.id;
  if (!currentId && projects.length > 0) currentId = projects[0].id;

  return {
    projects,
    currentId: currentId ?? "",
    currentProject: projects.find((p) => p.id === currentId) ?? null,
  };
}
