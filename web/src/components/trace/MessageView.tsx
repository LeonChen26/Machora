"use client";

// Trace 详情页 Input/Output 消息视图（AgentLoop 风格）：
// 识别 role 语义并逐条独立渲染——单条 {role, parts|content} 或 {messages:[...]} 消息数组。
// - text / content 字符串 → 正文块（pre-wrap）
// - tool_use / tool_calls → 函数调用卡片（函数名徽标 + 可折叠参数 JSON）
// - tool_result → 工具结果 mono 块（带 tool_call_id）
// - image → 图片缩略占位
// 无消息语义（如 {"city":"Beijing"}）→ 回退 JsonBlock，原始 JSON 不受影响。

import { useState } from "react";
import { prettyJson } from "../../lib/format";
import { JsonBlock } from "../JsonBlock";
import { CopyButton } from "../CopyButton";

type ContentPart = Record<string, unknown>;
type ToolCall = { id?: string; function?: { name?: string; arguments?: unknown } };
type Msg = {
  role?: string;
  content?: unknown;
  parts?: ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  [k: string]: unknown;
};

const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "模型",
  system: "系统",
  tool: "工具",
  developer: "开发者",
  function: "函数",
};

/** role → CSS 变量色（主题自适应，与全站 --role-* 变量一致） */
function roleVar(role: string): string {
  const map: Record<string, string> = {
    user: "var(--role-user)",
    assistant: "var(--role-assistant)",
    system: "var(--role-system)",
    tool: "var(--role-tool)",
    developer: "var(--role-developer)",
    function: "var(--role-tool)",
  };
  return map[role] ?? "var(--text-dim)";
}

/** 探测消息语义：单条 {role,...} / {messages:[...]} / OpenAI {choices:[{message}]} */
export function detectMessageShape(value: unknown): "message" | "messages" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.messages) && v.messages.length > 0) return "messages";
  if (typeof v.role === "string" && v.role.length > 0) return "message";
  if (Array.isArray(v.choices) && extractChoices(v.choices).length > 0) return "messages";
  return null;
}

/** 从 OpenAI {choices:[{message}]} 提取消息 */
function extractChoices(choices: unknown[]): Msg[] {
  const out: Msg[] = [];
  for (const c of choices) {
    const message = (c as Record<string, unknown> | null)?.message;
    if (message && typeof (message as Record<string, unknown>).role === "string") {
      out.push(message as Msg);
    }
  }
  return out;
}

/** 提取消息列表：messages 数组 / 单条 role / choices[].message；无则 null */
function extractMessages(value: unknown): Msg[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.messages) && v.messages.length > 0) {
    return v.messages.map((m) => (m ?? {}) as Msg);
  }
  if (typeof v.role === "string" && v.role.length > 0) return [v as Msg];
  if (Array.isArray(v.choices)) {
    const msgs = extractChoices(v.choices);
    if (msgs.length > 0) return msgs;
  }
  return null;
}

// 超长正文折叠阈值
const COLLAPSE_CHARS = 1600;

function TextBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const collapsible = text.length > COLLAPSE_CHARS;
  const visible = open ? text : collapsible ? text.slice(0, COLLAPSE_CHARS) : text;
  return (
    <div className="msg-text" dir="auto">
      {visible}
      {collapsible && (
        <button type="button" className="msg-more" onClick={() => setOpen((o) => !o)}>
          {open ? "收起" : `… 展开全文（${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </div>
  );
}

function JsonFold({ json }: { json: string }) {
  const [open, setOpen] = useState(false);
  const collapsible = json.length > 600;
  return (
    <pre className="msg-json" dir="ltr">
      {collapsible && !open ? `${json.slice(0, 600)}…` : json}
      {collapsible && (
        <button type="button" className="msg-more" onClick={() => setOpen((o) => !o)}>
          {open ? "收起" : "展开完整参数"}
        </button>
      )}
    </pre>
  );
}

/** 工具调用参数：对象直接 prettyJson，字符串按已序列化 JSON 原样展示 */
function toolArgsJson(raw: unknown): string | null {
  if (raw == null) return null;
  return typeof raw === "string" ? raw : prettyJson(raw);
}

/** parts 内单块渲染：text / tool_use / tool_result / image / 其他 */
function renderPart(part: ContentPart, key: string) {
  const type = typeof part.type === "string" ? part.type : "other";
  const text = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : null;

  if (type === "text" && text != null) {
    return <TextBlock key={key} text={text} />;
  }
  if (type === "tool_use" || type === "tool_call") {
    const name = typeof part.name === "string" ? part.name : "tool";
    const input = toolArgsJson(part.input);
    return (
      <div key={key} className="msg-tool-card" style={{ borderColor: "var(--role-tool)" }}>
        <div className="msg-tool-head">
          <span className="msg-tool-badge">工具调用</span>
          <span className="mono" style={{ fontWeight: 600 }}>{name}</span>
          {typeof part.id === "string" && <span className="msg-meta mono">{part.id}</span>}
        </div>
        {input && <JsonFold json={input} />}
      </div>
    );
  }
  if (type === "tool_result" || type === "function_call_result") {
    const id = typeof part.tool_call_id === "string" ? part.tool_call_id : typeof part.id === "string" ? part.id : null;
    const content =
      typeof part.content === "string" ? part.content : part.content != null ? prettyJson(part.content) : null;
    return (
      <div key={key} className="msg-tool-card msg-tool-result" style={{ borderColor: "var(--role-tool)" }}>
        <div className="msg-tool-head">
          <span className="msg-tool-badge">工具结果</span>
          {id && <span className="msg-meta mono">{id}</span>}
        </div>
        {content != null &&
          (part.content != null && typeof part.content !== "string" ? (
            <JsonFold json={content} />
          ) : (
            <TextBlock text={content} />
          ))}
      </div>
    );
  }
  if (type === "image" || type === "image_url") {
    const url =
      typeof part.image_url === "string"
        ? part.image_url
        : (part.image_url as { url?: string } | null)?.url ||
          (part.source as { data?: string } | null)?.data ||
          null;
    return (
      <div key={key} className="msg-image">
        {url ? (
          <img src={url} alt="" loading="lazy" style={{ maxWidth: 200, maxHeight: 120, borderRadius: 6 }} />
        ) : (
          <span className="msg-meta">（图片）</span>
        )}
      </div>
    );
  }
  return <JsonFold key={key} json={prettyJson(part)} />;
}

/** 单条消息卡片：role 徽标 + 内容（parts / content / tool_calls） */
function MessageCard({ msg }: { msg: Msg }) {
  const role = msg.role ?? "unknown";
  const color = roleVar(role);
  const parts = Array.isArray(msg.parts) && msg.parts.length > 0 ? msg.parts : null;
  const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;

  return (
    <div className="msg-card" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="msg-card-head">
        <span className="msg-role" style={{ color, borderColor: color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
          {ROLE_LABEL[role] ?? role}
        </span>
        {typeof msg.name === "string" && msg.name && <span className="mono" style={{ color: "var(--text-dim)" }}>{msg.name}</span>}
        {typeof msg.tool_call_id === "string" && msg.tool_call_id && (
          <span className="msg-meta mono">{msg.tool_call_id}</span>
        )}
        {typeof msg.finish_reason === "string" && msg.finish_reason && (
          <span className="msg-meta mono">{msg.finish_reason}</span>
        )}
      </div>

      {parts ? (
        parts.map((p, i) => renderPart(p, `p${i}`))
      ) : toolCalls ? (
        toolCalls.map((tc, i) => {
          const name = typeof tc.function?.name === "string" ? tc.function.name : "tool";
          const input = toolArgsJson(tc.function?.arguments);
          return (
            <div key={`tc${i}`} className="msg-tool-card" style={{ borderColor: "var(--role-tool)" }}>
              <div className="msg-tool-head">
                <span className="msg-tool-badge">工具调用</span>
                <span className="mono" style={{ fontWeight: 600 }}>{name}</span>
                {typeof tc.id === "string" && <span className="msg-meta mono">{tc.id}</span>}
              </div>
              {input && <JsonFold json={input} />}
            </div>
          );
        })
      ) : typeof msg.content === "string" ? (
        <TextBlock text={msg.content} />
      ) : Array.isArray(msg.content) ? (
        (msg.content as unknown[]).map((c, i) =>
          renderPart((c ?? {}) as ContentPart, `c${i}`),
        )
      ) : msg.content != null ? (
        <JsonFold json={prettyJson(msg.content)} />
      ) : (
        <span className="msg-meta">（空）</span>
      )}
    </div>
  );
}

/** 消息视图：标题 + 原始 JSON 切换 + 逐条消息卡片。无消息语义时回退 JsonBlock。 */
export function MessageView({ title, value }: { title: string; value: unknown }) {
  const [raw, setRaw] = useState(false);
  const shape = detectMessageShape(value);
  const json = value != null ? prettyJson(value) : "";

  if (!shape) {
    return <JsonBlock title={title} json={json} bare />;
  }

  if (raw) {
    return (
      <JsonBlock
        title={`${title}（原始 JSON）`}
        json={json}
        bare
        headerExtra={
          <button type="button" className="btn-sm" onClick={() => setRaw(false)} title="返回消息视图">
            返回视图
          </button>
        }
      />
    );
  }

  const messages: Msg[] = extractMessages(value) ?? [];

  return (
    <div className="msg-view" style={{ marginBottom: 6 }}>
      <div className="json-head">
        <span className="mute2 text-xs">{title}</span>
        <span className="spacer" />
        <button type="button" className="btn-sm" onClick={() => setRaw(true)} title="查看原始 JSON">
          原始 JSON
        </button>
        <CopyButton text={json} />
      </div>
      <div className="msg-list">
        {messages.map((m, i) => (
          <MessageCard key={`m${i}`} msg={m} />
        ))}
      </div>
    </div>
  );
}
