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
 */
export function SignalList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) return null;

  return (
    <div className="signal-list">
      {signals.map((s) => {
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
          </div>
        );
      })}
    </div>
  );
}
