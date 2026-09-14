// Machora Next.js 配置（ESM，避免 type:module 下 next.config.ts 的 TS 编译输出格式不一致）
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 是原生模块（.node 二进制），不能被打包，必须保持 external：
  // Next/Turbopack 会把它复制为 web/.next/node_modules/better-sqlite3-<hash>/，
  // 但该副本不含依赖链（bindings / file-uri-to-path），发布环境会
  // Cannot find module 'bindings'。故发布打包时必须把依赖闭包一并固化，
  // 见 scripts/release.mjs 的 copyNativeDepClosure()。
  //
  // 固定 Turbopack 的 workspace root（Next 16 顶层配置）：源码仓库里 next 等
  // 依赖位于仓库根 node_modules/.pnpm（web 外），root 必须指向仓库根，
  // 否则 Turbopack 从 app 目录向上解析 next/package.json 时越过 root 边界失败。
  turbopack: { root: resolve(projectRoot, "..") },
};

export default nextConfig;
