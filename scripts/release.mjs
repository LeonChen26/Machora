#!/usr/bin/env node
/**
 * Machora 发布打包脚本
 *
 * 用法：node scripts/release.mjs [--version=0.2.0] [--with-deps]
 *
 * 流程：
 *   1. 全量构建（pnpm build：shared/worker/web/standalone 产出 dist + .next）
 *   2. 组装发布目录 .release/machora-<version>/（含 schema.sql，start.ts 幂等建表）
 *   3. [--with-deps] 在 staging 现场 pnpm install --prod 装运行时依赖
 *   4. 打 zip（System32 tar）
 *   5. 打印发布指引
 *
 * 发布形态：
 *   - 默认（轻量包）：源码 + 构建产物。目标机需 node ≥20 + pnpm，解压后 pnpm install --frozen-lockfile 再启动。
 *   - --with-deps（完整包）：含 node_modules，解压即用、零安装。平台特定（Windows 包仅 Windows 可用，
 *     Linux 包需在 Linux/ECS 上构建），因 better-sqlite3 原生二进制 / esbuild 二进制随平台。
 *
 * 运行时零 ORM CLI：数据访问用 drizzle-orm + better-sqlite3，表结构由
 * packages/shared/sql/schema.sql（幂等）在启动时直接 exec，无需数据库服务。
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
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argVersion = process.argv.find((a) => a.startsWith("--version="));
const withDeps = process.argv.includes("--with-deps");
const totalSteps = withDeps ? 4 : 3;
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

// Windows 上 rmSync({recursive, force}) 对含只读文件（.next 产物全为只读）的目录
// 会静默失败（force 吞 EPERM），导致 staging 清理不净、dev 缓存残留进发布包。
// 改用 Node fs.rmSync：Windows 上先剥离只读属性再删，maxRetries 处理瞬态占用
//（rimraf 同款策略），保证每次从零组装，杜绝轻量包误带完整包的 node_modules。
function rmForce(p) {
  if (!existsSync(p)) return;
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 20 });
  } catch (e) {
    // 偶发失败（如目标已被并发删除）通常可忽略，但记录路径与错误，
    // 避免权限/占用类真实问题被静默掩盖
    console.warn(`[release] rmForce 删除失败（后续组装会覆盖）: ${p}`, e?.message ?? e);
  }
}

// 原生模块的运行时依赖闭包必须与包本体一起固化。
//
// better-sqlite3 通过 require('bindings')('better_sqlite3.node') 定位原生二进制，
// bindings 又依赖 file-uri-to-path。pnpm 隔离布局下它们位于
// node_modules/.pnpm/<pkg>@<ver>/node_modules/ 的兄弟目录，**不在** Node 从
// web/.next/node_modules/<alias>/ 向上的解析路径上（隐藏提升 node_modules/.pnpm/node_modules
// 也命不中）。只固化包本体会导致轻量包安装后
// "MODULE_NOT_FOUND: Cannot find module 'bindings'" → 所有走 DB 的路由 500。
// 故把这些包按真实目录放到 web/.next/node_modules/ 同一层。
function copyNativeDepClosure(destNm) {
  let bs3Pkg;
  try {
    const sharedRequire = createRequire(
      resolve(root, "packages", "shared", "package.json"),
    );
    bs3Pkg = sharedRequire.resolve("better-sqlite3/package.json");
  } catch (e) {
    console.warn(
      `[release] 无法解析 better-sqlite3，跳过原生依赖闭包固化: ${e?.message ?? e}`,
    );
    return;
  }

  // 从 better-sqlite3 自身的解析上下文逐级取依赖（bindings → file-uri-to-path）
  const closure = [];
  try {
    const bs3Require = createRequire(bs3Pkg);
    const bindingsPkg = bs3Require.resolve("bindings/package.json");
    closure.push({ name: "bindings", src: dirname(bindingsPkg) });
    const bindingsRequire = createRequire(bindingsPkg);
    closure.push({
      name: "file-uri-to-path",
      src: dirname(bindingsRequire.resolve("file-uri-to-path/package.json")),
    });
  } catch (e) {
    console.warn(
      `[release] 原生依赖闭包解析失败（运行时将 Cannot find module）: ${e?.message ?? e}`,
    );
    return;
  }

  mkdirSync(destNm, { recursive: true });
  for (const { name, src } of closure) {
    const dest = resolve(destNm, name);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`[release] 原生依赖已固化: ${name}`);
  }
}

// 轻量包保留 pnpm-workspace.yaml（allowBuilds 控制 better-sqlite3 原生构建），
// 但其中 supportedArchitectures 会把依赖按「构建机平台」过滤：在 Linux/ECS 目标机
// 安装时会取不到正确的平台二进制（@next/swc-*、esbuild 等），运行时才报缺模块。
// 故打包时移除该段（仅影响轻量包；完整包不使用 staging 的 workspace 元数据）。
function stripSupportedArchitectures() {
  const p = resolve(staging, "pnpm-workspace.yaml");
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^supportedArchitectures\s*:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() !== "" && /^\S/.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  writeFileSync(p, out.join("\n"));
  console.log("[release] 已移除 pnpm-workspace.yaml 的 supportedArchitectures（跨平台安装）");
}

// ---------------------------------------------------------------------------
step(`1/${totalSteps} 全量构建（pnpm build）`);
// Next.js production build 会加载全部 server 路由（含 db 连接的 api 路由），为避免
// 构建阶段模块顶层副作用触发 DB 连接，这里给占位 env。运行时真实值由 start.ts 设置。
const prev = {};
for (const [k, v] of Object.entries({
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
step(`2/${totalSteps} 组装发布目录`);
rmForce(staging);
mkdirSync(staging, { recursive: true });

// monorepo 根配置（install 需要）
copy("package.json");
copy("pnpm-workspace.yaml");
copy("pnpm-lock.yaml");
copy("turbo.json");
copy(".env.example"); // 目标机配置参考（.env 需自行创建）
// 轻量包在目标机执行 pnpm install 时需要 .npmrc：registry 与 better-sqlite3 预编译
// 二进制镜像，否则会回退 node-gyp 源码编译（要求 VS C++ 工具链）。
copy(".npmrc");

// 轻量包需跨平台安装，移除会按构建机平台过滤依赖的 supportedArchitectures
if (!withDeps) stripSupportedArchitectures();

// workspace 包：源码 + dist + schema.sql（start.ts 启动时幂等建表）
copy("packages/shared/package.json", "packages/shared/package.json");
copy("packages/shared/dist", "packages/shared/dist");
copy("packages/shared/sql", "packages/shared/sql");
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
// web/.next：production next({ dev: false }) 依赖；filter 排除 .next/dev
// （dev 模式构建缓存，可达数百 MB，曾因 rmSync 在 Windows 上未删净导致发布包暴涨到 261MB）
//
// .next/node_modules 必须打进去：Next.js 把 external 化的原生模块（better-sqlite3）
// 以「内容哈希别名」链接在此（better-sqlite3-<hash> → .pnpm 真实目录），
// 服务端 chunk 通过该别名 require，缺了会报
// "Failed to load external module better-sqlite3-<hash>"。
// 但它是 pnpm 符号链接/junction，直接 cpSync 会尝试解引用 →
// 在 Windows 上目标解析失败会抛 ENOENT 中断整个打包。
// 故先单独 rm 掉，再用 dereference:true 拷贝成真实目录（保留原哈希名——
// chunk 里写死的 require 别名就是 better-sqlite3-<hash>，改名反而会解析失败）；
// 随后再补上其运行时依赖闭包（见 copyNativeDepClosure）。
const webNextSrc = resolve(root, "web", ".next");
if (existsSync(webNextSrc)) {
  cpSync(webNextSrc, resolve(staging, "web", ".next"), {
    recursive: true,
    filter: (src) => {
      if (src.startsWith(resolve(webNextSrc, "dev"))) return false;
      // 先跳过 .next/node_modules，稍后单独解引用拷贝
      const nm = resolve(webNextSrc, "node_modules");
      if (src === nm || src.startsWith(nm + sep)) return false;
      return true;
    },
  });

  // 单独把 .next/node_modules 解引用成真实目录（内含 better-sqlite3-<hash>）
  const srcNm = resolve(webNextSrc, "node_modules");
  if (existsSync(srcNm)) {
    const destNm = resolve(staging, "web", ".next", "node_modules");
    for (const entry of readdirSync(srcNm)) {
      const src = resolve(srcNm, entry);
      const dest = resolve(destNm, entry);
      try {
        cpSync(src, dest, { recursive: true, dereference: true });
        console.log(`[release] .next 外部模块已固化: ${entry}`);
      } catch (e) {
        // 解引用失败不致命：完整包（hoisted 扁平布局）下根 node_modules 有真实副本，
        // 记录后继续，避免因单个可选外部模块中断整个打包。
        console.warn(
          `[release] .next 外部模块固化失败（将从根 node_modules 解析）: ${entry} — ${e?.message ?? e}`,
        );
      }
    }
    // 包本体（better-sqlite3-<hash>）不含依赖链，必须补上运行时依赖闭包
    copyNativeDepClosure(destNm);
  }
}
rmForce(resolve(staging, "web", ".next", "dev"));

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
    "rem Machora Standalone 启动（生产模式，零 tsx 依赖，零 ORM CLI 调用）",
    "set NODE_ENV=production",
    "node standalone\\dist\\start.js",
    "",
  ].join("\r\n"),
);
writeFileSync(
  resolve(staging, "start.sh"),
  [
    "#!/bin/sh",
    "# Machora Standalone 启动（生产模式，零 tsx 依赖，零 ORM CLI 调用）",
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
    "单进程 LLM 可观测平台：SQLite（嵌入式，无外部服务）+ Next.js 生产构建。",
    "",
    withDeps
      ? "形态：完整包（含 node_modules，解压即用，仅限 " + process.platform + " " + process.arch + " 平台）"
      : "形态：轻量包（源码 + 构建产物，需目标机有 pnpm）",
    "",
    "环境要求：Node.js >= 20" + (withDeps ? "" : "、pnpm（>= 9）"),
    "",
    withDeps ? "无需安装依赖，解压后直接启动。" : "安装依赖：\n  pnpm install --frozen-lockfile",
    withDeps
      ? ""
      : "（.npmrc 已随包提供 registry 与 better-sqlite3 预编译镜像；若镜像仍不可达，\n   可在安装前设置 npm_config_better_sqlite3_binary_host_mirror 指向可用镜像）",
    "",
    "启动（生产模式，默认 http://localhost:3100）：",
    "  Windows: start.cmd",
    "  POSIX : ./start.sh",
    "",
    "常用环境变量（可选）：",
    "  PORT    Web 端口，默认 3100",
    "  DATA_DIR 数据目录（相对当前工作目录），默认 ./.machora-data",
    "",
    "环境变量：应用根目录存在 .env 时自动加载（可参考 .env.example 复制改名）。",
    "",
    withDeps ? "" : "开发模式（热重载）：\n  pnpm dev\n",
    "数据说明：SQLite 数据库文件位于 <解压目录>/.machora-data/machora.db，删除即清空。",
    "",
    "Schema 初始化：表结构定义在 packages/shared/sql/schema.sql（幂等建表），",
    "启动时直接 exec，无需任何 ORM CLI / 数据库服务。",
    "",
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// [--with-deps] 在 staging 现场装运行时依赖。
// --node-linker=hoisted：npm 扁平布局，无符号链接，避免 tar 解引用导致 zip 体积翻倍。
// --prod：跳过 typescript/vitest/tsx 等 dev 工具，只装运行时依赖。
// 裁掉 @next/swc（SWC 编译器，仅 dev build 用）、@img/sharp（Next.js 图片优化，未启用）、
// typescript（@trpc peerDep，运行时不需要）。
let afterSchemaStep = withDeps ? 4 : 3;
if (withDeps) {
  step(`3/${totalSteps} 安装运行时依赖（hoisted + prod）`);
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
  ];
  for (const t of trimTargets) {
    const p = resolve(nmDir, t);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  // workspace 包链接固化：pnpm 的 hoisted 布局把 @machora/* 链接放在各子包的
  // node_modules 下（Windows 上是 Junction），System32 tar 打 zip 时不解引用
  // junction，解压后链接变成空目录 → 运行时 Cannot find module '@machora/shared'。
  // 先把子包 node_modules 删掉（仅含 @machora junction），否则 cpSync 复制
  // workspace 包时会解引用 junction 按相对路径找目标 → ENOENT；同时避免把
  // 空壳 junction 打进 zip。再把 workspace 包以真实目录复制到根
  // node_modules/@machora/（Node 从任何子包向上解析 node_modules 都能命中）。
  for (const sub of ["standalone", "web", "worker"]) {
    const subNm = resolve(staging, sub, "node_modules");
    if (existsSync(subNm)) rmSync(subNm, { recursive: true, force: true });
  }
  mkdirSync(resolve(nmDir, "@machora"), { recursive: true });
  const workspaceCopies = [
    ["@machora/shared", "packages/shared"],
    ["@machora/worker", "worker"],
  ];
  for (const [pkg, src] of workspaceCopies) {
    const dest = resolve(nmDir, pkg);
    rmSync(dest, { recursive: true, force: true });
    cpSync(resolve(staging, src), dest, { recursive: true });
  }
  // 固化到根 node_modules/@machora/ 的副本内部，pnpm 可能残留嵌套的 workspace
  // 依赖（如 worker 的 @machora/shared 未被提升，复制时被解引用成真实目录）；
  // 顶层已有 @machora/shared，嵌套副本纯冗余，删除。
  for (const pkg of ["shared", "worker"]) {
    const nestedNm = resolve(nmDir, "@machora", pkg, "node_modules");
    if (existsSync(nestedNm)) rmSync(nestedNm, { recursive: true, force: true });
  }
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
  console.log("[release] 已裁剪 @next/swc、@img/sharp、typescript（生产运行不需要）");
  afterSchemaStep = 4;
}

// ---------------------------------------------------------------------------
step(`${afterSchemaStep}/${totalSteps} 打包 zip`);
// pnpm install / tar 可能在 staging 顶层残留空目录（如 _），打包前显式清掉，
// 避免 zip 混入垃圾条目。_ 目录忽略空判断强制删除（来源不明，仅为空壳）。
for (const d of readdirSync(staging)) {
  const p = resolve(staging, d);
  if (d === "_") {
    rmSync(p, { recursive: true, force: true });
    console.log(`[release] 已清理 staging 残留空目录: ${d}`);
  } else if (existsSync(p) && statSync(p).isDirectory() && readdirSync(p).length === 0) {
    rmSync(p, { recursive: true, force: true });
    console.log(`[release] 已清理 staging 空目录: ${d}`);
  }
}
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
// 打包后复查 staging 顶层，确认 tar 未重新创建残留空目录（如 _）。
const leftover = readdirSync(staging).filter((d) => {
  const p = resolve(staging, d);
  return existsSync(p) && statSync(p).isDirectory() && readdirSync(p).length === 0;
});
if (leftover.length > 0) {
  console.warn(`[release] 打包后 staging 仍有空目录: ${leftover.join(", ")}（可能由 tar 创建）`);
}

// ---------------------------------------------------------------------------
step(`${totalSteps}/${totalSteps} 完成`);
console.log(`\n  发布包: ${zipPath}`);
console.log(`  大小  : ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  形态  : ${withDeps ? "完整包（含 node_modules，解压即用）" : "轻量包（目标机需 pnpm install）"}`);
console.log(`  平台  : ${process.platform} ${process.arch}（完整包仅同平台可用）`);
console.log("");
console.log("关键特性（SQLite 版）：");
console.log("  ✓ 运行时零 ORM CLI / engines（drizzle-orm + better-sqlite3，嵌入式无外部服务）");
console.log("  ✓ schema.sql 幂等建表，启动直接 exec（无存量库迁移逻辑）");
console.log("");
console.log("发布指引：");
if (withDeps) {
  console.log("  解压 zip → start.cmd（Windows）/ ./start.sh（POSIX）即可运行，无需 pnpm install");
} else {
  console.log("  解压 zip → pnpm install --frozen-lockfile → start.cmd");
}
console.log("  （发布形态仅完整应用发布包；npm/pip 发布已放弃）");
