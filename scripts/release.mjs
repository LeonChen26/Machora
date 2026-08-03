#!/usr/bin/env node
/**
 * Machora 发布打包脚本
 *
 * 用法：node scripts/release.mjs [--version=0.2.0]
 *
 * 流程：
 *   1. 全量构建（pnpm build：shared/worker/web/standalone 产出 dist + .next）
 *   2. 组装发布目录 .release/machora-<version>/（裁剪：源码 + dist + prisma schema + web 构建产物）
 *   3. 用 PowerShell Compress-Archive 打 zip
 *   4. 打印发布指引（含 npm 发布可选步骤）
 *
 * 发布包是"源码 + 构建产物"形态：目标机需有 node ≥20 + pnpm，
 * 解压后执行 pnpm install --frozen-lockfile 再 pnpm standalone:start 即可运行。
 */
import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argVersion = process.argv.find((a) => a.startsWith("--version="));
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

// ---------------------------------------------------------------------------
step("1/4 全量构建（pnpm build）");
execSync("pnpm build", { cwd: root, stdio: "inherit" });

// ---------------------------------------------------------------------------
step("2/4 组装发布目录");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// monorepo 根配置（install 需要）
copy("package.json");
copy("pnpm-workspace.yaml");
copy("pnpm-lock.yaml");
copy("turbo.json");

// workspace 包：源码 + dist + prisma schema（start.ts 运行时会 db push）
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
    "rem Machora Standalone 启动（生产模式，零 tsx 依赖）",
    "set NODE_ENV=production",
    "node standalone\\dist\\start.js",
    "",
  ].join("\r\n"),
);
writeFileSync(
  resolve(staging, "start.sh"),
  [
    "#!/bin/sh",
    "# Machora Standalone 启动（生产模式，零 tsx 依赖）",
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
    "环境要求：Node.js >= 20、pnpm（>= 9）",
    "",
    "安装依赖：",
    "  pnpm install --frozen-lockfile",
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
    "开发模式（热重载）：",
    "  pnpm dev",
    "",
    "数据说明：PGlite 数据落盘在 standalone/.machora-data，删除即清空。",
    "",
  ].join("\n"),
);

// ---------------------------------------------------------------------------
step("3/4 打包 zip");
rmSync(zipPath, { force: true });
// 用系统 tar（libarchive，Windows 10+ 自带 System32\tar.exe）打 zip；避免 PowerShell
// Compress-Archive 触发 Windows Recent 目录写入（沙箱环境会拦截）。
// 注意：必须显式指定 System32 tar —— PATH 里的 tar 可能是 Git 的 GNU tar（不支持 -a zip）。
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
step("4/4 完成");
console.log(`\n  发布包: ${zipPath}`);
console.log(`  大小  : ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
console.log("");
console.log("发布指引：");
console.log("  解压 zip → pnpm install --frozen-lockfile → start.cmd");
console.log("  （发布形态仅完整应用发布包；npm/pip 发布已放弃，见 design.md §9）");
