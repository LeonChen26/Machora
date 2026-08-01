/**
 * Machora Standalone 启动入口
 *
 * 单进程承载：PGlite + Express + worker 队列处理器
 * 参考 Langfuse worker/src/standalone/start.ts，去掉 chDB/S3/Redis
 *
 * 关键不变量：Express 必须同进程启动，与 worker 共享 queueBus 单例
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

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

function setupEnvironment(): void {
  const defaults: Record<string, string> = {
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres?sslmode=disable&connection_limit=5`,
    NEXTAUTH_URL: `http://localhost:${WEB_PORT}`,
    NEXTAUTH_SECRET: "machora-standalone-dev-secret-do-not-use-in-production",
    PORT: String(WEB_PORT),
    NODE_ENV: "development",
    // seed 凭据
    MACHORA_INIT_PROJECT_NAME: "Machora Project",
    MACHORA_INIT_PROJECT_PUBLIC_KEY: "pk-machora-dev-000000000000000000000",
    MACHORA_INIT_PROJECT_SECRET_KEY: "sk-machora-dev-000000000000000000000",
    MACHORA_INIT_USER_EMAIL: "admin@machora.local",
    MACHORA_INIT_USER_PASSWORD: "admin123",
    MACHORA_INIT_USER_NAME: "Admin",
    // prisma engine 镜像（避开 npmjs 网络问题）
    PRISMA_ENGINES_MIRROR: "https://registry.npmmirror.com/-/binary/prisma",
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
    // 留足余量：Prisma 连接池 + db push 子进程瞬时并发会同时占多条连接，
    // 上限太小会在冷启动时拒绝新连接（P1001）
    maxConnections: 30,
  });
  await server.start();

  console.log("[PGlite] 已就绪");
  return {
    async stop() {
      try { await server.stop(); } catch {}
      try { await db.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma 迁移（prisma db push）
// ---------------------------------------------------------------------------

async function runPrismaMigrations(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const schemaPath = resolve(
    root,
    "packages",
    "shared",
    "prisma",
    "schema.prisma",
  );
  // 直接用 prisma binary，避免 pnpm exec 的 deps check
  const prismaBin = resolve(
    root,
    "packages",
    "shared",
    "node_modules",
    ".bin",
    "prisma.CMD",
  );

  // 用 async spawn：PGlite 在同进程，spawnSync 会阻塞事件循环导致
  // PGLiteSocketServer 无法接受 Prisma 的连接
  console.log("[Prisma] 执行 db push...");
  const code = await new Promise<number>((resolveP, rejectP) => {
    const child = spawn(
      prismaBin,
      ["db", "push", "--accept-data-loss", "--skip-generate", `--schema=${schemaPath}`],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: "inherit",
        shell: true,
      },
    );
    child.on("exit", (c) => resolveP(c ?? 0));
    child.on("error", rejectP);
  });
  if (code !== 0) throw new Error(`Prisma db push 失败，退出码 ${code}`);
  console.log("[Prisma] 迁移完成");
}

async function runPrismaGenerate(): Promise<void> {
  const root = resolve(import.meta.dirname, "..", "..");
  const schemaPath = resolve(
    root,
    "packages",
    "shared",
    "prisma",
    "schema.prisma",
  );
  const prismaBin = resolve(
    root,
    "packages",
    "shared",
    "node_modules",
    ".bin",
    "prisma.CMD",
  );

  console.log("[Prisma] 生成 client...");
  const code = await new Promise<number>((resolveP, rejectP) => {
    const child = spawn(
      prismaBin,
      ["generate", `--schema=${schemaPath}`],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: "inherit",
        shell: true,
      },
    );
    child.on("exit", (c) => resolveP(c ?? 0));
    child.on("error", rejectP);
  });
  if (code !== 0) throw new Error(`Prisma generate 失败，退出码 ${code}`);
  console.log("[Prisma] client 生成完成");
}

// ---------------------------------------------------------------------------
// Seed 默认数据
// ---------------------------------------------------------------------------

async function seedStandaloneData(): Promise<void> {
  const bcryptjs = (await import("bcryptjs")).default;
  const { prisma } = await import("@machora/shared");

  const projectName = process.env.MACHORA_INIT_PROJECT_NAME!;
  const publicKey = process.env.MACHORA_INIT_PROJECT_PUBLIC_KEY!;
  const secretKey = process.env.MACHORA_INIT_PROJECT_SECRET_KEY!;
  const email = process.env.MACHORA_INIT_USER_EMAIL!;
  const password = process.env.MACHORA_INIT_USER_PASSWORD!;
  const userName = process.env.MACHORA_INIT_USER_NAME!;

  // 1. Project
  const project = await prisma.project.upsert({
    where: { id: "project-standalone" },
    update: { name: projectName },
    create: { id: "project-standalone", name: projectName },
  });
  console.log("[Seed] Project:", project.id);

  // 2. API Key（仅当不存在时创建）
  const existing = await prisma.apiKey.findUnique({ where: { publicKey } });
  if (!existing) {
    const hashedSecret = await bcryptjs.hash(secretKey, 11);
    await prisma.apiKey.create({
      data: { projectId: project.id, publicKey, hashedSecret },
    });
    console.log("[Seed] API Key 已创建");
  } else {
    console.log("[Seed] API Key 已存在");
  }

  // 3. User
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const passwordHash = await bcryptjs.hash(password, 12);
    user = await prisma.user.create({
      data: { email, passwordHash, name: userName },
    });
    console.log("[Seed] User 已创建:", email);
  } else {
    console.log("[Seed] User 已存在:", email);
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

  const pglite = await startPgliteServer();

  await runPrismaMigrations();
  await runPrismaGenerate();
  await seedStandaloneData();

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
