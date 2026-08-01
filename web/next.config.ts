import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @prisma/client 由运行时从项目 node_modules 直接加载，不打包进 .next：
  // Turbopack 若把其复制为 web/.next/node_modules 下的唯一化副本，副本内
  // require('.prisma/client/default') 在全新环境（发布包）解析不到生成的 client。
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
