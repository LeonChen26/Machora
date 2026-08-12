"use client";

// 评估配置表单（client）：新建 LLM judge / 规则评估器配置
import { useTransition, useState } from "react";

export interface EvalConfigRow {
  id: string;
  name: string;
  evaluatorType: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
}

const TYPE_OPTIONS = [
  { value: "llm", label: "LLM judge（模型打分）" },
  { value: "error", label: "规则：ERROR 检测" },
  { value: "latency", label: "规则：耗时阈值" },
  { value: "cost", label: "规则：成本阈值" },
  { value: "token", label: "规则：Token 阈值" },
  { value: "tag", label: "规则：标签匹配" },
];

export function EvalConfigForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const evaluatorType = String(fd.get("evaluatorType") || "");
    setError(null);

    startTransition(async () => {
      const config: Record<string, unknown> = {};
      if (evaluatorType === "llm") {
        config.model = String(fd.get("model") || "").trim();
        config.apiKey = String(fd.get("apiKey") || "").trim();
        const apiBase = String(fd.get("apiBase") || "").trim();
        if (apiBase) config.apiBase = apiBase;
        const prompt = String(fd.get("systemPrompt") || "").trim();
        if (prompt) config.systemPrompt = prompt;
        const includeTrajectory = String(fd.get("includeTrajectory") || "on");
        config.includeTrajectory = includeTrajectory === "on";
        if (!config.model || !config.apiKey) {
          setError("LLM judge 需要填写模型名与 API Key");
          return;
        }
      } else {
        const threshold = String(fd.get("threshold") || "").trim();
        if (threshold) {
          if (evaluatorType === "latency") config.thresholdMs = Number(threshold);
          else if (evaluatorType === "cost") config.thresholdUsd = Number(threshold);
          else if (evaluatorType === "token") config.thresholdTokens = Number(threshold);
        }
        const tag = String(fd.get("tag") || "").trim();
        if (evaluatorType === "tag" && tag) config.tag = tag;
      }

      const res = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "config",
          name: String(fd.get("name") || "").trim(),
          evaluatorType,
          config,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        form.reset();
        window.location.reload();
      } else {
        setError(data.error ?? "创建失败");
      }
    });
  }

  return (
    <div className="card mb-3">
      <div className="label mb-1">新建评估配置</div>
      <form onSubmit={onSubmit} className="form-inline">
        <input
          name="name"
          required
          placeholder="配置名（如 helpfulness）"
          maxLength={60}
          className="input"
          style={{ flex: 1, minWidth: 140 }}
        />
        <select name="evaluatorType" defaultValue="llm" className="select" style={{ minWidth: 160 }}>
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          name="model"
          placeholder="模型（LLM judge）"
          className="input"
          style={{ flex: 1, minWidth: 120 }}
        />
        <input
          name="apiKey"
          placeholder="API Key（LLM judge）"
          type="password"
          className="input"
          style={{ flex: 1, minWidth: 140 }}
        />
        <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
          {pending && <span className="spinner" aria-hidden="true" />}
          {pending ? "创建中…" : "创建"}
        </button>
      </form>
      <div className="form-inline mt-2">
        <input
          name="apiBase"
          placeholder="API 端点（可选，默认 https://api.openai.com/v1）"
          className="input"
          style={{ flex: 1 }}
        />
        <input
          name="systemPrompt"
          placeholder="系统提示词（可选，覆盖内置模板）"
          className="input"
          style={{ flex: 2 }}
        />
        <label className="form-inline" style={{ alignItems: "center", gap: 6 }}>
          <input type="checkbox" name="includeTrajectory" defaultChecked style={{ width: 16, height: 16 }} />
          <span className="text-sm">注入轨迹摘要</span>
        </label>
        <input
          name="threshold"
          placeholder="规则阈值（如 5000）"
          className="input"
          style={{ width: 120 }}
        />
        <input
          name="tag"
          placeholder="标签（tag 规则）"
          className="input"
          style={{ width: 110 }}
        />
      </div>
      {error && (
        <div className="form-error" role="alert">{error}</div>
      )}
    </div>
  );
}
