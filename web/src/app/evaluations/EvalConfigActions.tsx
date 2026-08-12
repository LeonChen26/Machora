"use client";

// 评估配置操作（client）：启用/停用、删除、测试运行（对最新一条 trace 触发评估）
import { useTransition, useState } from "react";

export interface EvalConfigRow {
  id: string;
  name: string;
  evaluatorType: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
}

export function EvalConfigActions({
  row,
}: {
  row: EvalConfigRow;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  function toggleEnabled() {
    startTransition(async () => {
      const res = await fetch("/api/evaluations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, enabled: !row.enabled }),
      });
      if (res.ok) {
        setError(null);
        window.location.reload();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "操作失败");
      }
    });
  }

  function remove() {
    if (!window.confirm(`删除配置「${row.name}」？`)) return;
    startTransition(async () => {
      const res = await fetch(`/api/evaluations?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setError(null);
        window.location.reload();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "删除失败");
      }
    });
  }

  function testRun() {
    startTransition(async () => {
      setTestMsg(null);
      setError(null);
      const res = await fetch("/api/evaluations/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configId: row.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestMsg(data.message ?? "测试完成");
      } else {
        setError(data?.error ?? "测试失败");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={testRun}
        disabled={pending}
        aria-busy={pending}
      >
        ▶ 测试
      </button>
      <button
        type="button"
        className="btn"
        onClick={toggleEnabled}
        disabled={pending}
      >
        {row.enabled ? "停用" : "启用"}
      </button>
      <button
        type="button"
        className="btn danger"
        onClick={remove}
        disabled={pending}
      >
        删除
      </button>
      {testMsg && <span className="mute2 text-sm">{testMsg}</span>}
      {error && <span className="form-error text-sm">{error}</span>}
    </>
  );
}
