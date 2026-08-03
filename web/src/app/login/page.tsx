"use client";

import { useState, type FormEvent } from "react";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.href = next && next.startsWith("/") ? next : "/";
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `登录失败（${res.status}）`);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-overlay">
      <form className="card login-card" onSubmit={onSubmit} aria-label="登录表单">
        <div className="login-brand">
          <img src="/icon.jpg" alt="" className="logo-img" />
          <div className="login-title">Machora</div>
          <div className="muted">AI Agent 可观测平台</div>
        </div>

        <label className="field" htmlFor="login-email">
          <span className="field-label">邮箱</span>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@machora.local"
            autoComplete="username"
            required
            aria-invalid={!!error}
          />
        </label>

        <label className="field" htmlFor="login-password">
          <span className="field-label">密码</span>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
            aria-invalid={!!error}
          />
        </label>

        {error && <div className="login-error" role="alert">{error}</div>}

        <button className="btn primary" type="submit" disabled={loading} aria-busy={loading}>
          {loading && <span className="spinner" aria-hidden="true" />}
          {loading ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
