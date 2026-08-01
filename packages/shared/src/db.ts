import { PrismaClient } from "@prisma/client";

// 单例 Prisma client，standalone 模式下整个进程共享。
// 注意：缓存必须全环境生效（含 production）——否则 standalone/worker 与 Next.js
// web bundle 各自 new 一个 PrismaClient，两个连接池叠加会顶满 PGLiteSocketServer
// 的 maxConnections，冷启动时新连接被拒（P1001 "Can't reach database server"）。
declare global {
  // eslint-disable-next-line no-var
  var __machoraPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__machoraPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

globalThis.__machoraPrisma = prisma;
