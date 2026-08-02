"use client";

// JSON 折叠块：默认收起超过阈值的 JSON，支持展开/收起与一键复制。
import { useState } from "react";
import { CopyButton } from "./CopyButton";

const COLLAPSE_LINES = 25;

export function JsonBlock({
  title,
  json,
  bare = false,
}: {
  title: string;
  json: string;
  bare?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = json.split("\n").length;
  const collapsible = lines > COLLAPSE_LINES;
  const visible = expanded ? json : collapsible ? json.split("\n").slice(0, COLLAPSE_LINES).join("\n") : json;

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: 4 }}>
      <span className="mute2" style={{ fontSize: 11 }}>
        {title}
      </span>
      <span className="spacer" />
      {collapsible && (
        <button
          type="button"
          className="btn-sm"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "收起" : `展开全部（${lines} 行）`}
        </button>
      )}
      <CopyButton text={json} />
    </div>
  );

  const body = (
    <pre
      className="json-view"
      style={{
        margin: 0,
        maxHeight: expanded ? undefined : 320,
        overflow: expanded ? "auto" : "hidden",
        position: "relative",
      }}
    >
      {visible}
      {collapsible && !expanded && (
        <span
          style={{
            display: "block",
            position: "sticky",
            bottom: 0,
            textAlign: "center",
            color: "var(--accent)",
            fontSize: 12,
            padding: "4px 0",
            background: "var(--bg-elev-2)",
            cursor: "pointer",
          }}
          onClick={() => setExpanded(true)}
        >
          ▼ 展开 {lines} 行
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
