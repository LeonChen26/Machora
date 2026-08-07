"use client";

// 调用树（AgentLoop 风格升级版 v4 / 极简现代）：
// 1. 无树杈线，仅用缩进表达层级，视觉干净。
// 2. 折叠按钮为圆角方块 + chevron 图标，常态浅灰底，hover 品牌色。
// 3. 行高 36px，名称列单行，model / tokens / id 等 meta 移入 title tooltip。
// 4. 两列布局：名称/类型 + 耗时；与时间线视图共享同一套五色族徽标。

import { useCallback, useMemo, useState } from "react";
import { useSelection, type TraceRow } from "./contexts";
import { formatDuration, formatTokens } from "../../lib/format";
import type { TrajectoryKind } from "@machora/shared";

const ROW_H = 36;
const OVERSCAN = 10;

/** 12 kind → 5 色族（和 TrajectoryGraph 视觉复用） */
type Fam = "entry" | "agent" | "step" | "llm" | "tool";
const FAM_OF_KIND: Record<TrajectoryKind, Fam> = {
  entry: "entry",
  agent: "agent",
  workflow: "agent",
  think: "step",
  retrieval: "step",
  memory: "step",
  skill: "step",
  llm: "llm",
  embedding: "llm",
  tool: "tool",
  event: "step",
  other: "step",
};

// 五色板来自 globals.css 的 --fam-* 变量（基色 + color-mix 软底随主题深浅），
// 与 TrajectoryGraph 节点 / 图例 / 时间线条保持同族同色。

const FAM_LABEL: Record<Fam, string> = {
  entry: "ENTRY",
  agent: "AGENT",
  step: "STEP",
  llm: "LLM",
  tool: "TOOL",
};

const KIND_SUB: Record<TrajectoryKind, string> = {
  entry: "入口",
  agent: "Agent",
  workflow: "工作流",
  think: "思考",
  retrieval: "检索",
  memory: "记忆",
  skill: "技能",
  llm: "模型",
  embedding: "嵌入",
  tool: "工具",
  event: "日志",
  other: "其他",
};

export function TraceTree({ rows }: { rows: TraceRow[] }) {
  const { selectedId, select } = useSelection();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [w0, setW0] = useState(0);
  const [w1, setW1] = useState(() => Math.min(rows.length, 30));

  /** 折叠可见过滤（先序扫描，折叠祖先时隐藏其后代） */
  const filtered = useMemo(() => {
    const out: TraceRow[] = [];
    let hideUntilDepth = -1;
    for (const r of rows) {
      if (r.depth <= hideUntilDepth) hideUntilDepth = -1;
      if (hideUntilDepth >= 0) continue;
      out.push(r);
      if (r.container && collapsed.has(r.id)) hideUntilDepth = r.depth;
    }
    return out;
  }, [rows, collapsed]);

  /** 窗口虚拟化：基于 filtered 再切窗口 */
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const from = Math.floor(el.scrollTop / ROW_H);
      const count = Math.ceil(el.clientHeight / ROW_H);
      setW0(Math.max(0, from - OVERSCAN));
      setW1(Math.min(filtered.length, from + count + OVERSCAN));
    },
    [filtered.length],
  );
  const visible = useMemo(() => filtered.slice(w0, w1), [filtered, w0, w1]);

  const toggle = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      e.preventDefault();
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [],
  );

  return (
    <div className="table-wrap tree-virtual tree-v4" onScroll={onScroll}>
      <table>
        <colgroup>
          <col className="col-name" style={{ width: "var(--col-name-w, 70%)" }} />
          <col className="col-dur" style={{ width: "var(--col-dur-w, 30%)" }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" style={{ width: "var(--col-name-w, 70%)" }}>名称 / 类型</th>
            <th scope="col" style={{ width: "var(--col-dur-w, 30%)" }}>耗时</th>
          </tr>
        </thead>
        <tbody>
          {w0 > 0 && (
            <tr aria-hidden="true" className="spacer" style={{ height: w0 * ROW_H }}>
              <td colSpan={2} />
            </tr>
          )}
          {visible.map((o) => {
            const fam = FAM_OF_KIND[o.kind];
            const bg = `var(--fam-${fam}-bg)`;
            const fg = `var(--fam-${fam})`;
            const label = FAM_LABEL[fam];
            const sub = KIND_SUB[o.kind];
            const sel = selectedId === o.id;
            const isErr = o.level === "ERROR";
            const isWarn = o.level === "WARNING";
            const isCollapsed = collapsed.has(o.id);
            const metaTip = [
              `类型: ${label} · ${sub}`,
              o.model && `模型: ${o.model}`,
              o.totalTokens && `Tokens: ${formatTokens(o.totalTokens)}`,
              `ID: ${o.id}`,
            ]
              .filter(Boolean)
              .join("\n");

            return (
              <tr
                key={o.id}
                data-obs={o.id}
                data-level={o.level ?? undefined}
                className={`tree-row${sel ? " selected" : ""}${isErr ? " is-error" : ""}${isWarn ? " is-warn" : ""}`}
                tabIndex={0}
                onClick={() => select(o.id)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  select(o.id);
                }}
                style={{ height: ROW_H }}
              >
                <td>
                  <div className="obs-cell v4" title={metaTip || undefined}>
                    {o.depth > 0 && (
                      <span
                        className="tree-guides"
                        aria-hidden="true"
                        // 仅做层级缩进占位（width = depth * 16），v4 不再绘制树杈线
                        style={{ width: o.depth * 16 }}
                      />
                    )}

                    {/* 左侧分类徽标（圆角矩形色块，白字族标签）— 名字列内容最左侧 */}
                    <span
                      className={`k-badge k-${fam}`}
                      style={{ background: bg, color: fg, borderColor: fg }}
                      aria-label={`分类 ${label} ${sub}`}
                    >
                      {label}
                    </span>

                    {/* 折叠按钮 / 占位（紧跟 k-badge 右侧，leaf 时仍占位 16px 对齐） */}
                    {o.container ? (
                      <button
                        className={`coll-btn ${isCollapsed ? "collapsed" : "expanded"} in-name-col`}
                        aria-label={isCollapsed ? "展开子节点" : "折叠子节点"}
                        onClick={(e) => toggle(e, o.id)}
                        title={
                          isCollapsed
                            ? `展开（隐藏的 ${o.childrenCount} 个直接子节点）`
                            : `折叠（收起 ${o.childrenCount} 个直接子节点）`
                        }
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" className="chevron" aria-hidden="true">
                          <polyline
                            points="2,3 5,6 8,3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    ) : (
                      <span className="coll-btn placeholder in-name-col" aria-hidden="true" />
                    )}

                    {/* 异常级别小圆点（ERROR 红 / WARNING 琥珀） */}
                    {isErr && <span className="status-dot danger" title="ERROR" />}
                    {!isErr && isWarn && <span className="status-dot warn" title="WARNING" />}

                    {/* 名称（主标题） */}
                    <span className="obs-name" title={o.name ?? undefined}>
                      {o.name || <span className="mute2">（未命名）</span>}
                    </span>

                    {/* round / step pill */}
                    {o.pill && (
                      <span className="pill-step" title={o.pill}>
                        {o.pill}
                      </span>
                    )}

                    {/* 折叠态徽标：折叠后显示「+ N 个子」 badge */}
                    {isCollapsed && (
                      <span className="badge coll-count" title={`${o.childrenCount} 个子节点已折叠`}>
                        +{o.childrenCount}
                      </span>
                    )}

                    {/* 第一行末尾附加：TTFT 小字 */}
                    {o.ttftMs && (
                      <span className="tag-ttft" title={`TTFT ${formatDuration(o.ttftMs)}`}>
                        TTFT {formatDuration(o.ttftMs)}
                      </span>
                    )}
                  </div>
                </td>

                {/* 第二列：耗时数字（居中，垂直居中） */}
                <td className="dur-col">
                  <span className="dur-mono mono">{formatDuration(o.dur)}</span>
                </td>

              </tr>
            );
          })}
          {filtered.length - w1 > 0 && (
            <tr aria-hidden="true" className="spacer" style={{ height: (filtered.length - w1) * ROW_H }}>
              <td colSpan={2} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
