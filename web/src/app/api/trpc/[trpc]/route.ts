import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { db, project } from "@machora/shared";
import { appRouter, type Context } from "../../../../server/api/router";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // v1 不接登录：默认用第一个 project 作为上下文
    createContext: async (): Promise<Context> => {
      const found = await db.select({ id: project.id }).from(project).limit(1);
      return { projectId: found[0]?.id ?? null };
    },
  });

export { handler as GET, handler as POST };
