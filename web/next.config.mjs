// Machora Next.js 配置（ESM，避免 type:module 下 next.config.ts 的 TS 编译输出格式不一致）
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg 在 Next 内置默认 serverExternalPackages 列表中（config 只能追加不能移除），
  // 会被 Turbopack 复制为 web/.next/node_modules/pg-<hash>/ 的外部副本，但副本不带
  // 依赖链（pg-types 等）→ 发布环境 Cannot find module 'pg-types'。
  // 用 transpilePackages 把 pg 从默认外部列表摘除，改为直接打进 server bundle。
  transpilePackages: ["pg"],
  // 纯 JS 驱动（pg/drizzle）直接打包进 .next，不 external：
  // Turbopack 的 serverExternalPackages 只复制包本体，pg 的依赖链
  // （pg-types 等）不随副本携带 → 发布环境 Cannot find module 'pg-types'。
  // 固定 Turbopack 的 workspace root（Next 16 顶层配置）：源码仓库里 next 等
  // 依赖位于仓库根 node_modules/.pnpm（web 外），root 必须指向仓库根，
  // 否则 Turbopack 从 app 目录向上解析 next/package.json 时越过 root 边界失败。
  turbopack: { root: resolve(projectRoot, "..") },
};

export default nextConfig;
