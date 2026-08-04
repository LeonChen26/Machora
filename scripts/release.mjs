#!/usr/bin/env node
/**
 * Machora 发布打包脚本
 *
 * 用法：node scripts/release.mjs [--version=0.2.0] [--with-deps]
 *
 * 流程：
 *   1. 全量构建（pnpm build：shared/worker/web/standalone 产出 dist + .next）
 *   2. 组装发布目录 .release/machora-<version>/
 *   3. 在 staging 构建期做两件事（轻量/完整包都跑）：
 *        a) prisma generate → 产物跟包走，运行时永不生成
 *        b) prisma migrate diff → 导出 schema.sql（IF NOT EXISTS 幂等），运行时直接 exec
 *   4. [--with-deps] 在 staging 现场 pnpm install --prod 装运行时依赖
 *      （不再包含 prisma CLI，启动时彻底零 prisma 调用）
 *   5. 打 zip（System32 tar）
 *   6. 打印发布指引
 *
 * 发布形态：
 *   - 默认（轻量包）：源码 + 构建产物。目标机需 node ≥20 + pnpm，解压后 pnpm install --frozen-lockfile 再启动。
 *   - --with-deps（完整包）：含 node_modules，解压即用、零安装。平台特定（Windows 包仅 Windows 可用，
 *     Linux 包需在 Linux/ECS 上构建），因 pglite wasm / esbuild 二进制随平台。
 */
import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argVersion = process.argv.find((a) => a.startsWith("--version="));
const withDeps = process.argv.includes("--with-deps");
const version = argVersion
  ? argVersion.slice("--version=".length)
  : readFileSync(resolve(root, "package.json"), "utf8")
      .match(/"version":\s*"([^"]+)"/)?.[1] ?? "0.1.0";

const name = `machora-standalone-${version}`;
const staging = resolve(root, ".release", name);
const zipPath = resolve(root, ".release", `${name}.zip`);

function copy(from, to = from) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.warn(`[release] 跳过缺失路径: ${from}`);
    return;
  }
  cpSync(src, resolve(staging, to), { recursive: true });
}

function step(msg) {
  console.log(`\n[release] ${msg}`);
}

// 把 Prisma 导出的原始 schema.sql 改为幂等版本：
//   CREATE TABLE ...  → CREATE TABLE IF NOT EXISTS ...
//   CREATE [UNIQUE] INDEX ...  → CREATE [UNIQUE] INDEX IF NOT EXISTS ...
// ALTER ADD FOREIGN KEY 不处理，下面 applyIdempotentSchema 会单条 try/catch 兜底。
function toIdempotentSchema(sql) {
  return sql
    .replace(/CREATE TABLE (IF NOT EXISTS )?"/g, 'CREATE TABLE IF NOT EXISTS "')
    .replace(/CREATE UNIQUE INDEX (IF NOT EXISTS )?"/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
    .replace(/CREATE INDEX (IF NOT EXISTS )?"/g, 'CREATE INDEX IF NOT EXISTS "');
}

// 定位 prisma CLI（只在构建期的仓库根用）
function resolveBuildPrismaBin() {
  const binName = process.platform === "win32" ? "prisma.CMD" : "prisma";
  const candidates = [
    resolve(root, "packages", "shared", "node_modules", ".bin", binName),
    resolve(root, "node_modules", ".bin", binName),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(`构建期未找到 prisma CLI（尝试 ${candidates.join("、")}）`);
  }
  return found;
}

// ---------------------------------------------------------------------------
step(withDeps ? "1/5 全量构建（pnpm build）" : "1/4 全量构建（pnpm build）");
// Next.js production build 会加载全部 server 路由（含 prisma 连接的 api 路由），为避免
// 构建阶段模块顶层副作用触发 DB 连接，这里给占位 env。运行时真实值由 start.ts 设置。
const prev = {};
for (const [k, v] of Object.entries({
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
  NEXTAUTH_URL: "http://localhost",
  NEXTAUTH_SECRET: "build-stub-secret-only",
  SKIP_ENV_VALIDATION: "1",
})) {
  prev[k] = process.env[k];
  process.env[k] = v;
}
try {
  execSync("pnpm build", { cwd: root, stdio: "inherit" });
} finally {
  for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  }
}

// ---------------------------------------------------------------------------
step(withDeps ? "2/5 组装发布目录" : "2/4 组装发布目录");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// monorepo 根配置（install 需要）
copy("package.json");
copy("pnpm-workspace.yaml");
copy("pnpm-lock.yaml");
copy("turbo.json");
copy(".env.example"); // 目标机配置参考（.env 需自行创建）

// workspace 包：源码 + dist + prisma schema（start.ts 会读 schema.sql）
copy("packages/shared/package.json", "packages/shared/package.json");
copy("packages/shared/dist", "packages/shared/dist");
copy("packages/shared/prisma", "packages/shared/prisma");
copy("packages/shared/tsconfig.json", "packages/shared/tsconfig.json");
copy("packages/shared/tsconfig.build.json", "packages/shared/tsconfig.build.json");
copy("packages/shared/src", "packages/shared/src"); // fixture/OTel 解码源码随包，便于本地调试

copy("worker/package.json", "worker/package.json");
copy("worker/dist", "worker/dist");
copy("worker/tsconfig.json", "worker/tsconfig.json");
copy("worker/tsconfig.build.json", "worker/tsconfig.build.json");
copy("worker/src", "worker/src");

copy("web/package.json", "web/package.json");
copy("web/tsconfig.json", "web/tsconfig.json");
copy("web/next-env.d.ts", "web/next-env.d.ts");
copy("web/public", "web/public");
copy("web/.next", "web/.next"); // production next({ dev: false }) 依赖

copy("standalone/package.json", "standalone/package.json");
copy("standalone/tsconfig.json", "standalone/tsconfig.json");
copy("standalone/tsconfig.build.json", "standalone/tsconfig.build.json");
copy("standalone/dist", "standalone/dist");
copy("standalone/src", "standalone/src");

// 启动脚本（Windows / POSIX）
writeFileSync(
  resolve(staging, "start.cmd"),
  [
    "@echo off",
    "rem Machora Standalone 启动（生产模式，零 tsx 依赖，零 prisma CLI 调用）",
    "set NODE_ENV=production",
    "node standalone\\dist\\start.js",
    "",
  ].join("\r\n"),
);
writeFileSync(
  resolve(staging, "start.sh"),
  [
    "#!/bin/sh",
    "# Machora Standalone 启动（生产模式，零 tsx 依赖，零 prisma CLI 调用）",
    "export NODE_ENV=production",
    'exec node standalone/dist/start.js "$@"',
    "",
  ].join("\n"),
);

// 发布包内 README（构建产物的组成部分）
writeFileSync(
  resolve(staging, "README.txt"),
  [
    `Machora Standalone ${version}`,
    "==========================",
    "",
    "单进程 LLM 可观测平台：PGlite（嵌入式 PostgreSQL）+ Express + Next.js 生产构建。",
    "",
    withDeps
      ? "形态：完整包（含 node_modules，解压即用，仅限 " + process.platform + " " + process.arch + " 平台）"
      : "形态：轻量包（源码 + 构建产物，需目标机有 pnpm）",
    "",
    "环境要求：Node.js >= 20" + (withDeps ? "" : "、pnpm（>= 9）"),
    "",
    withDeps ? "无需安装依赖，解压后直接启动。" : "安装依赖：\n  pnpm install --frozen-lockfile",
    "",
    "启动（生产模式，默认 http://localhost:3100）：",
    "  Windows: start.cmd",
    "  POSIX : ./start.sh",
    "",
    "常用环境变量（可选）：",
    "  PORT    Web 端口，默认 3100",
    "  PG_PORT PGlite 端口，默认 5434",
    "  DATA_DIR 数据目录，默认 standalone/.machora-data",
    "",
    "管理员凭据：应用根目录存在 .env 时自动加载（可参考 .env.example 复制改名）。",
    "  MACHORA_INIT_USER_PASSWORD 管理员初始密码，建议设置；未设置时首次启动随机生成并打印在日志",
    "",
    withDeps ? "" : "开发模式（热重载）：\n  pnpm dev\n",
    "数据说明：PGlite 数据落盘在 standalone/.machora-data，删除即清空。",
    "",
    "Schema 初始化：构建期已预生成 Prisma Client，并把 schema 导出为 packages/shared/prisma/schema.sql，",
    "启动时 PGlite 直接读 SQL 幂等建表，不调用 prisma CLI，零 prisma engines 下载。",
    "",
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// 构建期 prisma 动作（轻量/完整包都要，打包后运行时就不依赖 prisma 了）
step(withDeps ? "3/5 构建期 Prisma（预 generate + 导出 schema.sql）" : "3/4 构建期 Prisma（预 generate + 导出 schema.sql）");
{
  const prismaBin = resolveBuildPrismaBin();
  const sharedDir = resolve(staging, "packages", "shared");
  // 关键：必须用仓库内的 schema 路径（packages/shared/prisma/schema.prisma），
  // 不能用 staging 中的 schema 副本——Prisma CLI 会沿 schema 路径向上找
  // 最近的 package.json，并以该目录为准判断是否「已装 prisma」。若指向
  // staging 目录的副本，prisma 会认为当前项目未装 prisma，触发 `pnpm add prisma@x -D`
  // 自动安装，在 TRAE 沙箱里 pnpm add 会被 E:.pnpm-store 拦截而失败。
  const srcSchemaPath = resolve(root, "packages", "shared", "prisma", "schema.prisma");
  const schemaSqlPath = resolve(sharedDir, "prisma", "schema.sql");
  const prismaClientOutput = resolve(staging, "node_modules", ".prisma", "client");
  mkdirSync(prismaClientOutput, { recursive: true });
  const tmpSql = resolve(staging, "_schema.raw.sql");
  const prismaCwd = resolve(root, "packages", "shared");

  execSync(
    `"${prismaBin}" generate --schema="${srcSchemaPath}"`,
    { cwd: prismaCwd, stdio: "inherit" },
  );

  // prisma generate 在 pnpm workspace 下输出到
  //   node_modules/.pnpm/@prisma+client@x/node_modules/.prisma/client
  // 复制到 staging/node_modules/.prisma/client 以便跟包发布。
  {
    const pnpmRoot = resolve(root, "node_modules", ".pnpm");
    const candidates = [
      resolve(prismaCwd, "node_modules", ".prisma", "client"),
      resolve(root, "node_modules", ".prisma", "client"),
    ];
    if (existsSync(pnpmRoot)) {
      for (const d of readdirSync(pnpmRoot)) {
        if (d.startsWith("@prisma+client@")) {
          candidates.push(
            resolve(pnpmRoot, d, "node_modules", ".prisma", "client"),
          );
        }
      }
    }
    const src = candidates.find((c) => existsSync(resolve(c, "default.js")));
    if (src) {
      cpSync(src, prismaClientOutput, { recursive: true });
    } else {
      throw new Error(`prisma generate 产物未找到（尝试 ${candidates.join("、")}）`);
    }
  }

  execSync(
    `"${prismaBin}" migrate diff --from-empty --to-schema-datamodel "${srcSchemaPath}" --script --output "${tmpSql}"`,
    { cwd: prismaCwd, stdio: "inherit" },
  );
  const raw = readFileSync(tmpSql, "utf8");
  writeFileSync(schemaSqlPath, toIdempotentSchema(raw), "utf8");
  rmSync(tmpSql, { force: true });

  // 把生成的 Prisma Client 也复制一份到 .next/node_modules/.prisma/client，
  // 绕开 Turbopack 外部化 default.js 向上解析找不到 .prisma/client/default 的问题。
  const nextNodeModules = resolve(staging, "web", ".next", "node_modules");
  const nmDir = resolve(staging, "node_modules");
  const prismaOutSrc = resolve(nmDir, ".prisma", "client");
  if (existsSync(prismaOutSrc)) {
    const dest = resolve(nextNodeModules, ".prisma", "client");
    if (!existsSync(resolve(dest, "default.js"))) {
      mkdirSync(resolve(dest, ".."), { recursive: true });
      cpSync(prismaOutSrc, dest, { recursive: true });
    }
  }
  console.log("[release] 预生成 Prisma Client + schema.sql 完成，运行时零 prisma CLI 调用");
}

// ---------------------------------------------------------------------------
// [--with-deps] 在 staging 现场装运行时依赖。
// --node-linker=hoisted：npm 扁平布局，无符号链接，避免 tar 解引用导致 zip 体积翻倍。
// --prod：跳过 typescript/vitest/tsx/prisma 等 dev 工具；**prisma 现在在 devDependencies，
// 不会被装入 node_modules**——因为上面构建期阶段已经用仓库 prisma CLI 把 generate/diff 做完了。
// 裁掉 @next/swc（SWC 编译器，仅 dev build 用）、@img/sharp（Next.js 图片优化，未启用）、
// typescript（@trpc peerDep，运行时不需要）。
let afterSchemaStep = withDeps ? 4 : 3;
if (withDeps) {
  step("4/5 安装运行时依赖（hoisted + prod，不含 prisma CLI）");
  // 合并仓库根的 registry/fetch 配置（否则 staging 新装 npmrc 会回退 npmjs.org 被墙）
  const rootNpmrc = existsSync(resolve(root, ".npmrc"))
    ? readFileSync(resolve(root, ".npmrc"), "utf8")
    : "";
  writeFileSync(
    resolve(staging, ".npmrc"),
    (rootNpmrc ? rootNpmrc.trimEnd() + "\n" : "") + "node-linker=hoisted\n",
  );
  // --store-dir 禁用全局 pnpm store（TRAE 沙箱禁止操作 E:\.pnpm-store），
  // 强制在 staging 内建本地 store，避免跨仓库路径被拦截。
  execSync(
    "pnpm install --frozen-lockfile --prod --node-linker=hoisted --store-dir .pnpm-store-local",
    { cwd: staging, stdio: "inherit" },
  );
  // 本地 store 仅构建时用，不随包发布（否则 zip 体积翻倍）。
  const localStore = resolve(staging, ".pnpm-store-local");
  if (existsSync(localStore)) rmSync(localStore, { recursive: true, force: true });
  // 裁掉生产不需要的大体积 optional 依赖
  // 注意：@next 只能裁 swc-*（SWC 编译器二进制，仅 dev build 用）；
  // @next/env 是 Next.js 运行时依赖，必须保留。
  // @prisma/client optionalDependencies 里带 prisma（CLI + engines），这是
  // 可选 peer，--prod 安装仍然会装；必须在运行时里把 prisma 整包删掉，
  // 确保 release 包真的「运行时零 prisma CLI」。
  const nmDir = resolve(staging, "node_modules");
  const nextDir = resolve(nmDir, "@next");
  if (existsSync(nextDir)) {
    for (const d of readdirSync(nextDir)) {
      if (d.startsWith("swc-")) {
        rmSync(resolve(nextDir, d), { recursive: true, force: true });
      }
    }
  }
  const trimTargets = [
    "@img", // sharp 图片处理，未启用 next/image 优化
    "typescript", // @trpc peerDep，运行时不需要
    "prisma", // prisma CLI + engines（构建期已做完 generate/diff，运行时零依赖）
  ];
  for (const t of trimTargets) {
    const p = resolve(nmDir, t);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  // @prisma/client optionalDeps 带的 prisma 还会在 .bin 里留下入口，顺手删除
  const binName = process.platform === "win32" ? "prisma.CMD" : "prisma";
  const prismaBinInStaging = resolve(nmDir, ".bin", binName);
  if (existsSync(prismaBinInStaging)) rmSync(prismaBinInStaging, { force: true });
  // 发布包仅需 node_modules，不再需要 workspace 元数据；删掉后 Next.js
  // 不会再把 staging 当成 monorepo workspace 的根，也就不会向父目录递归
  // 推断 workspace root（之前会找到解压目录外的真正仓库 pnpm-workspace.yaml，
  // 导致把别人的项目当成 root，app/pages 找不到，整站 SSR 500）。
  for (const f of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "turbo.json"]) {
    const p = resolve(staging, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  // 轻量包模式也不再需要真实仓库的 pnpm-workspace.yaml（和 staging 里的目录
  // 结构不匹配），目标机在 staging 内 `pnpm install --frozen-lockfile` 时
  // 用 staging 自己的 workspace 元数据。但轻量包保留 pnpm-lock.yaml。
  console.log("[release] 已裁剪 prisma CLI/engines、@next/swc、@img/sharp、typescript（生产运行不需要）");
  afterSchemaStep = 5;
}

// ---------------------------------------------------------------------------
step(`${afterSchemaStep}/${withDeps ? 5 : 4} 打包 zip`);
rmSync(zipPath, { force: true });
// 用系统 tar（libarchive，Windows 10+ 自带 System32\tar.exe）打 zip；避免 PowerShell
// Compress-Archive 触发 Windows Recent 目录写入（沙箱环境会拦截）。
// 注意：必须显式指定 System32 tar —— PATH 里的 tar 可能是 Git 的 GNU tar（不支持 -a zip）。
// --with-deps 时 node_modules 含大量小文件，tar 比 Compress-Archive 快且无 Recent 副作用。
const tarBin =
  process.platform === "win32"
    ? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
const r = spawnSync(
  tarBin,
  ["-a", "-c", "-f", `.release/${name}.zip`, "-C", `.release/${name}`, "."],
  { cwd: root, encoding: "utf8" },
);
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  process.exit(1);
}

// ---------------------------------------------------------------------------
step(`${withDeps ? 5 : 4}/${withDeps ? 5 : 4} 完成`);
console.log(`\n  发布包: ${zipPath}`);
console.log(`  大小  : ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  形态  : ${withDeps ? "完整包（含 node_modules，解压即用）" : "轻量包（目标机需 pnpm install）"}`);
console.log(`  平台  : ${process.platform} ${process.arch}（完整包仅同平台可用）`);
console.log("");
console.log("关键特性（v0.1.2+）：");
console.log("  ✓ 构建期预生成 Prisma Client + schema.sql");
console.log("  ✓ 运行时零 prisma CLI / prisma engines 调用");
console.log("");
console.log("发布指引：");
if (withDeps) {
  console.log("  解压 zip → start.cmd（Windows）/ ./start.sh（POSIX）即可运行，无需 pnpm install");
} else {
  console.log("  解压 zip → pnpm install --frozen-lockfile → start.cmd");
}
console.log("  （发布形态仅完整应用发布包；npm/pip 发布已放弃，见 design.md §9）");
