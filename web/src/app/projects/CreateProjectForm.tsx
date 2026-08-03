"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateProjectForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 先捕获 form 引用：e.currentTarget 在事件处理器结束后会被 React 置为 null，
    // 而 reset() 在异步回调里调用，届时 currentTarget 已失效
    const form = e.currentTarget;
    const formData = new FormData(form);
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: formData.get("name") }),
      });
      const data = await res.json();
      if (res.ok) {
        form.reset();
        router.refresh();
      } else {
        setError(data.error ?? "创建失败");
      }
    });
  }

  return (
    <div className="card mb-3">
      <div className="label mb-1">
        创建项目
      </div>
      <form onSubmit={onSubmit} className="form-inline">
        <input
          id="new-project-name"
          name="name"
          placeholder="项目名称，如：生产环境"
          maxLength={60}
          required
          className="input"
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {pending ? "创建中…" : "创建"}
        </button>
      </form>
      {error && (
        <div className="form-error" role="alert">{error}</div>
      )}
    </div>
  );
}
