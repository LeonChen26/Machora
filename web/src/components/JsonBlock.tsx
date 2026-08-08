"use client";

// JSON 折叠块：默认收起超过阈值的 JSON，支持展开/收起与一键复制。
import { type ReactNode, useState } from "react";
import { CopyButton } from "./CopyButton";

const COLLAPSE_LINES = 25;
// 单行超长（如超长字符串/超大数字）按行数不触发折叠，需追加字符数阈值
const COLLAPSE_CHARS = 4000;

export function JsonBlock({
  title,
  json,
  bare = false,
  headerExtra,
}: {
  title: string;
  json: string;
  bare?: boolean;
  // 头部扩展按钮（如"返回视图"），渲染在展开/收起按钮左侧
  headerExtra?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = json.split("\n").length;
  const collapsible = lines > COLLAPSE_LINES || json.length > COLLAPSE_CHARS;
  const visible = expanded
    ? json
    : collapsible
      ? lines > COLLAPSE_LINES
        ? json.split("\n").slice(0, COLLAPSE_LINES).join("\n")
        : json.slice(0, COLLAPSE_CHARS)
      : json;
  const summary =
    lines > COLLAPSE_LINES
      ? `${lines} 行`
      : `${json.length.toLocaleString()} 字符`;

  const header = (
    <div className="json-head">
      <span className="mute2 text-xs">
        {title}
      </span>
      <span className="spacer" />
      {headerExtra}
      {collapsible && (
        <button
          type="button"
          className="btn-sm"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "收起" : `展开全部（${summary}）`}
        </button>
      )}
      <CopyButton text={json} />
    </div>
  );

  const body = (
    <pre
      className={expanded ? "json-view" : "json-view collapsed"}
      style={{
        margin: 0,
        // 展开后不限高，交由外层容器统一滚动，避免嵌套滚动导致内容看不全
        ...(expanded ? { maxHeight: "none", overflow: "visible" } : {}),
      }}
    >
      {visible}
      {collapsible && !expanded && (
        <span
          className="text-sm"
          style={{
            display: "block",
            position: "sticky",
            bottom: 0,
            textAlign: "center",
            color: "var(--accent)",
            padding: "4px 0",
            background: "var(--bg-elev-2)",
            cursor: "pointer",
          }}
          onClick={() => setExpanded(true)}
        >
          ▼ 展开 {summary}
        </span>
      )}
    </pre>
  );

  return bare ? (
    <div style={{ marginBottom: 6 }}>
      {header}
      {body}
    </div>
  ) : (
    <div className="card">{header}{body}</div>
  );
}
