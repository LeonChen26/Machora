import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma } from "@machora/shared";

// 简化 context：v1 不接 next-auth，所有请求视为已登录
export interface Context {
  projectId: string | null;
}

export const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

// 受保护过程：要求 projectId
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.projectId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "No project context" });
  }
  return next({ ctx: { ...ctx, projectId: ctx.projectId } });
});

export const appRouter = router({
  traces: router({
    list: protectedProcedure
      .input(
        z.object({
          from: z.string().datetime(),
          to: z.string().datetime(),
          cursor: z.string().nullable().optional(),
          limit: z.number().min(1).max(100).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const items = await prisma.trace.findMany({
          where: {
            projectId: ctx.projectId,
            timestamp: { gte: new Date(input.from), lte: new Date(input.to) },
          },
          orderBy: { timestamp: "desc" },
          take: input.limit + 1,
          ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
        });
        const nextCursor =
          items.length > input.limit ? items[items.length - 1].id : null;
        return { items: items.slice(0, input.limit), nextCursor };
      }),

    byId: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        const trace = await prisma.trace.findUnique({
          where: { id: input.id },
          include: { observations: true, scores: true },
        });
        if (!trace || trace.projectId !== ctx.projectId) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return trace;
      }),
  }),

  projects: router({
    list: publicProcedure.query(async () => {
      return prisma.project.findMany({ orderBy: { createdAt: "desc" } });
    }),
  }),
});

export type AppRouter = typeof appRouter;
