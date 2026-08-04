import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./drizzle/schema.ts";

// 单例 Drizzle db（方案 C 迁移完成，Prisma 已移除），standalone 模式下整个进程共享。
// 注意：缓存必须全环境生效（含 production）——否则 standalone/worker 与 Next.js
// web bundle 各自 new 一个连接池，两个连接池叠加会顶满 PGLiteSocketServer 的
// maxConnections，冷启动时新连接被拒。
declare global {
  // eslint-disable-next-line no-var
  var __machoraDrizzle: NodePgDatabase<typeof schema> | undefined;
}

// 直接读 process.env.DATABASE_URL 而不走 getEnv() 校验：Pg Pool 构造是惰性的
// （首次 query 才建连），避免模块加载时因 env 未注入（standalone setupEnvironment
// 之前 / 测试环境）而抛错。
function createDb(): NodePgDatabase<typeof schema> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });
  return drizzle(pool, { schema });
}

export const db: NodePgDatabase<typeof schema> =
  globalThis.__machoraDrizzle ?? createDb();

globalThis.__machoraDrizzle = db;
