import type { NextConfig } from "next";
import { resolve } from "node:path";

// 本目录是 machora/web，monorepo 根在其上一级。
// 项目嵌在 langfuse 仓库内（该仓库也有 pnpm-workspace.yaml），
// Next.js 推断 workspace root 时会选错到 langfuse 根，这里显式指定。
const nextConfig: NextConfig = {
  // @machora/shared 是 workspace TS 源码（main 指向 src/index.ts），必须让 Next 编译它
  transpilePackages: ["@machora/shared"],
  turbopack: {
    root: resolve(import.meta.dirname, ".."),
  },
};

export default nextConfig;
