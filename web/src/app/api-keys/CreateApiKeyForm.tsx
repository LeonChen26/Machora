"use client";

import { useTransition, useState } from "react";
import { CopyButton } from "../../components/CopyButton";

export interface CreatedKey {
  id: string;
  name: string | null;
  publicKey: string;
  secretKey: string;
}

export function CreateApiKeyForm({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 先捕获 form 引用：e.currentTarget 在事件处理器结束后会被 React 置为 null，
    // 而 reset() 在异步回调里调用，届时 currentTarget 已失效
    const form = e.currentTarget;
    const formData = new FormData(form);
    setError(null);
    setCreated(null);
    startTransition(async () => {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          projectId: formData.get("projectId"),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreated(data.key);
        form.reset();
      } else {
        setError(data.error ?? "创建失败");
      }
    });
  }

  return (
    <div className="card mb-3">
      <div className="label mb-1">
        创建 API Key
      </div>
      <form onSubmit={onSubmit} className="form-inline">
        <input
          name="name"
          placeholder="名称（可选），如：生产环境"
          maxLength={60}
          className="input"
          style={{ flex: 1, minWidth: 200 }}
        />
        <select name="projectId" required className="select" defaultValue="">
          <option value="" disabled>
            选择项目…
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {pending ? "创建中…" : "创建"}
        </button>
      </form>

      {error && (
        <div className="form-error" role="alert">{error}</div>
      )}

      {created && (
        <div className="card alert-success mt-3">
          <div className="form-success">
            创建成功 — Secret Key 仅显示这一次，请立即保存
          </div>
          <div className="mb-1">
            <span className="mute2 text-sm">
              PUBLIC KEY
            </span>
            <div className="key-row">
              <code className="mono">{created.publicKey}</code>
              <CopyButton text={created.publicKey} />
            </div>
          </div>
          <div>
            <span className="mute2 text-sm">
              SECRET KEY（不再展示）
            </span>
            <div className="key-row">
              <code className="mono">{created.secretKey}</code>
              <CopyButton text={created.secretKey} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
