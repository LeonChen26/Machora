// 标注打分表单（client）：对当前 trace / 选中 observation 提交评分
"use client";

import { useState } from "react";

export interface ScoreTarget {
  id: string;
  name: string;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elev-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 13,
  padding: "0.4rem 0.5rem",
};

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
    <form
      onSubmit={submit}
      className="card"
      style={{ marginBottom: "0.75rem" }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: "0.5rem" }}>
        标注评分（ANNOTATION）
      </div>
      <div
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            目标
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={inputStyle}
          >
            <option value="trace">当前 Trace</option>
            {observations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name || o.id}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            名称
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如 satisfaction"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            类型
          </span>
          <select
            value={dataType}
            onChange={(e) =>
              setDataType(e.target.value as typeof dataType)
            }
            style={inputStyle}
          >
            <option value="NUMERIC">NUMERIC</option>
            <option value="CATEGORICAL">CATEGORICAL</option>
            <option value="BOOLEAN">BOOLEAN</option>
          </select>
        </label>
        {dataType === "NUMERIC" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="mute2" style={{ fontSize: 12 }}>
              数值
            </span>
            <input
              type="number"
              step="any"
              value={numValue}
              onChange={(e) => setNumValue(e.target.value)}
              style={{ ...inputStyle, width: 90 }}
            />
          </label>
        )}
        {dataType === "CATEGORICAL" && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="mute2" style={{ fontSize: 12 }}>
              类别值
            </span>
            <input
              value={catValue}
              onChange={(e) => setCatValue(e.target.value)}
              placeholder="如 good / bad"
              style={inputStyle}
            />
          </label>
        )}
        {dataType === "BOOLEAN" && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingBottom: "0.4rem",
            }}
          >
            <input
              type="checkbox"
              checked={boolValue}
              onChange={(e) => setBoolValue(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            <span style={{ fontSize: 13 }}>{boolValue ? "通过 ✓" : "不通过 ✗"}</span>
          </label>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            备注
          </span>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="可选"
            style={inputStyle}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "提交中..." : "打分"}
        </button>
      </div>
      {error && (
        <div
          style={{
            marginTop: "0.5rem",
            color: "var(--red)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
    </form>
  );
}
