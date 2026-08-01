import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { prisma } from "@machora/shared";
import { appRouter, type Context } from "../../../../server/api/router";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // v1 不接登录：默认用第一个 project 作为上下文
    createContext: async (): Promise<Context> => {
      const project = await prisma.project.findFirst();
      return { projectId: project?.id ?? null };
    },
  });

export { handler as GET, handler as POST };
