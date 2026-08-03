import type { ReactNode } from "react";
import { Link } from "./NativeLink";

export type PagerJump = {
  action: string;
  page: number;
  totalPages: number;
  hidden: ReactNode;
};

/**
 * 统一分页条：offset（page）与 cursor 两种模式共用。
 * prevHref/nextHref/firstHref 为空时对应按钮不渲染（统一用条件渲染，不用假禁用）。
 */
export function Pager({
  info,
  firstHref,
  prevHref,
  nextHref,
  jump,
}: {
  info: ReactNode;
  firstHref?: string;
  prevHref?: string;
  nextHref?: string;
  jump?: PagerJump;
}) {
  return (
    <div className="pager">
      <span className="info">{info}</span>
      <div className="btn-group">
        {firstHref && (
          <Link className="btn-sm" href={firstHref} prefetch={false}>
            ← 首页
          </Link>
        )}
        {prevHref && (
          <Link className="btn-sm" href={prevHref} prefetch={false}>
            ← 上一页
          </Link>
        )}
        {jump && (
          <form action={jump.action} method="get" className="form-inline">
            {jump.hidden}
            <input
              type="number"
              name="page"
              min={1}
              max={jump.totalPages}
              defaultValue={jump.page}
              className="input-page-jump"
              aria-label="跳转到页码"
            />
            <button type="submit" className="btn-sm">
              跳转
            </button>
          </form>
        )}
        {nextHref && (
          <Link className="btn-sm" href={nextHref} prefetch={false}>
            下一页 →
          </Link>
        )}
      </div>
    </div>
  );
}
