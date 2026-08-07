"use client";

// 右侧详情面板（对齐 Langfuse TracePanelDetail）：
// 未选中任何 observation（等价"选中根 trace"）→ 渲染 trace 级详情
// （children，由服务端传入的 JSX）；选中某个 observation → 渲染
// ObservationDetailPanel。取消选中（select(null)）即可回到 Trace 详情。

import type { ReactNode } from "react";
import { useSelection } from "./contexts";
import {
  ObservationDetailPanel,
  type ObservationView,
} from "../ObservationDetailPanel";

export function TraceDetailPanel({
  observations,
  children,
}: {
  observations: ObservationView[];
  children: ReactNode;
}) {
  const { selectedId, panelOpen, setPanelOpen } = useSelection();

  // 面板收起时不渲染任何内容（含 ObservationDetailPanel）：
  // 避免其"选中失效时兜底选第一条"的 effect 自动展开详情
  if (!panelOpen) return null;

  if (selectedId === null) {
    return (
      <div className="obs-detail-panel">
        <div className="obs-panel-head">
          <span className="mute2">Trace</span>
          <span className="spacer" />
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
        <div className="obs-detail-card">{children}</div>
      </div>
    );
  }
  return <ObservationDetailPanel observations={observations} />;
}
