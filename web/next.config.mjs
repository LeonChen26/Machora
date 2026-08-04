// Machora Next.js 配置（ESM，避免 type:module 下 next.config.ts 的 TS 编译输出格式不一致）
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @prisma/client 由运行时从项目 node_modules 直接加载，不打包进 .next：
  // Turbopack 若把其复制为 web/.next/node_modules 下的唯一化副本，副本内
  // require('.prisma/client/default') 在全新环境（发布包）解析不到生成的 client。
  serverExternalPackages: ["@prisma/client"],

  // 固定 Turbopack 的 workspace root：发布包（staging）里若误带 pnpm-workspace.yaml，
  // Next.js 会向父目录遍历找 workspace root，可能跨越到解压目标目录外的其他项目，
  // 导致找不到 web/app。明确指定当前项目根即可避免跨目录推断。
  experimental: {
    /** @type {any} */
    turbopack: { root: projectRoot },
  },
};

export default nextConfig;
