"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function DeleteApiKeyButton({ id, label }: { id: string; label: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onDelete() {
    if (!confirm(`确定删除 API Key「${label}」？该 key 将立即失效。`)) return;
    startTransition(async () => {
      const res = await fetch(`/api/keys?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (res.ok) {
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
