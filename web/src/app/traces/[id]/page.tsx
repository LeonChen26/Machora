import { Link } from "../../../components/NativeLink";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { Observation } from "@prisma/client";
import { prisma } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  durationMs,
  prettyJson,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { CopyButton } from "../../../components/CopyButton";
import { requireUser } from "../../../server/session";
import { JsonBlock } from "../../../components/JsonBlock";
import ScoreForm from "../../../components/ScoreForm";
import { getCurrentProjectId } from "../../../server/project";
import {
  ObservationDetailPanel,
  type ObservationView,
} from "../../../components/ObservationDetailPanel";

// 调用树节点：observation + 子节点
type ObsNode = Observation & { children: ObsNode[] };

export const dynamic = "force-dynamic";

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const { id } = await params;
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  // 仅显示异常分支（ERROR/WARNING）过滤开关
  const issuesOnly = str(sp.issues) === "1";
  // Langfuse 式 tab：tree / chat / scores / metadata
  const TAB_KEYS = ["tree", "chat", "scores", "metadata"] as const;
  type TabKey = (typeof TAB_KEYS)[number];
  const tabRaw = str(sp.tab)?.trim();
  const tab: TabKey = TAB_KEYS.includes(tabRaw as TabKey)
    ? (tabRaw as TabKey)
    : "tree";
  const projectId = await getCurrentProjectId();

  // 用 findFirst + projectId 过滤，防止跨项目直接访问 trace 详情
  const trace = await prisma.trace.findFirst({
    where: { id, projectId },
    include: {
      observations: { orderBy: { startTime: "asc" } },
      scores: { orderBy: { timestamp: "desc" } },
      project: { select: { name: true } },
    },
  });

  if (!trace) {
    notFound();
  }

  // 时间轴范围
  const obsTimes = trace.observations.map((o) => o.startTime.getTime());
  const traceStart = obsTimes.length
    ? Math.min(trace.timestamp.getTime(), ...obsTimes)
    : trace.timestamp.getTime();
  const traceEnd = Math.max(
    trace.timestamp.getTime(),
    ...obsTimes,
    ...trace.observations.map((o) => (o.endTime ? o.endTime.getTime() : o.startTime.getTime())),
  );
  const span = Math.max(traceEnd - traceStart, 1);

  // 调用树：按 parentObservationId 构建父子层级（根为父不在本 trace 的 observation）
  function buildObsTree(obs: Observation[]): ObsNode[] {
    const byId = new Map<string, ObsNode>();
    for (const o of obs) byId.set(o.id, { ...o, children: [] });
    const roots: ObsNode[] = [];
    for (const n of byId.values()) {
      const parent = n.parentObservationId
        ? byId.get(n.parentObservationId)
        : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    return roots;
  }
  const obsTree = buildObsTree(trace.observations);

  // 仅异常模式：剪枝保留 ERROR/WARNING 节点及其祖先链（保留上下文）
  function filterIssueTree(nodes: ObsNode[]): ObsNode[] {
    return nodes
      .map((n) => {
        const children = filterIssueTree(n.children);
        const isIssue = n.level === "ERROR" || n.level === "WARNING";
        return isIssue || children.length > 0 ? { ...n, children } : null;
      })
      .filter((n): n is ObsNode => n != null);
  }
  const visibleTree = issuesOnly ? filterIssueTree(obsTree) : obsTree;

  // 可见 obs id 集合（过滤后用于面板数据与计数）
  const visibleIds = new Set<string>();
  (function flatten(nodes: ObsNode[]) {
    for (const n of nodes) {
      visibleIds.add(n.id);
      flatten(n.children);
    }
  })(visibleTree);
  const issueCount = trace.observations.filter(
    (o) => o.level === "ERROR" || o.level === "WARNING",
  ).length;

  // 对话视图：从 GENERATION 的 input/output.messages 提取消息流（按时间序）
  interface ChatMsg {
    id: string;
    role: string;
    content: string;
    model: string | null;
    obsName: string | null;
  }
  const ROLE_LABEL: Record<string, string> = {
    user: "用户",
    assistant: "助手",
    system: "系统",
    tool: "工具",
    function: "工具",
  };
  function collectChatMessages(observations: Observation[]): ChatMsg[] {
    const out: ChatMsg[] = [];
    for (const o of observations) {
      if (o.type !== "GENERATION") continue;
      let idx = 0;
      for (const src of [o.input, o.output]) {
        if (!src || typeof src !== "object" || Array.isArray(src)) continue;
        const messages = (src as Record<string, unknown>).messages;
        if (!Array.isArray(messages)) continue;
        for (const item of messages) {
          if (!item || typeof item !== "object") continue;
          const it = item as Record<string, unknown>;
          const role = typeof it.role === "string" ? it.role : "unknown";
          let content: string;
          if (typeof it.content === "string") content = it.content;
          else if (it.content == null) content = "";
          else content = prettyJson(it.content);
          if (Array.isArray(it.tool_calls) && it.tool_calls.length > 0) {
            content = (content ? content + "\n\n" : "") + "⚙ tool_calls: " + prettyJson(it.tool_calls);
          }
          out.push({
            id: `${o.id}#${idx++}`,
            role,
            content,
            model: o.model,
            obsName: o.name,
          });
        }
      }
    }
    return out;
  }
  const chatMessages = collectChatMessages(trace.observations);
  const chatRoleClass = (role: string): string =>
    role === "user" || role === "system" || role === "tool" || role === "function"
      ? role === "function" ? "tool" : role
      : "assistant";

  // 序列化后传给 client 面板（Date → ISO 字符串，RSC props 需 JSON 可序列化）
  const obsViews: ObservationView[] = trace.observations
    .filter((o) => visibleIds.has(o.id))
    .map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    level: o.level,
    model: o.model,
    startTime: o.startTime.toISOString(),
    endTime: o.endTime ? o.endTime.toISOString() : null,
    inputTokens: o.inputTokens,
    outputTokens: o.outputTokens,
    totalTokens: o.totalTokens,
    totalCost: o.totalCost,
    input: o.input,
    output: o.output,
    usage: o.usage,
    metadata: o.metadata,
  }));

  // Token / 成本汇总
  const totalTokens = trace.observations.reduce(
    (s, o) => s + (o.totalTokens ?? 0),
    0,
  );
  const totalCost = trace.observations.reduce(
    (s, o) => s + (o.totalCost ?? 0),
    0,
  );
  const costCount = trace.observations.filter((o) => o.totalCost != null).length;
  // 异常计数与平均分（聚合指标卡）
  const errorCount = trace.observations.filter((o) => o.level === "ERROR").length;
  const warningCount = trace.observations.filter(
    (o) => o.level === "WARNING",
  ).length;
  const numericScores = trace.scores.filter((s) => s.dataType === "NUMERIC");
  const avgScore = numericScores.length
    ? numericScores.reduce((s, sc) => s + sc.value, 0) / numericScores.length
    : null;

  function barPos(start: Date, end: Date | null): { left: number; width: number } {
    const s = start.getTime();
    const e = end ? end.getTime() : start.getTime() + Math.min(span * 0.05, 500);
    const left = ((s - traceStart) / span) * 100;
    const width = Math.max(((e - s) / span) * 100, 1);
    return { left: Math.max(left, 0), width: Math.min(width, 100 - left) };
  }

  // 树形渲染：当前节点行 + 递归子节点（depth 控制名称缩进）
  function renderObsRows(nodes: ObsNode[], depth: number): ReactNode[] {
    return nodes.flatMap((o) => {
      const dur = durationMs(o.startTime, o.endTime);
      const pos = barPos(o.startTime, o.endTime);
      const typeColor =
        o.type === "GENERATION"
          ? "purple"
          : o.type === "SPAN"
            ? "blue"
            : "amber";
      // 条颜色：ERROR/WARNING 用警示色覆盖类型色，突出异常
      const barColor =
        o.level === "ERROR"
          ? "var(--red)"
          : o.level === "WARNING"
            ? "var(--amber)"
            : o.type === "GENERATION"
              ? "var(--purple)"
              : o.type === "SPAN"
                ? "var(--accent)"
                : "var(--amber)";
      const barTip =
        `${o.name || o.id}\n` +
        `${formatDateTime(o.startTime)} → ${o.endTime ? formatDateTime(o.endTime) : "—"}\n` +
        `耗时 ${formatDuration(dur)}`;
      const row = (
        <tr key={o.id} data-obs={o.id}>
          <td>
            <div style={{ paddingLeft: depth * 18, display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <span>{o.name || <span className="mute2">（未命名）</span>}</span>
              <span className={`badge ${typeColor}`}>{o.type}</span>
              {o.model && (
                <span className="mono mute2" style={{ fontSize: 11 }}>{o.model}</span>
              )}
              <span className="mono mute2" style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 2 }} title={o.id}>
                {o.id.slice(0, 8)}
                <CopyButton text={o.id} />
              </span>
            </div>
          </td>
          <td className="mono">{formatDuration(dur)}</td>
          <td>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div
                style={{
                  position: "relative",
                  height: 14,
                  background: "var(--bg-elev-2)",
                  borderRadius: 4,
                }}
                title={barTip}
              >
                <div
                  style={{
                    position: "absolute",
                    left: `${pos.left}%`,
                    width: `${pos.width}%`,
                    top: 0,
                    bottom: 0,
                    background: barColor,
                    borderRadius: 4,
                    opacity: 0.75,
                  }}
                />
              </div>
              {/* 相对时间刻度：0 / 50% / 总耗时 */}
              <div style={{ position: "relative", height: 11 }}>
                {[0, 50, 100].map((p) => (
                  <span
                    key={p}
                    style={{
                      position: "absolute",
                      left: `${p}%`,
                      transform: "translateX(-50%)",
                      fontSize: 9,
                      color: "var(--text-mute)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p === 0 ? "0" : p === 50 ? "50%" : formatDuration(span)}
                  </span>
                ))}
              </div>
            </div>
          </td>
          <td>
            <LevelBadge level={o.level} />
          </td>
        </tr>
      );
      return [row, ...renderObsRows(o.children, depth + 1)];
    });
  }

  return (
    <>
      <div className="breadcrumb">
        <Link href="/traces" prefetch={false}>Traces</Link>
        <span className="mute2">/</span>
        <span className="mono muted">{trace.id}</span>
      </div>

      <div className="page-head">
        <div>
          <h1>{trace.name || "（未命名 Trace）"}</h1>
          <div className="sub">
            {trace.project.name} · {formatDateTime(trace.timestamp)} ·{" "}
            {trace.observations.length} obs · {trace.scores.length} scores
            {totalTokens > 0 && <> · {formatTokens(totalTokens)} tokens</>}
            {costCount > 0 && (
              <>
                {" "}
                · <span style={{ color: "var(--green)" }}>{formatCost(totalCost)}</span>
              </>
            )}
          </div>
        </div>
        <Link className="btn" href="/traces" prefetch={false}>
          ← 返回列表
        </Link>
      </div>

      {/* 聚合指标卡 */}
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div className="card" style={{ flex: "1 1 150px" }}>
          <div className="label">总耗时</div>
          <div className="value" style={{ fontSize: 18 }}>
            {formatDuration(traceEnd - traceStart)}
          </div>
          <div className="hint">trace 时间跨度</div>
        </div>
        <div className="card" style={{ flex: "1 1 150px" }}>
          <div className="label">总 Token</div>
          <div className="value" style={{ fontSize: 18 }}>
            {formatTokens(totalTokens)}
          </div>
          <div className="hint">{trace.observations.length} obs 合计</div>
        </div>
        <div className="card" style={{ flex: "1 1 150px" }}>
          <div className="label">总成本</div>
          <div className="value" style={{ fontSize: 18, color: "var(--green)" }}>
            {formatCost(totalCost)}
          </div>
          <div className="hint">{costCount} 个 obs 含成本</div>
        </div>
        <div
          className="card"
          style={{
            flex: "1 1 150px",
            borderColor: errorCount > 0 ? "var(--red)" : undefined,
            boxShadow: errorCount > 0 ? "0 0 0 1px var(--red) inset" : undefined,
          }}
        >
          <div className="label">异常</div>
          <div
            className="value"
            style={{ fontSize: 18, color: errorCount > 0 ? "var(--red)" : undefined }}
          >
            {errorCount > 0 ? `${errorCount} ERROR` : "0 ERROR"}
          </div>
          <div className="hint">{warningCount} WARNING</div>
        </div>
        <div className="card" style={{ flex: "1 1 150px" }}>
          <div className="label">平均分</div>
          <div
            className="value"
            style={{
              fontSize: 18,
              color:
                avgScore == null
                  ? undefined
                  : avgScore >= 0.8
                    ? "var(--green)"
                    : avgScore >= 0.5
                      ? "var(--amber)"
                      : "var(--red)",
            }}
          >
            {avgScore != null ? avgScore.toFixed(3) : "—"}
          </div>
          <div className="hint">
            {numericScores.length} 个 NUMERIC 评分
          </div>
        </div>
      </div>

      {/* Langfuse 式 Tab 分区 */}
      <div className="detail-tabs">
        <Link
          href={`/traces/${id}${issuesOnly ? "?issues=1" : ""}`}
          prefetch={false}
          className={tab === "tree" ? "tab active" : "tab"}
        >
          调用树
          <span className="count">{trace.observations.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=chat`}
          prefetch={false}
          className={tab === "chat" ? "tab active" : "tab"}
        >
          对话
          <span className="count">{chatMessages.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=scores`}
          prefetch={false}
          className={tab === "scores" ? "tab active" : "tab"}
        >
          评分
          <span className="count">{trace.scores.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=metadata`}
          prefetch={false}
          className={tab === "metadata" ? "tab active" : "tab"}
        >
          元数据
        </Link>
      </div>

      {/* tab=tree：左树右详情（Langfuse 式） */}
      {tab === "tree" && (
        <>
        <div className="tree-layout">
          <div className="tree-col">
      {/* Observations 时间轴 */}
      <div
        className="section-title"
        style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}
      >
        Observations{" "}
        <span className="count">
          {issuesOnly
            ? `${visibleIds.size} / ${trace.observations.length}`
            : trace.observations.length}
        </span>
        <span className="spacer" />
        <span className="seg">
          <Link
            href={`/traces/${trace.id}`}
            prefetch={false}
            className={issuesOnly ? "seg-btn" : "seg-btn active"}
          >
            全部
          </Link>
          <Link
            href={`/traces/${trace.id}?issues=1`}
            prefetch={false}
            className={issuesOnly ? "seg-btn active" : "seg-btn"}
          >
            仅异常
            {issueCount > 0 && ` (${issueCount})`}
          </Link>
        </span>
      </div>

      {trace.observations.length === 0 ? (
        <div className="card empty">
          <div className="icon">⌁</div>
          该 Trace 下暂无 Observation。
        </div>
      ) : visibleTree.length === 0 ? (
        <div className="card empty">
          <div className="icon">⌁</div>
          无 ERROR / WARNING 分支。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称 / 类型</th>
                <th>耗时</th>
                <th style={{ width: "32%" }}>时间轴</th>
                <th>级别</th>
              </tr>
            </thead>
            <tbody>{renderObsRows(visibleTree, 0)}</tbody>
          </table>
        </div>
      )}
          </div>
          <div className="panel-col">
            <ObservationDetailPanel observations={obsViews} />
          </div>
        </div>
        </>
      )}

      {/* tab=scores：评分 */}
      {tab === "scores" && (
        <>
      {/* Scores */}
      <div className="section-title">
        Scores <span className="count">{trace.scores.length}</span>
      </div>
      <ScoreForm
        traceId={trace.id}
        observations={trace.observations.map((o) => ({
          id: o.id,
          name: o.name ?? o.id,
        }))}
      />
      {trace.scores.length === 0 ? (
        <div className="card empty">
          <div className="icon">★</div>
          该 Trace 暂无评分。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>值</th>
                <th>类型</th>
                <th>来源</th>
                <th>时间</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {trace.scores.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        color:
                          s.value >= 0.8
                            ? "var(--green)"
                            : s.value >= 0.5
                              ? "var(--amber)"
                              : "var(--red)",
                        borderColor: "transparent",
                      }}
                    >
                      {s.dataType === "NUMERIC"
                        ? s.value.toFixed(3)
                        : s.dataType === "BOOLEAN"
                          ? s.value
                            ? "✓"
                            : "✗"
                          : (s.comment?.split("|")[0]?.trim() || "—")}
                    </span>
                  </td>
                  <td>
                    <span className="badge">{s.dataType}</span>
                  </td>
                  <td>
                    <span className="badge blue">{s.source}</span>
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>
                    {formatDateTime(s.timestamp)}
                  </td>
                  <td className="muted">{s.comment || <span className="mute2">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}

      {/* tab=chat：对话视图（Langfuse 式独立 Tab） */}
      {tab === "chat" && (
        <>
      <div className="section-title">
        对话 <span className="count">{chatMessages.length}</span>
      </div>
      {chatMessages.length === 0 ? (
        <div className="card empty">
          <div className="icon">◉</div>
          该 Trace 无对话消息（GENERATION 需带 input/output.messages）。
        </div>
      ) : (
        <div className="card chat-view" style={{ maxHeight: "none" }}>
          {chatMessages.map((m) => (
            <div key={m.id} className={`chat-msg chat-${chatRoleClass(m.role)}`}>
              <div className="chat-head">
                <span className="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
                {m.model && <span className="badge purple">{m.model}</span>}
                {m.obsName && <span className="chat-obs">{m.obsName}</span>}
              </div>
              <div className="chat-content">
                {m.content || <span className="mute2">（空）</span>}
              </div>
            </div>
          ))}
        </div>
      )}
        </>
      )}

      {/* tab=metadata：元数据（Trace 属性 + input/output/metadata） */}
      {tab === "metadata" && (
        <>
      <div className="section-title">元数据</div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <dl className="kv">
          <dt>Trace ID</dt>
          <dd className="mono">
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              {trace.id}
              <CopyButton text={trace.id} />
            </span>
          </dd>
          <dt>时间戳</dt>
          <dd className="mono">{formatDateTime(trace.timestamp)}</dd>
          <dt>环境</dt>
          <dd>
            <Link href={`/traces?env=${encodeURIComponent(trace.environment)}`} prefetch={false}>
              <span className="badge">{trace.environment}</span>
            </Link>
          </dd>
          <dt>用户</dt>
          <dd className="mono">
            {trace.userId ? (
              <Link href={`/traces?user=${encodeURIComponent(trace.userId)}`} prefetch={false}>
                {trace.userId}
              </Link>
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>会话</dt>
          <dd className="mono">
            {trace.sessionId ? (
              <Link href={`/sessions/${encodeURIComponent(trace.sessionId)}`} prefetch={false}>
                {trace.sessionId}
              </Link>
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>Agent</dt>
          <dd>
            {trace.agentName ? (
              <Link href={`/traces?agent=${encodeURIComponent(trace.agentName)}`} prefetch={false}>
                <span className="badge green">{trace.agentName}</span>
              </Link>
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>工作流</dt>
          <dd>
            {trace.workflowName ? (
              <span className="badge purple">{trace.workflowName}</span>
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>Skill</dt>
          <dd>
            {trace.skillName ? (
              <span className="badge">{trace.skillName}</span>
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>标签</dt>
          <dd>
            {trace.tags.length > 0 ? (
              trace.tags.map((t) => (
                <Link
                  key={t}
                  href={`/traces?tag=${encodeURIComponent(t)}`}
                  prefetch={false}
                  style={{ marginRight: 4 }}
                >
                  <span className="badge">{t}</span>
                </Link>
              ))
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>总跨度</dt>
          <dd className="mono">{formatDuration(traceEnd - traceStart)}</dd>
        </dl>
      </div>
      {(trace.input != null || trace.output != null || trace.metadata != null) ? (
        <div className="grid grid-3">
          {trace.input != null && (
            <JsonBlock title="TRACE INPUT" json={prettyJson(trace.input)} />
          )}
          {trace.output != null && (
            <JsonBlock title="TRACE OUTPUT" json={prettyJson(trace.output)} />
          )}
          {trace.metadata != null && (
            <JsonBlock title="TRACE METADATA" json={prettyJson(trace.metadata)} />
          )}
        </div>
      ) : (
        <div className="card empty">
          <div className="icon">⌁</div>
          该 Trace 无 input / output / metadata。
        </div>
      )}
        </>
      )}

    </>
  );
}

function LevelBadge({ level }: { level: string }) {
  const map: Record<string, string> = {
    DEBUG: "",
    DEFAULT: "",
    WARNING: "amber",
    ERROR: "red",
  };
  const cls = map[level] ?? "";
  return <span className={`badge ${cls}`}>{level}</span>;
}
