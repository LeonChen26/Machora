"use client";

// Trace 详情视图共享状态（参照 Langfuse SelectionContext）：
// 选中节点 id 外置到 context，调用树 / 时间线 / 详情面板三处联动；
// 变更写回 URL ?selected=，刷新 / 分享可恢复，切换 Tab 保留选中。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** 服务端拍平后的调用树行（渲染所需计算值全部在服务端算好，client 只做展示） */
export type TraceRow = {
  id: string;
  name: string | null;
  type: string;
  level: string | null;
  model: string | null;
  depth: number;
  start: number; // epoch ms
  end: number | null; // epoch ms
  dur: number; // ms
  left: number; // 时间轴条位置（%）
  width: number; // 时间轴条宽度（%）
  barColor: string;
  typeColor: string;
};

const SelectionCtx = createContext<{
  selectedId: string | null;
  select: (id: string | null) => void;
} | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  // 初始选中：URL ?selected=（刷新 / 分享可恢复）；无则 null，面板兜底选第一条
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("selected");
  });

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    // 写回 URL（history.replaceState 不触发 RSC 重跑，保留 tab/issues 参数）
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("selected", id);
    else url.searchParams.delete("selected");
    window.history.replaceState(null, "", url);
  }, []);

  const value = useMemo(() => ({ selectedId, select }), [selectedId, select]);
  return <SelectionCtx.Provider value={value}>{children}</SelectionCtx.Provider>;
}

export function useSelection() {
  const v = useContext(SelectionCtx);
  if (!v) throw new Error("useSelection must be used within SelectionProvider");
  return v;
}
