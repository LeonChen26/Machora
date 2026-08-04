import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { db, project, trace } from "@machora/shared";

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
        const where = and(
          eq(trace.projectId, ctx.projectId),
          gte(trace.timestamp, new Date(input.from)),
          lte(trace.timestamp, new Date(input.to)),
          input.cursor ? lt(trace.id, input.cursor) : undefined,
        );
        const items = await db
          .select()
          .from(trace)
          .where(where)
          .orderBy(desc(trace.timestamp))
          .limit(input.limit + 1);
        const nextCursor =
          items.length > input.limit ? items[items.length - 1].id : null;
        return { items: items.slice(0, input.limit), nextCursor };
      }),

    byId: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        const traceRow = await db.query.trace.findFirst({
          where: eq(trace.id, input.id),
          with: { observations: true, scores: true },
        });
        if (!traceRow || traceRow.projectId !== ctx.projectId) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return traceRow;
      }),
  }),

  projects: router({
    list: publicProcedure.query(async () => {
      return db.query.project.findMany({
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
    }),
  }),
});

export type AppRouter = typeof appRouter;
