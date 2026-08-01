"use client";

import { useRouter } from "next/navigation";
import { PROJECT_COOKIE } from "../../lib/project";

// 切换当前项目并进入 Traces 列表（设置 cookie 后整页导航，刷新全量服务端数据）
export function EnterProjectButton({ id }: { id: string }) {
  const router = useRouter();

  function onEnter() {
    document.cookie = `${PROJECT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
    router.push("/traces");
  }

  return (
    <button type="button" className="btn primary" onClick={onEnter}>
      查看 Traces →
    </button>
  );
}
