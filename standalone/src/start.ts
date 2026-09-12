/**
 * Machora Standalone 启动入口
 *
 * 单进程承载：SQLite（嵌入式）+ Next.js + worker 队列处理器
 * 参考 Langfuse worker/src/standalone/start.ts，去掉 chDB/S3/Redis
 *
 * 关键不变量：Next.js 必须同进程启动，与 worker 共享 queueBus 单例
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
  const defaults: Record<string, string> = {
    PORT: String(WEB_PORT),
    NODE_ENV: envDefaultsNodeEnv,
  };

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

function applySchemaSql(db: SqliteDb): void {
  const root = resolve(import.meta.dirname, "..", "..");
  const sqlPath = resolve(root, "packages", "shared", "sql", "schema.sql");
  if (!existsSync(sqlPath)) {
    // 本地开发模式（pnpm dev / start）未走 release 流程，schema.sql 不一定存在
    console.warn("[Schema] 未找到 schema.sql，跳过 SQL 同步（开发模式可忽略）");
    return;
  }

  console.log("[Schema] 执行 schema.sql 幂等建表...");
  // better-sqlite3 的 exec() 原生支持多语句；schema.sql 全为幂等 DDL，整文件直接执行
  db.exec(readFileSync(sqlPath, "utf8"));
  console.log("[Schema] 完成");
}

// ---------------------------------------------------------------------------
// 存量库校验
//
// schema.sql 全为 CREATE TABLE IF NOT EXISTS：对「已存在但结构较旧」的库不会补列，
// 会静默启动成功，直到某条查询在运行时 500。这里在 exec 之前显式探测，fail-fast
// 并给出可执行指引（删除重建 / 导出重导）。
// ---------------------------------------------------------------------------

/** 当前版本 Trace 表必须具备的列（后续新增列可追加到此集合） */
const REQUIRED_TRACE_COLUMNS = ["agentVersion", "status", "tags"] as const;

function assertNoLegacySchema(db: SqliteDb): void {
  // 旧 PGlite 数据目录存在、但尚无 SQLite 文件：格式不通，不能静默建空库
  const dataDir = resolve(process.cwd(), DATA_DIR);
  const pgliteDir = resolve(dataDir, "pglite");
  if (existsSync(pgliteDir) && !existsSync(resolve(dataDir, "machora.db"))) {
    throw new Error(
      `[Schema] 检测到旧 PGlite 数据目录（${pgliteDir}）但尚无 machora.db。\n` +
        "  PGlite 与 SQLite 文件格式不通，无法原地升级；请先备份并导出数据" +
        "（/api/export/traces、/api/export/generations），删除 DATA_DIR 后重导入。",
    );
  }

  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Trace'")
    .get();
  if (!table) return; // 全新库：交给 schema.sql 建表

  const cols = new Set(
    (db.prepare("PRAGMA table_info(Trace)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  // 旧 SQLite 结构时间列名为 createdAt（现为 timestamp）；改名无法安全自动迁移
  if (cols.has("createdAt") && !cols.has("timestamp")) {
    throw new Error(
      "[Schema] 检测到旧版 SQLite 结构（Trace.createdAt 已改名为 timestamp），无法自动迁移。\n" +
        "  请先备份 DATA_DIR，再删除重建或用 /api/export/* 导出后重导。",
    );
  }
  const missing = REQUIRED_TRACE_COLUMNS.filter((c) => !cols.has(c));
  if (missing.length > 0) {
    throw new Error(
      `[Schema] 存量库缺少必需列：${missing.join(", ")}（schema.sql 只做幂等建表，不补列）。\n` +
        "  请先备份 DATA_DIR，再删除重建或用 /api/export/* 导出后重导。",
    );
  }
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
  const { markSelfStarted, startSelfMetrics } = shared;
  selfApi = {
    selfMetrics: shared.selfMetrics,
    collectSystemMetrics: shared.collectSystemMetrics,
  };

  // SQLite 句柄由 @machora/shared 的 db 单例惰性创建（DATA_DIR/machora.db）
  const sqlite = shared.getSqliteHandle();
  console.log(`[SQLite] 已就绪: ${shared.getDbPath()}`);

  // 先校验存量库（旧 PGlite / 旧 SQLite 结构），再执行幂等建表
  assertNoLegacySchema(sqlite);
  applySchemaSql(sqlite);

  // 自观测：启动周期落库（60s），队列/请求指标由此采集；
  // collectSystemMetrics 每次 tick 先采样进程/主机资源（CPU/内存/磁盘/事件循环）再落库
  markSelfStarted();
  startSelfMetrics(60_000, () =>
    selfApi?.collectSystemMetrics(resolve(process.cwd(), DATA_DIR)),
  );
  console.log("[Self] 自观测已启动（周期落库 MetricSample）");

  await registerQueueProcessors();

  await startNextJs();

  console.log("\n" + "=".repeat(60));
  console.log("  Machora 已启动！");
  console.log(`  Web UI:  http://localhost:${WEB_PORT}`);
  console.log(`  Ingest:  http://localhost:${WEB_PORT}/api/public/otel/v1/traces`);
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
