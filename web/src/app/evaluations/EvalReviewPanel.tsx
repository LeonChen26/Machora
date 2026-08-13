"use client";

// 评估任务人工评审（client）：展示 LLM judge 结果（value/reasoning），
// 人工确认或改分 → 以 ANNOTATION source 写回 Score（评审意见 + 原评估理由）
import { useState } from "react";

export interface ReviewTask {
  id: string;
  traceId: string | null;
  name: string;
  evaluatorType: string;
  status: string;
  result: Record<string, unknown> | null;
}

function fmtValue(result: Record<string, unknown> | null): string {
  const v = result?.value;
  if (typeof v !== "number") return "—";
  return result?.dataType === "BOOLEAN" ? (v ? "✓ 通过" : "✗ 不通过") : v.toFixed(3);
}

export function EvalReviewButton({ task }: { task: ReviewTask }) {
  const [open, setOpen] = useState(false);
  // 数据集任务无 traceId，无法写回 Score，禁用评审
  const canReview = Boolean(task.traceId) && task.status === "COMPLETED";
  const [value, setValue] = useState(() =>
    typeof task.result?.value === "number" ? String(task.result.value) : "0.5",
  );
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const dataType = (task.result?.dataType as string | undefined) ?? "NUMERIC";
    let num: number;
    if (dataType === "BOOLEAN") {
      num = value === "1" ? 1 : 0;
    } else {
      num = Number.parseFloat(value);
      if (Number.isNaN(num)) {
        setMsg({ ok: false, text: "评审值需为数字" });
        return;
      }
    }
    const reasoning = (task.result?.reasoning as string | undefined) ?? (task.result?.comment as string | undefined);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/scores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          traceId: task.traceId,
          name: task.name,
          value: num,
          dataType,
          source: "ANNOTATION",
          comment: [
            comment.trim() ? `[评审] ${comment.trim()}` : "",
            reasoning ? `[评估理由] ${reasoning}` : "",
          ]
            .filter(Boolean)
            .join("\n") || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: data.error ?? `提交失败（${res.status}）` });
        return;
      }
      setMsg({ ok: true, text: "评审已写入该 Trace 的评分（ANNOTATION）" });
      setOpen(false);
      window.location.reload();
    } catch {
      setMsg({ ok: false, text: "网络错误，请重试" });
    } finally {
      setBusy(false);
    }
  }

  if (!canReview) return null;

  return (
    <>
      <button type="button" className="btn-sm" onClick={() => setOpen((v) => !v)}>
        评审
      </button>
      {open && (
        <div className="card mt-1" style={{ border: "1px solid var(--border)", padding: 10 }}>
          <div className="text-xs" style={{ marginBottom: 6 }}>
            <span className="muted">评估结果：</span>
            <span className="mono">{fmtValue(task.result)}</span>
            {task.result?.reasoning ? (
              <div className="muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                {String(task.result.reasoning)}
              </div>
            ) : null}
          </div>
          <div className="form-inline" style={{ flexWrap: "wrap" }}>
            <label className="field">
              <span className="field-label">
                {task.result?.dataType === "BOOLEAN" ? "评审判定" : "评审分数"}
              </span>
              {task.result?.dataType === "BOOLEAN" ? (
                <select value={value} onChange={(e) => setValue(e.target.value)} className="select">
                  <option value="1">通过 ✓</option>
                  <option value="0">不通过 ✗</option>
                </select>
              ) : (
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="input"
                  style={{ width: 90 }}
                />
              )}
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span className="field-label">评审备注</span>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="input"
                placeholder="如：分数偏高，实际回答有遗漏"
              />
            </label>
            <button
              type="button"
              className="btn primary"
              onClick={submit}
              disabled={busy}
              aria-busy={busy}
              style={{ alignSelf: "flex-end" }}
            >
              {busy && <span className="spinner" aria-hidden="true" />}
              提交评审
            </button>
          </div>
          {msg && (
            <div className={`form-${msg.ok ? "success" : "error"} text-sm`} role={msg.ok ? "status" : "alert"}>
              {msg.text}
            </div>
          )}
        </div>
      )}
    </>
  );
}
