"use client";

import { useEffect, useState } from "react";
import { Link } from "./NativeLink";
import type { Signal, SignalKind, SignalScope } from "../server/signals";

const KIND_LABEL: Record<SignalKind, string> = {
  error: "错误",
  cost: "成本",
  latency: "延迟",
  loop: "循环",
  long_task: "长任务",
};

const SCOPE_LABEL: Record<SignalScope, string> = {
  global: "全局",
  agent: "Agent",
  model: "模型",
  trace: "Trace",
};

/** 作用域徽标配色（global / trace 为聚合口径，用纯文本表示） */
const SCOPE_BADGE: Record<SignalScope, string | null> = {
  global: null,
  agent: "green",
  model: "purple",
  trace: null,
};

/**
 * 统一信号列表：待关注面板与各页异常渲染的唯一实现。
 * 输入为 signals.ts 产出的 Signal[]，本组件不做任何阈值判断。
 * 传入 dismissKey 时启用「忽略」：被忽略的信号 id 记在 localStorage，可一键恢复。
 */
export function SignalList({
  signals,
  dismissKey,
}: {
  signals: Signal[];
  dismissKey?: string;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!dismissKey) return;
    try {
      const raw = localStorage.getItem(dismissKey);
      if (raw) setDismissed(JSON.parse(raw) as string[]);
    } catch {
      /* localStorage 不可用时静默降级为「不忽略」 */
    }
    setMounted(true);
  }, [dismissKey]);

  const persist = (next: string[]) => {
    setDismissed(next);
    if (!dismissKey) return;
    try {
      localStorage.setItem(dismissKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  if (signals.length === 0) return null;

  // 首帧仍渲染全部信号（与服务端一致，避免 hydration 不一致），挂载后再过滤
  const canDismiss = Boolean(dismissKey) && mounted;
  const hiddenIds = new Set(dismissed);
  const visible = canDismiss
    ? signals.filter((s) => !hiddenIds.has(s.id))
    : signals;
  const hiddenCount = canDismiss
    ? signals.filter((s) => hiddenIds.has(s.id)).length
    : 0;

  return (
    <>
      {visible.length > 0 ? (
        <div className="signal-list">
          {visible.map((s) => {
            const badgeCls = SCOPE_BADGE[s.scope];
            const text = (
              <>
                <span className="signal-title">{s.title}</span>
                <span className="signal-detail">{s.detail}</span>
              </>
            );
            return (
              <div key={s.id} className="signal-item" data-severity={s.severity}>
                <span className="signal-dot" aria-hidden="true" />
                <span className={`badge ${s.severity === "high" ? "red" : "amber"}`}>
                  {KIND_LABEL[s.kind]}
                </span>
                {s.scopeName && badgeCls ? (
                  <span className={`badge ${badgeCls}`}>{s.scopeName}</span>
                ) : (
                  <span className="mute2 text-xs">{SCOPE_LABEL[s.scope]}</span>
                )}
                <span className="signal-body">
                  {s.href ? (
                    <Link href={s.href} prefetch={false}>
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                </span>
                {dismissKey && (
                  <button
                    type="button"
                    className="signal-dismiss"
                    title="忽略该信号（仅记录在本机浏览器）"
                    onClick={() => persist([...dismissed, s.id])}
                  >
                    忽略
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mute2 text-sm">全部信号已被忽略（仅本机）。</div>
      )}

      {hiddenCount > 0 && (
        <div className="form-inline mt-2">
          <span className="mute2 text-xs">已忽略 {hiddenCount} 项</span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => persist([])}
          >
            恢复全部
          </button>
        </div>
      )}
    </>
  );
}
