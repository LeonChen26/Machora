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
 * 检测「旧版 PGlite 数据 + 新版 SQLite 库」并存的情况。
 *
 * 引擎切换（PGlite → SQLite）改变了落盘布局：
 *   - 旧版：DATA_DIR/pglite/pgdata/（PGlite 目录结构）
 *   - 新版：DATA_DIR/machora.db
 *
 * 若不检测，老用户升级后会在同目录建一个**全新的空 machora.db**，
 * 历史 trace/observation 全部读不到（其实还在旧目录，但不会被读取），
 * 且不会报任何错 —— 属于最危险的静默失效。这里明确中止启动并给出指引。
 */
function assertNoLegacyPgliteData(): void {
  const dataDir = resolve(process.cwd(), DATA_DIR);
  const pgliteDir = resolve(dataDir, "pglite");
  const sqliteFile = resolve(dataDir, "machora.db");

  if (!existsSync(pgliteDir)) return;
  if (existsSync(sqliteFile)) return; // 已迁移或已在用 SQLite，不打扰

  console.error(
    [
      "",
      "=".repeat(64),
      "[迁移阻断] 检测到旧版 PGlite 数据目录，但尚无 SQLite 数据库：",
      `  PGlite 数据: ${pgliteDir}`,
      `  SQLite 库:   ${sqliteFile}（不存在）`,
      "",
      "本版本已将存储引擎由 PGlite（进程内 Postgres）切换为 SQLite，",
      "两种格式不兼容，无法自动迁移。若直接启动将创建一个空库，",
      "历史数据虽仍在旧目录中，但不会被读取。",
      "",
      "请按以下方式之一处理：",
      "  1) 保留旧数据：先把旧目录改名备份，再启动新版本（历史数据不会出现在新库中）",
      `     mv "${pgliteDir}" "${pgliteDir}.bak"`,
      "  2) 无需旧数据：确认后删除旧目录再启动",
      `     rm -rf "${pgliteDir}"`,
      "  3) 如需把历史数据导入新库，请先用旧版本导出，再通过 ingestion API 重新写入",
      "=".repeat(64),
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * 检测「旧版 SQLite schema」的库并提供明确处理指引。
 *
 * 背景：本项目在 SQLite 时代改过一次列语义 ——
 *   - 旧版 Trace 的时间列叫 `createdAt`
 *   - 新版改名为 `timestamp`（并加了 `Trace_projectId_timestamp_idx`）
 *
 * 这类列**改名**无法自动迁移：SQLite 没有「重命名列并保证语义一致」的安全路径，
 * 而 schema.sql 的 CREATE TABLE IF NOT EXISTS 不会改动已存在的旧表。结果是：
 *   - 启动本身能走通（缺列的索引已被容错跳过）
 *   - 但所有读取 trace 的页面/API 都会 500（查询层按新列名 `timestamp` 取数）
 *
 * 这种「起得来、但用不了」的状态对用户最不友好，因此显式中止启动并给出指引。
 * 与 assertNoLegacyPgliteData 保持一致的处置风格：宁可明确报错，不要静默半可用。
 */
function assertNoLegacySqliteSchema(
  db: SqliteDb,
  migrate: typeof import("@machora/shared/sqlite-migrate"),
): void {
  const issues = migrate.detectLegacySchema(db);
  if (issues.length === 0) return;

  const dataDir = resolve(process.cwd(), DATA_DIR);
  const sqliteFile = resolve(dataDir, "machora.db");

  const lines: string[] = [
    "",
    "=".repeat(64),
    "[迁移阻断] 检测到旧版 SQLite 库结构，无法安全自动迁移：",
    `  SQLite 库: ${sqliteFile}`,
    "",
  ];
  for (const it of issues) {
    const rows = db.prepare(`SELECT COUNT(*) c FROM "${it.table}"`).get() as { c: number };
    lines.push(
      `  表 ${it.table}：旧列 "${it.legacyColumn}" 已改名为 "${it.expectedColumn}"（现有 ${rows.c} 行）`,
    );
  }
  lines.push(
    "",
    "该结构无法安全自动迁移。若强行启动，进程虽能起来，",
    "但所有 trace 相关页面与 API 都会返回 500（查询层按新列名取数）。",
    "",
    "请按以下方式之一处理：",
    "  1) 保留旧数据：先把旧库改名备份，再启动新版本（历史数据不会出现在新库中）",
    `     mv "${sqliteFile}" "${sqliteFile}.bak"`,
    "  2) 无需旧数据：确认后删除旧库再启动",
    `     rm -f "${sqliteFile}" "${sqliteFile}-wal" "${sqliteFile}-shm"`,
    "  3) 如需保留历史数据：请用旧版本启动并导出",
    "     （Web UI 的“导出”或 /api/export/traces、/api/export/generations），",
    "     再用新版本通过 /api/public/ingestion 重新写入。",
    "=".repeat(64),
    "",
  );
  console.error(lines.join("\n"));
  process.exit(1);
}

/** 与 schema.sql 完全一致的 Evaluation 建表 DDL（用于存量库重建以补 datasetItemId 外键） */
const EVALUATION_DDL = `CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "traceId" TEXT REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "datasetItemId" TEXT REFERENCES "DatasetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "name" TEXT NOT NULL,
    "evaluatorType" TEXT NOT NULL,
    "config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mode" TEXT NOT NULL DEFAULT 'EXPERIMENT',
    "error" TEXT,
    "result" TEXT,
    "createdAt" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    "updatedAt" INTEGER NOT NULL
)`;

/** Evaluation 表在 schema.sql 中定义的索引（重建后需恢复） */
const EVALUATION_INDEXES = [
  {
    name: "Evaluation_projectId_createdAt_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_projectId_createdAt_idx" ON "Evaluation"("projectId", "createdAt")`,
  },
  {
    name: "Evaluation_traceId_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_traceId_idx" ON "Evaluation"("traceId")`,
  },
  {
    name: "Evaluation_status_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_status_idx" ON "Evaluation"("status")`,
  },
  {
    name: "Evaluation_datasetItemId_idx",
    ddl: `CREATE INDEX IF NOT EXISTS "Evaluation_datasetItemId_idx" ON "Evaluation"("datasetItemId")`,
  },
];

function applySchemaSql(
  db: SqliteDb,
  migrate: typeof import("@machora/shared/sqlite-migrate"),
): void {
  const root = resolve(import.meta.dirname, "..", "..");
  const sqlPath = resolve(root, "packages", "shared", "sql", "schema.sql");
  if (!existsSync(sqlPath)) {
    // 本地开发模式（pnpm dev / start）未走 release 流程，schema.sql 不一定存在
    console.warn("[Schema] 未找到 schema.sql，跳过 SQL 同步（开发模式可忽略）");
    return;
  }

  console.log("[Schema] 执行 schema.sql 幂等建表...");
  // 旧版 SQLite 结构（Trace 时间列名为 createdAt）无法安全自动迁移，
  // 起得来但所有 trace 读路径都会 500 —— 在任何 DDL 之前先明确阻断。
  assertNoLegacySqliteSchema(db, migrate);
  // 逐条容错执行：schema.sql 里的 CREATE INDEX IF NOT EXISTS 只按索引名去重，
  // 不校验被索引的列是否存在。旧版本建库的用户（列名/列集更旧）会因为
  // 某条索引引用了缺失列而整文件执行失败，导致启动崩溃。
  // 这里改为先跳过这类索引，等下面的补列/表重建跑完再重试一次。
  const sqlText = readFileSync(sqlPath, "utf8");
  const first = migrate.applySchemaSql(db, sqlText);
  for (const s of first.skipped) {
    console.warn(
      `[Schema] 暂缓索引（列缺失，待补列后重试）: ${s.statement.replace(/\s+/g, " ")} — 缺 ${s.missing.join(", ")}`,
    );
  }

  // 存量库补列（新建库时这些列已在 CREATE TABLE 中，此处为 no-op）
  // 无外键的列走轻量 ADD COLUMN
  if (migrate.ensureColumn(db, "EvaluationConfig", "autoRun", `"autoRun" INTEGER NOT NULL DEFAULT 0`)) {
    console.log("[Schema] 补列 EvaluationConfig.autoRun");
  }
  if (migrate.ensureColumn(db, "Evaluation", "mode", `"mode" TEXT NOT NULL DEFAULT 'EXPERIMENT'`)) {
    console.log("[Schema] 补列 Evaluation.mode");
  }
  // datasetItemId 带 REFERENCES，必须走表重建 ——
  // ALTER TABLE ADD COLUMN 无法附加外键，补出来的是裸列，
  // 会导致删除 DatasetItem 后关联 Evaluation 成为孤儿残留
  if (
    migrate.ensureColumnWithFk(db, "Evaluation", "datasetItemId", {
      targetDdl: EVALUATION_DDL,
      indexes: EVALUATION_INDEXES,
    })
  ) {
    console.log(
      `[Schema] 重建表 Evaluation 以补齐带外键的列 datasetItemId（已恢复 ${EVALUATION_INDEXES.length} 个索引）`,
    );
  }

  // 补列后再跑一次 schema.sql，把第一轮跳过的索引补建回来（已是幂等 + 容错）
  const second = migrate.applySchemaSql(db, sqlText);
  if (second.applied > 0) {
    console.log(`[Schema] 二次同步完成（应用 ${second.applied} 条语句）`);
  }
  for (const s of second.skipped) {
    console.warn(
      `[Schema] 索引仍被跳过（列缺失）: ${s.statement.replace(/\s+/g, " ")} — 缺 ${s.missing.join(", ")}`,
    );
  }

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

  // 先拦截「旧 PGlite 数据 + 无 SQLite 库」的升级场景 ——
  // 必须在 getSqliteHandle() 建库之前判断，否则空库已被创建、条件失效
  assertNoLegacyPgliteData();

  // SQLite 句柄由 @machora/shared 的 db 单例惰性创建（DATA_DIR/machora.db）
  const sqlite = shared.getSqliteHandle();
  console.log(`[SQLite] 已就绪: ${shared.getDbPath()}`);

  applySchemaSql(sqlite, shared.sqliteMigrate);
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
