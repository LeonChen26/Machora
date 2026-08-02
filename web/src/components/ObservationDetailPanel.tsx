"use client";

// 选中详览面板：点表格行（data-obs）选中一条 observation，面板只展示该条。
// 调用链很长时不再把所有 observation 卡片平铺，避免详情区无限变长。
import { useCallback, useEffect, useState } from "react";
import { formatCost, formatDateTime, formatTokens } from "../lib/format";
import { JsonBlock } from "./JsonBlock";
import { prettyJson } from "../lib/format";

export type ObservationView = {
  id: string;
  name: string | null;
  type: string;
  level: string | null;
  model: string | null;
  startTime: string; // ISO
  endTime: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  totalCost: number | null;
  input: unknown;
  output: unknown;
  usage: unknown;
  metadata: unknown;
};

function syncRowHighlight(id: string | null) {
  document.querySelectorAll<HTMLElement>("[data-obs].selected").forEach((n) => {
    n.classList.remove("selected");
  });
  if (id == null) return;
  const row = Array.from(
    document.querySelectorAll<HTMLElement>("[data-obs]"),
  ).find((n) => n.dataset.obs === id);
  row?.classList.add("selected");
}

export function ObservationDetailPanel({
  observations,
}: {
  observations: ObservationView[];
}) {
  const [idx, setIdx] = useState(0);

  // 点击表格行选中（事件委托，行是服务端渲染的静态 DOM）
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-obs]");
      if (!el) return;
      const i = observations.findIndex((o) => o.id === el.dataset.obs);
      if (i < 0) return;
      syncRowHighlight(observations[i].id);
      setIdx(i);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [observations]);

  // 挂载后默认高亮第一条
  useEffect(() => {
    syncRowHighlight(observations[0]?.id ?? null);
  }, [observations]);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, observations.length - 1));
      syncRowHighlight(observations[clamped].id);
      setIdx(clamped);
    },
    [observations],
  );

  if (observations.length === 0) {
    return <div className="card empty">该 Trace 下暂无 Observation。</div>;
  }
  const o = observations[idx];

  return (
    <div className="obs-detail-panel">
      <div className="obs-panel-head">
        <span className="mute2">
          {idx + 1} / {observations.length}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn-sm"
          onClick={() => go(idx - 1)}
          disabled={idx <= 0}
        >
          ‹ 上一个
        </button>
        <button
          type="button"
          className="btn-sm"
          onClick={() => go(idx + 1)}
          disabled={idx >= observations.length - 1}
        >
          下一个 ›
        </button>
      </div>
      <div className="card obs-detail-card">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <strong>{o.name || o.id}</strong>
          <span
            className={`badge ${o.type === "GENERATION" ? "purple" : o.type === "SPAN" ? "blue" : "amber"}`}
          >
            {o.type}
          </span>
        </div>
        <div className="mono mute2" style={{ fontSize: 11, marginBottom: 8 }}>
          {o.model ? `${o.model} · ` : ""}
          {formatDateTime(o.startTime)}
          {o.endTime ? ` → ${formatDateTime(o.endTime)}` : ""}
        </div>
        {o.totalTokens != null && o.totalTokens > 0 && (
          <div style={{ marginBottom: 6, fontSize: 12 }}>
            <span className="mono">
              {formatTokens(o.inputTokens)} in / {formatTokens(o.outputTokens)} out
            </span>
            <span className="mono" style={{ color: "var(--green)", marginLeft: 8 }}>
              {formatCost(o.totalCost)}
            </span>
          </div>
        )}
        {o.input != null && (
          <JsonBlock title="INPUT" json={prettyJson(o.input)} bare />
        )}
        {o.output != null && (
          <JsonBlock title="OUTPUT" json={prettyJson(o.output)} bare />
        )}
        {o.usage != null && (
          <JsonBlock title="USAGE" json={prettyJson(o.usage)} bare />
        )}
        {o.metadata != null && (
          <JsonBlock title="METADATA" json={prettyJson(o.metadata)} bare />
        )}
        {o.input == null && o.output == null && o.usage == null && o.metadata == null && (
          <div className="mute2">无 input/output</div>
        )}
      </div>
    </div>
  );
}
