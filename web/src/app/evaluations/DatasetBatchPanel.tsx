"use client";

// 数据集批量评测（client）：选 tag（或低分回流）→ 选配置 → 批量触发评估
import { useTransition, useState } from "react";

export interface DatasetTag {
  tag: string;
  count: number;
}

export interface DatasetConfig {
  id: string;
  name: string;
  evaluatorType: string;
}

export function DatasetBatchPanel({
  tags,
  configs,
}: {
  tags: DatasetTag[];
  configs: DatasetConfig[];
}) {
  const [mode, setMode] = useState<"tag" | "lowscore">("tag");
  const [tag, setTag] = useState<string>(tags[0]?.tag ?? "");
  const [configId, setConfigId] = useState<string>(configs[0]?.id ?? "");
  const [maxScore, setMaxScore] = useState("0.3");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    if (!configId) {
      setMsg({ ok: false, text: "请先创建并启用一个评估配置" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const body: Record<string, unknown> = { configId };
      if (mode === "tag") {
        if (!tag) {
          setMsg({ ok: false, text: "请选择数据集（tag）" });
          return;
        }
        body.tag = tag;
      } else {
        const s = Number.parseFloat(maxScore);
        if (Number.isNaN(s)) {
          setMsg({ ok: false, text: "阈值需为数字" });
          return;
        }
        body.maxScore = s;
      }
      const res = await fetch("/api/evaluations/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ ok: true, text: `已触发 ${data.count} 条评估任务（${data.total} 条目标），完成后可在「任务」Tab 查看` });
      } else {
        setMsg({ ok: false, text: data.error ?? "批量评估失败" });
      }
    });
  }

  if (tags.length === 0) {
    return (
      <div className="card text-sm muted">
        暂无带标签的 trace。给 trace 打上 tag 后即可作为数据集批量评测。
      </div>
    );
  }

  return (
    <div className="card mb-3">
      <div className="form-title">批量评测</div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">数据来源</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="select">
            <option value="tag">按 tag（数据集）</option>
            <option value="lowscore">低分 Trace 回流（score &lt; 阈值）</option>
          </select>
        </label>
        {mode === "tag" ? (
          <label className="field">
            <span className="field-label">数据集（tag）</span>
            <select value={tag} onChange={(e) => setTag(e.target.value)} className="select">
              {tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  {t.tag}（{t.count}）
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="field">
            <span className="field-label">分数阈值</span>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={maxScore}
              onChange={(e) => setMaxScore(e.target.value)}
              className="input"
              style={{ width: 100 }}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">评估配置</span>
          <select value={configId} onChange={(e) => setConfigId(e.target.value)} className="select">
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.evaluatorType === "llm" ? "LLM" : "规则"}）
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn primary"
          onClick={run}
          disabled={pending}
          aria-busy={pending}
          style={{ alignSelf: "flex-end" }}
        >
          {pending && <span className="spinner" aria-hidden="true" />}
          {pending ? "批量评估中…" : "批量评测"}
        </button>
      </div>
      {msg && (
        <div
          className={`form-${msg.ok ? "success" : "error"} text-sm`}
          role={msg.ok ? "status" : "alert"}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
