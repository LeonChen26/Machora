"use client";

// Trace 详情评分 Tab：自动评估入口（选择启用配置 → 触发评估任务）
import { useTransition, useState } from "react";

export interface EvalConfigOption {
  id: string;
  name: string;
  evaluatorType: string;
}

export function EvalRunPanel({
  traceId,
  configs,
}: {
  traceId: string;
  configs: EvalConfigOption[];
}) {
  const [selected, setSelected] = useState<string>(configs[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    const cfg = configs.find((c) => c.id === selected);
    if (!cfg) return;
    setMsg(null);
    startTransition(async () => {
      const res = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "run",
          traceId,
          name: cfg.name,
          evaluatorType: cfg.evaluatorType,
          configId: cfg.id,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ ok: true, text: `已触发「${cfg.name}」评估，完成后将出现在下方评分列表` });
        // 轮询刷新（worker 同进程，通常秒级完成）
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setMsg({ ok: false, text: data.error ?? "触发失败" });
      }
    });
  }

  if (configs.length === 0) {
    return (
      <div className="card mb-2 text-sm muted">
        暂无启用的评估配置。可前往「评估」页创建 LLM judge 或规则配置后，在此一键评估当前 Trace。
      </div>
    );
  }

  return (
    <div className="card mb-2">
      <div className="form-title">自动评估</div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">评估配置</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="select"
          >
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
          {pending ? "评估中…" : "运行评估"}
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
