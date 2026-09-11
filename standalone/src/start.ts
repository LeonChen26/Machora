/**
 * Machora Standalone 启动入口
 *
 * 单进程承载：SQLite（嵌入式）+ Next.js + worker 队列处理器
 * 参考 Langfuse worker/src/standalone/start.ts，去掉 chDB/S3/Redis
 *
 * 关键不变量：Next.js 必须同进程启动，与 worker 共享 queueBus 单例
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
// 仅类型导入：编译期擦除，不会在 setupEnvironment() 之前触发 shared 的模块副作用
import type { SqliteHandle } from "@machora/shared";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 模块加载即读 .env（函数声明提升，可提前调用）：确保下方 DATA_DIR/
// PORT 计算及后续 setupEnvironment 都能拿到 .env 中的值。
loadDotEnv();

const DATA_DIR = process.env.DATA_DIR ?? "./.machora-data";
const WEB_PORT = parseInt(process.env.PORT ?? "3100", 10);
// 非法端口值尽早失败（parseInt("abc") → NaN，避免运行时才暴露）
if (!Number.isInteger(WEB_PORT)) {
  throw new Error(
    `[env] PORT 必须为整数端口（当前 PORT=${process.env.PORT ?? "3100"}）`,
  );
}

// ---------------------------------------------------------------------------
// 环境变量注入
// ---------------------------------------------------------------------------

// 从应用根目录（cwd）读取 .env 文件。手写轻量解析：KEY=VALUE、# 注释、
// 单双引号、空行忽略；已存在的进程环境变量优先，不覆盖。
function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  console.log(`[env] 已加载 ${envPath}`);
}

function setupEnvironment(): void {
  // 打包后的发布环境（.next 存在且有 server/static 目录）默认走 production，
  // 避免 Turbopack dev 模式跨目录推断 workspace root。用户显式设置
  // NODE_ENV=development 时仍可走开发模式。
  const envDefaultsNodeEnv =
    process.env.NODE_ENV ??
    (existsSync(resolve(import.meta.dirname, "..", "..", "web", ".next", "server")) &&
    existsSync(resolve(import.meta.dirname, "..", "..", "web", ".next", "static"))
      ? "production"
      : "development");
  const isProd = envDefaultsNodeEnv === "production";

  // 生产安全策略：
  // - NEXTAUTH_SECRET 未配置时随机生成（重启后登录会话失效，安全优先），不落盘；
  // - 项目 API Key 不注入公开的 dev 种子值：未配置时 seed 跳过创建（见 seedStandaloneData），
  //   避免生产环境沿用公开已知密钥。
  if (isProd && process.env.NEXTAUTH_SECRET === undefined) {
    process.env.NEXTAUTH_SECRET = randomBytes(32).toString("hex");
    console.warn(
      "[env] 生产环境未配置 NEXTAUTH_SECRET，已随机生成（重启后登录会话失效，建议在 .env 固定）",
    );
  }

  const defaults: Record<string, string> = {
    NEXTAUTH_URL: `http://localhost:${WEB_PORT}`,
    NEXTAUTH_SECRET: "machora-standalone-dev-secret-do-not-use-in-production",
    PORT: String(WEB_PORT),
    NODE_ENV: envDefaultsNodeEnv,
    // seed 凭据（MACHORA_INIT_USER_PASSWORD 不设默认值：优先读 .env，
    // 未配置时 seed 随机生成，见 seedStandaloneData）
    MACHORA_INIT_PROJECT_NAME: "Machora Project",
    MACHORA_INIT_USER_EMAIL: "admin@machora.local",
    MACHORA_INIT_USER_NAME: "Admin",
  };
  // dev 模式注入公开的种子 API Key（本地开发便捷）；生产模式必须由 .env 显式配置
  if (!isProd) {
    defaults.MACHORA_INIT_PROJECT_PUBLIC_KEY = "pk-machora-dev-000000000000000000000";
    defaults.MACHORA_INIT_PROJECT_SECRET_KEY = "sk-machora-dev-000000000000000000000";
  }

  for (const [k, v] of Object.entries(defaults)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Schema 同步
//
// 表结构真源是 packages/shared/sql/schema.sql（幂等：IF NOT EXISTS），
// 数据访问走 drizzle-orm + better-sqlite3（嵌入式，无 TCP、无连接池）。
// better-sqlite3 的 exec() 原生支持多语句，整文件直接执行即可。
// ---------------------------------------------------------------------------

type SqliteDb = SqliteHandle;

/**
 * 增量补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 PRAGMA table_info 判断）。
 * 对应原 Postgres schema.sql 末尾的 ALTER TABLE ... ADD COLUMN IF NOT EXISTS。
 */
function ensureColumn(db: SqliteDb, table: string, column: string, ddl: string): void {
  const exists = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
    .some((c) => c.name === column);
  if (exists) return;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`[Schema] 补列 ${table}.${column}`);
}

function applySchemaSql(db: SqliteDb): void {
  const root = resolve(import.meta.dirname, "..", "..");
  const sqlPath = resolve(root, "packages", "shared", "sql", "schema.sql");
  if (!existsSync(sqlPath)) {
    // 本地开发模式（pnpm dev / start）未走 release 流程，schema.sql 不一定存在
    console.warn("[Schema] 未找到 schema.sql，跳过 SQL 同步（开发模式可忽略）");
    return;
  }

  console.log("[Schema] 执行 schema.sql 幂等建表...");
  db.exec(readFileSync(sqlPath, "utf8"));

  // 存量库补列（新建库时这些列已在 CREATE TABLE 中，此处为 no-op）
  ensureColumn(db, "EvaluationConfig", "autoRun", `"autoRun" INTEGER NOT NULL DEFAULT 0`);
  ensureColumn(db, "Evaluation", "mode", `"mode" TEXT NOT NULL DEFAULT 'EXPERIMENT'`);
  ensureColumn(db, "Evaluation", "datasetItemId", `"datasetItemId" TEXT`);

  console.log("[Schema] 完成");
}

// ---------------------------------------------------------------------------
// Seed 默认数据
// ---------------------------------------------------------------------------

// 生成随机强密码（字母+数字，避免 shell/env 转义问题）
function generateRandomPassword(length = 16): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function seedStandaloneData(): Promise<void> {
  const bcryptjs = (await import("bcryptjs")).default;
  const { eq } = await import("drizzle-orm");
  const {
    db,
    project: projectTable,
    apiKey: apiKeyTable,
    user: userTable,
  } = await import("@machora/shared");

  const projectName = process.env.MACHORA_INIT_PROJECT_NAME!;
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY;
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY;
  const email = process.env.MACHORA_INIT_USER_EMAIL!;
  const userName = process.env.MACHORA_INIT_USER_NAME!;
  const password = process.env.MACHORA_INIT_USER_PASSWORD;

  // 1. Project
  await db
    .insert(projectTable)
    .values({ id: "project-standalone", name: projectName })
    .onConflictDoUpdate({
      target: projectTable.id,
      set: { name: projectName },
    });
  console.log("[Seed] Project: project-standalone");

  // 2. API Key（仅当显式配置了 key 时创建；未配置时跳过，避免生产沿用公开的 dev 种子值）
  if (publicKey && secretKey) {
    const existing = await db.query.apiKey.findFirst({
      where: eq(apiKeyTable.publicKey, publicKey),
    });
    if (!existing) {
      const hashedSecret = await bcryptjs.hash(secretKey, 11);
      await db.insert(apiKeyTable).values({
        projectId: "project-standalone",
        publicKey,
        hashedSecret,
      });
      console.log("[Seed] API Key 已创建");
    } else {
      console.log("[Seed] API Key 已存在");
    }
  } else {
    console.warn(
      "[Seed] 未配置 MACHORA_INIT_PROJECT_PUBLIC_KEY / MACHORA_INIT_PROJECT_SECRET_KEY，跳过 API Key 创建（生产环境请在 .env 显式配置）",
    );
  }

  // 3. User
  // - 配置了 MACHORA_INIT_USER_PASSWORD：upsert 同步密码（部署后凭据与配置一致）
  // - 未配置：仅首次创建时生成随机密码并打印（已存在用户保持原密码不变）
  const effectivePassword =
    password ?? generateRandomPassword(16);
  const passwordHash = await bcryptjs.hash(effectivePassword, 12);
  // drizzle findFirst 无匹配返回 undefined（Prisma 返回 null），必须用 == null 判断
  const isNewUser =
    (await db.query.user.findFirst({
      where: eq(userTable.email, email),
    })) == null;
  await db
    .insert(userTable)
    .values({ email, passwordHash, name: userName })
    .onConflictDoUpdate({
      target: userTable.email,
      set: password
        ? { passwordHash, name: userName }
        : { name: userName },
    });
  console.log("[Seed] User 已就绪:", email);
  if (password) {
    console.log("[Seed] 管理员密码来自 MACHORA_INIT_USER_PASSWORD（.env）");
  } else if (isNewUser) {
    console.warn(
      `[Seed] 未配置 MACHORA_INIT_USER_PASSWORD，已生成随机管理员密码（仅本次打印，请立即保存并在 .env 中固定）：\n      ${effectivePassword}`,
    );
  } else {
    console.warn(
      "[Seed] 未配置 MACHORA_INIT_USER_PASSWORD，已存在用户保留原密码；建议在 .env 中设置以固定凭据",
    );
  }

  console.log("[Seed] 完成");
}

// ---------------------------------------------------------------------------
// 队列处理器注册（同进程，共享 queueBus 单例）
// ---------------------------------------------------------------------------

async function registerQueueProcessors(): Promise<void> {
  // 动态 import @machora/worker（编译产物 dist/app.js），注册 ingestion 消费者；
  // 编译产物与开发（tsx）均解析到同一入口
  const { registerQueueProcessors } = await import("@machora/worker");
  registerQueueProcessors();
  console.log("[Queue] 处理器已注册");
}

// ---------------------------------------------------------------------------
// Next.js 同进程启动
// ---------------------------------------------------------------------------

let nextServer: Server | null = null;

// main() 动态加载 @machora/shared 后缓存 self 相关 API，供 startNextJs 的
// HTTP 统计中间件与周期资源采集使用（shared 必须在 setupEnvironment 后加载）
let selfApi: {
  selfMetrics: (typeof import("@machora/shared"))["selfMetrics"];
  collectSystemMetrics: (typeof import("@machora/shared"))["collectSystemMetrics"];
} | null = null;

async function startNextJs(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const webDir = resolve(root, "web");
  const isProd = process.env.NODE_ENV === "production";

  console.log(
    `[Next.js] 启动（in-process，${isProd ? "production" : "development"}），端口 ${WEB_PORT}...`,
  );

  // next 安装在 web/node_modules（pnpm 未提升到根），用 createRequire 相对
  // web/package.json 定位。必须在同一进程运行：web（生产者）与队列处理器
  // （消费者）共享 queueBus 单例，子进程无法共享。
  const webRequire = createRequire(resolve(webDir, "package.json"));
  const nextModule = webRequire("next");
  const nextApp = nextModule({
    dev: !isProd,
    dir: webDir,
    hostname: "0.0.0.0",
    port: WEB_PORT,
  });

  // programmatic（custom server）模式：prepare() 只编译不绑端口，
  // 请求处理器必须挂在我们自己创建的 HTTP server 上
  const handler = nextApp.getRequestHandler();
  await nextApp.prepare();

  const server = createServer((req, res) => {
    // 自运维 HTTP 全量统计：请求数按状态码 + 端点（归一化）分类，耗时 observe（machora.http.*）
    const startHr = process.hrtime.bigint();
    // 归一化路径：去 query，长 ID 段替换为 {id}（避免动态路由高基数）
    const rawPath = req.url?.split("?")[0] ?? "/";
    const path = rawPath
      .split("/")
      .map((seg) => (/^[0-9a-f]{8,}$/i.test(seg) ? "{id}" : seg))
      .join("/");
    res.on("finish", () => {
      const api = selfApi;
      if (!api) return;
      const ms = Number(process.hrtime.bigint() - startHr) / 1e6;
      const code = res.statusCode;
      const status = code >= 500 ? "5xx" : code >= 400 ? "4xx" : "2xx";
      api.selfMetrics.inc("machora.http.requests", 1, { status, path });
      api.selfMetrics.observe("machora.http.duration_ms", ms, { status, path });
    });
    handler(req, res).catch((err: Error) => {
      console.error("[Next.js] 请求处理错误:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  await new Promise<void>((resolveP, reject) => {
    server.once("error", reject);
    server.listen(WEB_PORT, "0.0.0.0", () => {
      server.removeListener("error", reject);
      console.log(`[Next.js] 监听 http://localhost:${WEB_PORT}`);
      resolveP();
    });
  });

  nextServer = server;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("  Machora — Standalone 模式");
  console.log("=".repeat(60));
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  Web 端口: ${WEB_PORT}`);
  console.log("=".repeat(60));

  setupEnvironment();

  // 延迟加载 @machora/shared：db.ts 在模块加载时按 DATA_DIR 打开 SQLite 文件，
  // 必须先 setupEnvironment() 注入 env 再 import（否则落到错误的数据目录）。
  const shared = await import("@machora/shared");
  const { markSelfStarted, ensureSystemProject, startSelfMetrics } = shared;
  selfApi = {
    selfMetrics: shared.selfMetrics,
    collectSystemMetrics: shared.collectSystemMetrics,
  };

  // SQLite 句柄由 @machora/shared 的 db 单例惰性创建（DATA_DIR/machora.db）
  const sqlite = shared.getSqliteHandle();
  console.log(`[SQLite] 已就绪: ${shared.getDbPath()}`);

  applySchemaSql(sqlite);
  await seedStandaloneData();

  // 自观测：确保 system 项目存在并启动周期落库（60s），队列/请求指标由此采集；
  // collectSystemMetrics 每次 tick 先采样进程/主机资源（CPU/内存/磁盘/事件循环）再落库
  markSelfStarted();
  await ensureSystemProject();
  startSelfMetrics(60_000, () =>
    selfApi?.collectSystemMetrics(resolve(process.cwd(), DATA_DIR)),
  );
  console.log("[Self] 自观测已启动（周期落库 MetricSample → machora-system）");

  await registerQueueProcessors();

  await startNextJs();

  console.log("\n" + "=".repeat(60));
  console.log("  Machora 已启动！");
  console.log(`  Web UI:  http://localhost:${WEB_PORT}`);
  console.log(`  API:     http://localhost:${WEB_PORT}/api/public/ingestion`);
  console.log(`  Health:  http://localhost:${WEB_PORT}/api/public/health`);
  console.log("=".repeat(60));

  const shutdown = async () => {
    console.log("\n[Shutdown] 开始优雅关闭...");
    if (nextServer) {
      await new Promise<void>((r) => {
        nextServer!.close(() => r());
        setTimeout(r, 3000);
      });
      nextServer = null;
    }
    try {
      sqlite.close();
    } catch (e) {
      console.warn("[SQLite] close 失败:", (e as Error)?.message ?? e);
    }
    console.log("[Shutdown] 完成");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("启动失败:", err);
  // SQLite 为进程内句柄，进程退出即释放，无需显式关闭
  process.exit(1);
});
