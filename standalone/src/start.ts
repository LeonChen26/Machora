/**
 * Machora Standalone 启动入口
 *
 * 单进程承载：PGlite + Express + worker 队列处理器
 * 参考 Langfuse worker/src/standalone/start.ts，去掉 chDB/S3/Redis
 *
 * 关键不变量：Express 必须同进程启动，与 worker 共享 queueBus 单例
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 模块加载即读 .env（函数声明提升，可提前调用）：确保下方 DATA_DIR/PG_PORT/
// PORT 计算及后续 setupEnvironment 都能拿到 .env 中的值。
loadDotEnv();

const DATA_DIR = process.env.DATA_DIR ?? "./.machora-data";
// 端口说明：本机 .wslconfig 启用了 networkingMode=mirrored，WSL 与 Windows 共享
// localhost。WSL 里跑的 Langfuse standalone 占用了 5433(PGlite)/3000(Next.js)，
// Windows 侧 bind 会报 EADDRINUSE（netstat 查不到）。因此默认端口改为 5434/3100，
// 可通过 PG_PORT / PORT 环境变量覆盖。
const PG_PORT = parseInt(process.env.PG_PORT ?? "5434", 10);
const WEB_PORT = parseInt(process.env.PORT ?? "3100", 10);

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
  const defaults: Record<string, string> = {
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres?sslmode=disable&connection_limit=5`,
    NEXTAUTH_URL: `http://localhost:${WEB_PORT}`,
    NEXTAUTH_SECRET: "machora-standalone-dev-secret-do-not-use-in-production",
    PORT: String(WEB_PORT),
    NODE_ENV: envDefaultsNodeEnv,
    // seed 凭据（MACHORA_INIT_USER_PASSWORD 不设默认值：优先读 .env，
    // 未配置时 seed 随机生成，见 seedStandaloneData）
    MACHORA_INIT_PROJECT_NAME: "Machora Project",
    MACHORA_INIT_PROJECT_PUBLIC_KEY: "pk-machora-dev-000000000000000000000",
    MACHORA_INIT_PROJECT_SECRET_KEY: "sk-machora-dev-000000000000000000000",
    MACHORA_INIT_USER_EMAIL: "admin@machora.local",
    MACHORA_INIT_USER_NAME: "Admin",
  };

  for (const [k, v] of Object.entries(defaults)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// PGlite TCP 服务器
// ---------------------------------------------------------------------------

interface PgliteHandle {
  stop(): Promise<void>;
  // 直接暴露 PGlite 实例给 Schema 同步用，避免第二次 PGlite.create
  // 在同一 dataDir 打开独立句柄导致写入不持久（跨进程上下文隔离）。
  db: { exec(sql: string): Promise<unknown>; close(): Promise<void> };
}

async function startPgliteServer(): Promise<PgliteHandle> {
  // 动态 import：pglite-socket 是纯 ESM，必须运行时加载
  const [{ PGlite }, { PGLiteSocketServer }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-socket"),
  ]);

  const baseDir = resolve(DATA_DIR, "pglite");
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const dbPath = resolve(baseDir, "pgdata");

  console.log(`[PGlite] 启动，数据目录: ${dbPath}, 端口: ${PG_PORT}`);
  const db = await PGlite.create({ dataDir: dbPath, relaxedDurability: true });
  const server = new PGLiteSocketServer({
    db,
    port: PG_PORT,
    host: "127.0.0.1",
    maxConnections: 30,
  });
  await server.start();

  console.log("[PGlite] 已就绪");
  return {
    db,
    async stop() {
      try { await server.stop(); } catch {}
      try { await db.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Schema 同步（直接通过 PGlite 执行 packages/shared/sql/schema.sql）
//
// 表结构真源是 packages/shared/sql/schema.sql（幂等：IF NOT EXISTS），
// 数据访问走 drizzle-orm + pg（纯 JS，无引擎二进制），运行时零 ORM CLI。
// SQL 按分号（;）拆分，单条 try/catch 执行，整体幂等。
// ---------------------------------------------------------------------------

// 轻量 SQL 语句拆分器：按 ';' 分段，跳过 '--' 注释与空段，单引号字符串内部不拆。
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      buf += c;
      if (c === "\n" || c === "\r") inLineComment = false;
      continue;
    }
    if (!inSingle && c === "-" && next === "-") {
      inLineComment = true;
      buf += c;
      continue;
    }
    if (!inLineComment && c === "'" && sql[i - 1] !== "\\") {
      inSingle = !inSingle;
      buf += c;
      continue;
    }
    if (!inSingle && !inLineComment && c === ";") {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      continue;
    }
    buf += c;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function applySchemaSql(db: { exec(sql: string): Promise<unknown> }): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const sqlPath = resolve(
    root,
    "packages",
    "shared",
    "sql",
    "schema.sql",
  );
  if (!existsSync(sqlPath)) {
    // 本地开发模式（pnpm dev / start）未走 release 流程，
    // schema.sql 不一定存在；此时跳过 SQL 同步（不强制依赖）。
    console.warn("[Schema] 未找到 schema.sql，跳过 SQL 同步（开发模式可忽略）");
    return;
  }

  console.log("[Schema] 读 schema.sql 并幂等建表...");
  const raw = readFileSync(sqlPath, "utf8");
  const stmts = splitStatements(raw);

  let ok = 0;
  let skipped = 0;
  for (const stmt of stmts) {
    try {
      await db.exec(stmt);
      ok++;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (
        /(relation|constraint|index) .* already exists/i.test(msg) ||
        /duplicate key( value)? violates unique constraint/i.test(msg)
      ) {
        skipped++;
      } else {
        console.warn("[Schema] 语句执行失败（仍继续）:", msg.slice(0, 200));
        skipped++;
      }
    }
  }
  console.log(`[Schema] 完成（成功 ${ok}，跳过/已存在 ${skipped}，共 ${stmts.length}）`);
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
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY!;
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY!;
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

  // 2. API Key（仅当不存在时创建）
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
  console.log(`  PGlite 端口: ${PG_PORT}`);
  console.log(`  Web 端口: ${WEB_PORT}`);
  console.log("=".repeat(60));

  setupEnvironment();

  // 延迟加载 @machora/shared：db.ts 的 Pg Pool 在模块加载时读取 DATABASE_URL，
  // 必须先 setupEnvironment() 注入 env 再 import（否则连接串为 undefined，
  // pg 默认连 localhost:5432 → ECONNREFUSED）。
  const shared = await import("@machora/shared");
  const { markSelfStarted, ensureSystemProject, startSelfMetrics } = shared;
  selfApi = {
    selfMetrics: shared.selfMetrics,
    collectSystemMetrics: shared.collectSystemMetrics,
  };

  const pglite = await startPgliteServer();

  await applySchemaSql(pglite.db);
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
    await pglite.stop();
    console.log("[Shutdown] 完成");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
