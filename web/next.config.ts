import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// next.config.{ts|mjs} 的 ESM 目录 = web/ 项目根
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);

// turbopack.root 是 Next/Turbopack 运行时支持的配置，但当前 @types/next
// 的 ExperimentalConfig 未同步该字段声明，因此在顶层对象做一次显式断言。
const nextConfig = {
  // @prisma/client 由运行时从项目 node_modules 直接加载，不打包进 .next：
  // Turbopack 若把其复制为 web/.next/node_modules 下的唯一化副本，副本内
  // require('.prisma/client/default') 在全新环境（发布包）解析不到生成的 client。
  serverExternalPackages: ["@prisma/client"],

  // 固定 Turbopack 的 workspace root：发布包（staging）里若误带 pnpm-workspace.yaml，
  // Next.js 会向父目录遍历找 workspace root，可能跨越到解压目标目录外的其他项目，
  // 导致找不到 web/app。明确指定当前项目根即可避免跨目录推断。
  experimental: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    turbopack: { root: projectRoot } as any,
  },
} as NextConfig;

export default nextConfig;
