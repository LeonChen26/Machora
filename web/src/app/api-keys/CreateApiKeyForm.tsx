"use client";

import { useTransition, useState } from "react";
import { CopyButton } from "../../components/CopyButton";

export interface CreatedKey {
  id: string;
  name: string | null;
  publicKey: string;
  secretKey: string;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "0.4rem 0.6rem",
  fontSize: 13,
  fontFamily: "inherit",
};

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
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="label" style={{ marginBottom: 8 }}>
        创建 API Key
      </div>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          name="name"
          placeholder="名称（可选），如：生产环境"
          maxLength={60}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
        <select name="projectId" required style={inputStyle} defaultValue="">
          <option value="" disabled>
            选择项目…
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? "创建中…" : "创建"}
        </button>
      </form>

      {error && (
        <div style={{ color: "var(--red)", marginTop: 8, fontSize: 13 }}>{error}</div>
      )}

      {created && (
        <div
          className="card"
          style={{
            marginTop: 12,
            borderColor: "var(--green)",
            background: "rgba(52, 211, 153, 0.06)",
          }}
        >
          <div style={{ color: "var(--green)", fontWeight: 600, marginBottom: 4 }}>
            创建成功 — Secret Key 仅显示这一次，请立即保存
          </div>
          <div style={{ marginBottom: 6 }}>
            <span className="mute2" style={{ fontSize: 12 }}>
              PUBLIC KEY
            </span>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <code className="mono">{created.publicKey}</code>
              <CopyButton text={created.publicKey} />
            </div>
          </div>
          <div>
            <span className="mute2" style={{ fontSize: 12 }}>
              SECRET KEY（不再展示）
            </span>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <code className="mono">{created.secretKey}</code>
              <CopyButton text={created.secretKey} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
