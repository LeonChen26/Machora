"use client";

// Trace 详情视图共享状态（参照 Langfuse SelectionContext）：
// 选中节点 id 外置到 context，调用树 / 时间线 / 详情面板三处联动；
// 变更写回 URL ?selected=，刷新 / 分享可恢复，切换 Tab 保留选中。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TrajectoryKind } from "@machora/shared";

/** 服务端拍平后的调用树行（渲染所需计算值全部在服务端算好，client 只做展示） */
export type TraceRow = {
  id: string;
  name: string | null;
  type: string;
  level: string | null;
  model: string | null;
  /** 轨迹角色（ENTRY/AGENT/STEP/LLM/TOOL 等），用于调用树徽标着色（与推理拓扑图复用同一色板） */
  kind: TrajectoryKind;
  /** round / step / repeat 等结构化小标题（从 name 正则提取或从 kind+metadata 推断），用作 pill 徽章；空则不显示 */
  pill: string | null;
  totalTokens: number | null;
  totalCost: number | null;
  /** 首 Token 时间（ms），无则 null */
  ttftMs: number | null;
  depth: number;
  dur: number; // ms
  left: number; // 时间轴条位置（%）
  width: number; // 时间轴条宽度（%）
  /** 存在子节点（有 children）→ 可折叠；client 渲染 ± 按钮 */
  container: boolean;
  /** 直接子节点数量（折叠时显示 N 个隐藏子） */
  childrenCount: number;
};

const SelectionCtx = createContext<{
  selectedId: string | null;
  select: (id: string | null) => void;
  /** 详情面板是否展开（默认收起，左侧铺满；点击 span 展开；可隐藏） */
  panelOpen: boolean;
  /** 展开 / 隐藏详情面板 */
  setPanelOpen: (open: boolean) => void;
} | null>(null);

// 选中 id 的同会话兜底：Tab Link 导航（RSC）会让 Provider 重挂载，
// 此时 URL 可能已被导航丢弃 ?selected=，从 sessionStorage 恢复避免丢选中
const ssKey = () => `machora:trace-selected:${window.location.pathname}`;

export function SelectionProvider({ children }: { children: ReactNode }) {
  // 初始恒为 null/false：SSR 与客户端首帧一致，避免 hydration mismatch
  // （惰性初始化读 window 会导致服务端 null、客户端有值，行选中 class 对不上）。
  // 真实选中/展开在 mount 后从 URL ?selected= / sessionStorage 恢复。
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState<boolean>(false);

  // mount 后恢复选中：URL ?selected=（刷新/分享恢复，展开面板）>
  // sessionStorage 兜底（Tab 导航丢 URL 时恢复选中行，但保持面板收起）
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("selected");
    if (fromUrl) {
      setSelectedId(fromUrl);
      setPanelOpen(true);
      return;
    }
    try {
      const ss = sessionStorage.getItem(ssKey());
      if (ss) setSelectedId(ss);
    } catch {
      // sessionStorage 不可用时忽略（如隐私模式），URL 兜底
    }
  }, []);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    // 点击 span（选中具体行）自动展开详情面板；select(null) 回 trace 详情保持展开
    if (id) setPanelOpen(true);
    // 写回 URL（history.replaceState 不触发 RSC 重跑，保留 tab/issues 参数）
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("selected", id);
    else url.searchParams.delete("selected");
    window.history.replaceState(null, "", url);
    try {
      if (id) sessionStorage.setItem(ssKey(), id);
      else sessionStorage.removeItem(ssKey());
    } catch {
      // sessionStorage 不可用时忽略（如隐私模式），URL 兜底
    }
  }, []);

  const value = useMemo(
    () => ({ selectedId, select, panelOpen, setPanelOpen }),
    [selectedId, select, panelOpen],
  );
  return <SelectionCtx.Provider value={value}>{children}</SelectionCtx.Provider>;
}

export function useSelection() {
  const v = useContext(SelectionCtx);
  if (!v) throw new Error("useSelection must be used within SelectionProvider");
  return v;
}

/**
 * 左树右详情布局（对齐 AgentLoop）：默认收起详情面板，左侧铺满；
 * 点击 span 展开（panelOpen=true），隐藏后恢复铺满。
 * 面板显隐通过 .panel-open class 切换 grid 列，收起时不渲染 panel-col。
 */
export function SelectionLayout({ children }: { children: ReactNode }) {
  const { panelOpen } = useSelection();
  return (
    <div className={`tree-layout${panelOpen ? " panel-open" : ""}`}>{children}</div>
  );
}
