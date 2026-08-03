// 标注打分表单（client）：对当前 trace / 选中 observation 提交评分
"use client";

import { useState } from "react";

export interface ScoreTarget {
  id: string;
  name: string;
}

export default function ScoreForm({
  traceId,
  observations,
}: {
  traceId: string;
  observations: ScoreTarget[];
}) {
  const [target, setTarget] = useState("trace");
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState<"NUMERIC" | "CATEGORICAL" | "BOOLEAN">(
    "NUMERIC",
  );
  const [numValue, setNumValue] = useState("0.5");
  const [catValue, setCatValue] = useState("");
  const [boolValue, setBoolValue] = useState(true);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("请填写评分名称");
      return;
    }
    let value: number;
    if (dataType === "NUMERIC") {
      const n = Number.parseFloat(numValue);
      if (Number.isNaN(n)) {
        setError("数值评分必须是数字");
        return;
      }
      value = n;
    } else if (dataType === "BOOLEAN") {
      value = boolValue ? 1 : 0;
    } else {
      if (!catValue.trim()) {
        setError("请填写类别值");
        return;
      }
      // CATEGORICAL 值存字符串；value 字段兜底 0（展示层按字符串渲染）
      value = 0;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          traceId: target === "trace" ? traceId : null,
          observationId: target === "trace" ? null : target,
          name: name.trim(),
          value,
          dataType,
          source: "ANNOTATION",
          comment: comment.trim() || null,
          ...(dataType === "CATEGORICAL" ? { comment: `${catValue.trim()}${comment.trim() ? ` | ${comment.trim()}` : ""}` } : {}),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? `提交失败（${res.status}）`);
        return;
      }
      // SSR 页面：刷新展示新评分
      window.location.reload();
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mb-2">
      <div className="form-title">
        标注评分（ANNOTATION）
      </div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">目标</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="select"
          >
            <option value="trace">当前 Trace</option>
            {observations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name || o.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 satisfaction"
            className="input"
          />
        </label>
        <label className="field">
          <span className="field-label">类型</span>
          <select
            value={dataType}
            onChange={(e) =>
              setDataType(e.target.value as typeof dataType)
            }
            className="select"
          >
            <option value="NUMERIC">NUMERIC</option>
            <option value="CATEGORICAL">CATEGORICAL</option>
            <option value="BOOLEAN">BOOLEAN</option>
          </select>
        </label>
        {dataType === "NUMERIC" && (
          <label className="field">
            <span className="field-label">数值</span>
            <input
              type="number"
              step="any"
              value={numValue}
              onChange={(e) => setNumValue(e.target.value)}
              className="input"
              style={{ width: 90 }}
            />
          </label>
        )}
        {dataType === "CATEGORICAL" && (
          <label className="field">
            <span className="field-label">类别值</span>
            <input
              value={catValue}
              onChange={(e) => setCatValue(e.target.value)}
              placeholder="如 good / bad"
              className="input"
            />
          </label>
        )}
        {dataType === "BOOLEAN" && (
          <label className="form-inline" style={{ alignItems: "center", gap: 6, paddingBottom: "0.4rem" }}>
            <input
              type="checkbox"
              checked={boolValue}
              onChange={(e) => setBoolValue(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <span className="text-md">{boolValue ? "通过 ✓" : "不通过 ✗"}</span>
          </label>
        )}
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">备注</span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="可选"
            className="input"
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "提交中..." : "打分"}
        </button>
      </div>
      {error && (
        <div className="form-error text-sm" role="alert">{error}</div>
      )}
    </form>
  );
}
