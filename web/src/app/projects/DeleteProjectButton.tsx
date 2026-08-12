"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { PROJECT_COOKIE } from "../../lib/project";

export function DeleteProjectButton({
  id,
  name,
  isCurrent,
}: {
  id: string;
  name: string;
  isCurrent: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onDelete() {
    if (
      !confirm(
        `确定删除项目「${name}」？\n该项目的所有 Traces / Observations / Scores / API Keys 将一并删除，且不可恢复。`,
      )
    )
      return;
    startTransition(async () => {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
        if (isCurrent) {
          // 删除的是当前项目：清掉 cookie，让页面回退到第一个项目
          document.cookie = `${PROJECT_COOKIE}=; path=/; max-age=0`;
        }
        router.refresh();
      } else {
        alert(`删除失败: ${data.error ?? "未知错误"}`);
      }
    });
  }

  return (
    <button
      type="button"
      className="btn btn-danger"
      onClick={onDelete}
      disabled={pending}
    >
      {pending ? "删除中…" : "删除"}
    </button>
  );
}
