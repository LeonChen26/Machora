import type { AnchorHTMLAttributes } from "react";

// 原生 <a> 包装：本应用为纯服务端渲染（全部 force-dynamic），无需 next/link 的
// 客户端路由与 RSC 预取（后者会产生 ?_rsc= 请求，快速导航时被 abort 打噪音日志）。
// 显式过滤 prefetch prop，避免透传给原生 <a>。
export function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean },
) {
  const { prefetch: _ignore, ...rest } = props;
  return <a {...rest} />;
}
