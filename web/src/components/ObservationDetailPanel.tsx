"use client";

// 选中详览面板：选中态来自 SelectionContext（调用树 / 时间线点击联动），
// 面板只展示选中的一条 observation，不再平铺，避免详情区无限变长。
import { useCallback, useEffect, useMemo } from "react";
import { formatCost, formatDateTime, formatTokens } from "../lib/format";
import { JsonBlock } from "./JsonBlock";
import { prettyJson } from "../lib/format";
import { MessageView } from "./trace/MessageView";
import { useSelection } from "./trace/contexts";

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

export function ObservationDetailPanel({
  observations,
}: {
  observations: ObservationView[];
}) {
  const { selectedId, select, setPanelOpen } = useSelection();

  // 选中 id → 在 observations 中的索引（不在列表内则为 -1）
  const idx = useMemo(
    () => observations.findIndex((o) => o.id === selectedId),
    [observations, selectedId],
  );

  // 默认选中第一条：选中态缺失或已失效时兜底（保留原行为）。
  // selectedId 为 null 是"选中根 trace"的合法状态（显示 Trace 详情），不兜底。
  useEffect(() => {
    if (observations.length === 0) return;
    if (selectedId !== null && idx < 0) select(observations[0].id);
  }, [idx, observations, select, selectedId]);

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, observations.length - 1));
      select(observations[clamped].id);
    },
    [observations, select],
  );

  if (observations.length === 0) {
    return (
      <div className="obs-detail-panel">
        <div className="obs-panel-head">
          <span className="mute2">0 / 0</span>
          <span className="spacer" />
        </div>
        <div className="obs-detail-card">
          <div className="mute2" style={{ padding: "1rem 0" }}>暂无 Observation 详情。</div>
        </div>
      </div>
    );
  }
  // 选中态未就绪（useEffect 兜底选第一条前的瞬间）
  if (idx < 0) {
    return (
      <div className="obs-detail-panel">
        <div className="obs-panel-head">
          <span className="mute2">—</span>
          <span className="spacer" />
        </div>
        <div className="obs-detail-card">
          <div className="mute2" style={{ padding: "1rem 0" }}>加载中…</div>
        </div>
      </div>
    );
  }
  const o = observations[idx];

  return (
    <div className="obs-detail-panel">
      <div className="obs-panel-head">
        <button
          type="button"
          className="btn-sm"
          onClick={() => select(null)}
          title="返回 Trace 详情"
        >
          ← Trace
        </button>
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
        <button
          type="button"
          className="btn-sm"
          onClick={() => setPanelOpen(false)}
          title="隐藏详情，左侧铺满"
          aria-label="隐藏详情"
        >
          ✕
        </button>
      </div>
      <div className="obs-detail-card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap", marginBottom: 6 }}>
          <strong>{o.name || o.id}</strong>
          <span
            className={`badge ${o.type === "GENERATION" ? "purple" : o.type === "SPAN" ? "blue" : "amber"}`}
          >
            {o.type === "GENERATION" ? "GEN" : o.type}
          </span>
        </div>
        <div className="mono mute2 text-xs" style={{ marginBottom: 6 }}>
          {o.model ? `${o.model} · ` : ""}
          {formatDateTime(o.startTime)}
          {o.endTime ? ` → ${formatDateTime(o.endTime)}` : ""}
        </div>
        {o.totalTokens != null && o.totalTokens > 0 && (
          <div className="text-sm" style={{ marginBottom: 6 }}>
            <span className="mono">
              {formatTokens(o.inputTokens)} in / {formatTokens(o.outputTokens)} out
            </span>
            <span className="mono cost" style={{ marginLeft: 8 }}>
              {formatCost(o.totalCost)}
            </span>
          </div>
        )}
        {o.input != null && (
          <MessageView title="INPUT" value={o.input} />
        )}
        {o.output != null && (
          <MessageView title="OUTPUT" value={o.output} />
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
