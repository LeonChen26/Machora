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
  const { selectedId } = useSelection();

  if (selectedId === null) {
    return (
      <div className="obs-detail-panel">
        <div className="obs-panel-head">
          <span className="mute2">Trace</span>
          <span className="spacer" />
        </div>
        <div className="obs-detail-card">{children}</div>
      </div>
    );
  }
  return <ObservationDetailPanel observations={observations} />;
}
