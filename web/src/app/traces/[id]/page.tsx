import { Link } from "../../../components/NativeLink";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, trace as traceTable, observation } from "@machora/shared";
import {
  formatDateTime,
  formatDuration,
  durationMs,
  prettyJson,
  formatTokens,
  formatCost,
} from "../../../lib/format";
import { CopyButton } from "../../../components/CopyButton";
import { EmptyIcon } from "../../../components/EmptyIcon";
import { requireUser } from "../../../server/session";
import { JsonBlock } from "../../../components/JsonBlock";
import ScoreForm from "../../../components/ScoreForm";
import { getCurrentProjectId } from "../../../server/project";
import {
  type ObservationView,
} from "../../../components/ObservationDetailPanel";
import { TraceStatsRow } from "../../../components/trace/TraceStatsRow";
import { TraceTree } from "../../../components/trace/TraceTree";
import { TraceTimeline } from "../../../components/trace/TraceTimeline";
import { TrajectoryGraph } from "../../../components/trace/TrajectoryGraph";
import { TraceDetailPanel } from "../../../components/trace/TraceDetailPanel";
import { MessageView } from "../../../components/trace/MessageView";
import { buildTrajectoryRows } from "../../../server/trajectory";
import { classifyTrajectoryKind } from "@machora/shared";
import {
  SelectionProvider,
  SelectionLayout,
  type TraceRow,
} from "../../../components/trace/contexts";

// 调用树节点：observation + 子节点
type Observation = typeof observation.$inferSelect;
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
  // Langfuse 式 tab：tree（调用树）/ timeline（时间线）/ trajectory（推理轨迹）/ chat（对话）/ scores（评分）。
  // trace 级详情（kv + IO + metadata）并入 tree/timeline 的右侧面板（选中根 trace 时显示，对齐 Langfuse TracePanelDetail）
  const TAB_KEYS = ["tree", "timeline", "trajectory", "chat", "scores"] as const;
  type TabKey = (typeof TAB_KEYS)[number];
  const tabRaw = str(sp.tab)?.trim();
  const tab: TabKey = TAB_KEYS.includes(tabRaw as TabKey)
    ? (tabRaw as TabKey)
    : "tree";
  const projectId = await getCurrentProjectId();

  // 用 findFirst + projectId 过滤，防止跨项目直接访问 trace 详情
  const trace = await db.query.trace.findFirst({
    where: and(eq(traceTable.id, id), eq(traceTable.projectId, projectId)),
    with: {
      observations: { orderBy: (o, { asc }) => [asc(o.startTime)] },
      scores: { orderBy: (s, { desc }) => [desc(s.timestamp)] },
      project: { columns: { name: true } },
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

  // 拍平调用树为行数据（含渲染所需全部计算值），供 client 树/时间线视图消费
  // 先序：先 push 父行（留空 container/childrenCount），再递归子树，最后回填父子结构信息。
  function flattenRows(nodes: ObsNode[], depth: number, out: TraceRow[]) {
    for (const o of nodes) {
      const dur = durationMs(o.startTime, o.endTime);
      const pos = barPos(o.startTime, o.endTime);
      const kind = classifyTrajectoryKind({
        type: o.type,
        metadata: o.metadata,
        model: o.model,
        agentName: o.agentName,
        workflowName: o.workflowName,
        skillName: o.skillName,
        hasParent: depth > 0,
      });
      // pill：从 name 提取 round:N / step:N / iter:N；未命中则 kind=think/retrieval/memory/skill → "STEP"（与截图风格对齐）
      let pill: string | null = null;
      const nm = o.name ?? "";
      const m =
        /\b(?:round|step|iter|iteration|try|retry|loop)[\s:\-_#]*(\d+)\b/i.exec(nm) ??
        /\b(r\d+|s\d+)\b/i.exec(nm);
      if (m) {
        pill = m[0].replace(/[\s:\-_#]+/g, ":").replace(/^([a-z]+):(\d)/i, (_w, p, n) => `${p.toLowerCase()}:${n}`);
        // 规整为 "round:1" "step:2" 样式首字母大写
        pill = pill.charAt(0).toUpperCase() + pill.slice(1);
      }
      // TTFT：优先从 usage 里取常见字段；无则 null
      let ttftMs: number | null = null;
      const u = o.usage as Record<string, unknown> | null;
      if (u && typeof u === "object") {
        const candidates = [
          "ttftMs",
          "ttft_ms",
          "timeToFirstTokenMs",
          "time_to_first_token_ms",
          "timeToFirstToken",
          "time_to_first_token",
          "firstTokenMs",
          "first_token_ms",
        ];
        for (const k of candidates) {
          const v = u[k];
          if (typeof v === "number" && v >= 0) {
            ttftMs = v;
            break;
          }
        }
      }
      const idx = out.length;
      out.push({
        id: o.id,
        name: o.name,
        type: o.type,
        level: o.level,
        model: o.model,
        kind,
        pill,
        totalTokens: typeof o.totalTokens === "number" ? o.totalTokens : null,
        totalCost: typeof o.totalCost === "number" ? o.totalCost : null,
        ttftMs,
        depth,
        dur: dur ?? 0,
        left: pos.left,
        width: pos.width,
        container: false,
        childrenCount: 0,
      });
      flattenRows(o.children, depth + 1, out);
      const row = out[idx];
      row.container = o.children.length > 0;
      row.childrenCount = o.children.length;
    }
  }
  const rows: TraceRow[] = [];
  flattenRows(visibleTree, 0, rows);

  // 推理轨迹：按 Agent 行为角色重组主链（event/other 聚合 + 循环检测）
  const traj = buildTrajectoryRows(visibleTree);

  // Tab 链接保留当前选中行：切 Tab 是 RSC 导航会重挂载 Provider，
  // URL 带上 ?selected= 才能恢复选中（sessionStorage 兜底之外的第二层保障）
  const sel = str(sp.selected)?.trim();
  const selectedParam = sel ? `&selected=${encodeURIComponent(sel)}` : "";
  const treeQs = [
    ...(issuesOnly ? ["issues=1"] : []),
    ...(sel ? [`selected=${encodeURIComponent(sel)}`] : []),
  ];
  const treeHref = treeQs.length ? `/traces/${id}?${treeQs.join("&")}` : `/traces/${id}`;

  // trace 级详情（对齐 Langfuse TraceDetailView Preview）：属性 kv + input/output/metadata。
  // 由右侧 TraceDetailPanel 在"未选中 observation（选中根 trace）"时展示
  const traceDetailContent = (
    <div style={{ padding: "4px 12px 12px" }}>
      <dl className="kv">
        <dt>Trace ID</dt>
        <dd className="mono">
          <span className="key-row">
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
                className="mr-1"
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
      <div style={{ marginTop: 14 }}>
        {(trace.input != null || trace.output != null || trace.metadata != null) ? (
          <>
            {trace.input != null && (
              <MessageView title="TRACE INPUT" value={trace.input} />
            )}
            {trace.output != null && (
              <MessageView title="TRACE OUTPUT" value={trace.output} />
            )}
            {trace.metadata != null && (
              <JsonBlock title="TRACE METADATA" json={prettyJson(trace.metadata)} bare />
            )}
          </>
        ) : (
          <div className="mute2">该 Trace 无 input / output / metadata。</div>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={
        tab === "tree" || tab === "timeline" || tab === "trajectory"
          ? "trace-root tree-locked"
          : "trace-root"
      }
    >
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
                · <span className="cost">{formatCost(totalCost)}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Link href="/docs#semantic-conventions" prefetch={false}>
            <span className="badge">语义规范</span>
          </Link>
          <Link className="btn" href="/traces" prefetch={false}>
            ← 返回列表
          </Link>
        </div>
      </div>

      {/* 聚合指标徽章行（参照 Langfuse Header 思路，替代原 grid-4 统计卡） */}
      <TraceStatsRow
        spanMs={span}
        obsCount={trace.observations.length}
        totalTokens={totalTokens}
        totalCost={totalCost}
        costCount={costCount}
        errorCount={errorCount}
        warningCount={warningCount}
        avgScore={avgScore}
        scoreCount={numericScores.length}
      />

      {/* Langfuse 式 Tab 分区 */}
      <div className="detail-tabs" role="tablist">
        <Link
          href={treeHref}
          prefetch={false}
          className={tab === "tree" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "tree"}
        >
          调用树
          <span className="count">{trace.observations.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=timeline${selectedParam}`}
          prefetch={false}
          className={tab === "timeline" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "timeline"}
        >
          时间线
          <span className="count">{rows.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=trajectory${issuesOnly ? "&issues=1" : ""}${selectedParam}`}
          prefetch={false}
          className={tab === "trajectory" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "trajectory"}
        >
          轨迹
          <span className="count">{traj.rows.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=chat${selectedParam}`}
          prefetch={false}
          className={tab === "chat" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "chat"}
        >
          对话
          <span className="count">{chatMessages.length}</span>
        </Link>
        <Link
          href={`/traces/${id}?tab=scores${selectedParam}`}
          prefetch={false}
          className={tab === "scores" ? "tab active" : "tab"}
          role="tab"
          aria-selected={tab === "scores"}
        >
          评分
          <span className="count">{trace.scores.length}</span>
        </Link>
      </div>

      {/* tree/timeline/trajectory 共享选中态：Provider 提到外层，切视图选中行保留（对齐 Langfuse） */}
      {(tab === "tree" || tab === "timeline" || tab === "trajectory") && (
        <SelectionProvider>
          {tab === "tree" && (
          <SelectionLayout>
            <div className="tree-col">
              <div className="section-title">
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
                    aria-current={!issuesOnly ? "true" : undefined}
                  >
                    全部
                  </Link>
                  <Link
                    href={`/traces/${trace.id}?issues=1`}
                    prefetch={false}
                    className={issuesOnly ? "seg-btn active" : "seg-btn"}
                    aria-current={issuesOnly ? "true" : undefined}
                  >
                    仅异常
                    {issueCount > 0 && ` (${issueCount})`}
                  </Link>
                </span>
              </div>

              {trace.observations.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  该 Trace 下暂无 Observation。
                </div>
              ) : rows.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  无 ERROR / WARNING 分支。
                </div>
              ) : (
                <TraceTree rows={rows} />
              )}
            </div>
            <div className="panel-col">
              <TraceDetailPanel observations={obsViews}>{traceDetailContent}</TraceDetailPanel>
            </div>
          </SelectionLayout>
          )}

          {tab === "timeline" && (
          <SelectionLayout>
            <div className="tree-col">
              <div className="section-title">
                Timeline{" "}
                <span className="count">{rows.length}</span>
              </div>
              {trace.observations.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  该 Trace 下暂无 Observation。
                </div>
              ) : rows.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  无 ERROR / WARNING 分支。
                </div>
              ) : (
                <TraceTimeline rows={rows} />
              )}
            </div>
            <div className="panel-col">
              <TraceDetailPanel observations={obsViews}>{traceDetailContent}</TraceDetailPanel>
            </div>
          </SelectionLayout>
          )}

          {tab === "trajectory" && (
          <SelectionLayout>
            <div className="tree-col">
              <div className="section-title">
                推理轨迹 <span className="count">{traj.rows.length}</span>
                {traj.longTask && (
                  <span className="badge amber" style={{ marginLeft: 8 }}>
                    长任务
                  </span>
                )}
              </div>
              {trace.observations.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  该 Trace 下暂无 Observation。
                </div>
              ) : traj.rows.length === 0 ? (
                <div className="card empty">
                  <EmptyIcon type="bolt" />
                  {issuesOnly
                    ? "无 ERROR / WARNING 分支。"
                    : "该 Trace 无可展示的轨迹节点。"}
                </div>
              ) : (
                <>
                  {!traj.hasAgentSignal && (
                    <div className="muted mb-1" style={{ padding: "8px 14px" }}>
                      该 Trace 无 Agent 语义数据（无思考 / 模型 / 工具等角色节点）。
                    </div>
                  )}
                  <TrajectoryGraph rows={traj.rows} />
                </>
              )}
            </div>
            <div className="panel-col">
              <TraceDetailPanel observations={obsViews}>{traceDetailContent}</TraceDetailPanel>
            </div>
          </SelectionLayout>
          )}
        </SelectionProvider>
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
          <EmptyIcon type="star" />
          该 Trace 暂无评分。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">值</th>
                <th scope="col">类型</th>
                <th scope="col">来源</th>
                <th scope="col">时间</th>
                <th scope="col">备注</th>
              </tr>
            </thead>
            <tbody>
              {trace.scores.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <span
                      className="badge score-value"
                      data-grade={
                        s.value >= 0.8 ? "good" : s.value >= 0.5 ? "mid" : "bad"
                      }
                      style={{ borderColor: "transparent" }}
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
                  <td className="mono muted text-xs">
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
          <EmptyIcon type="target" />
          该 Trace 无对话消息（GENERATION 需带 input/output.messages）。
        </div>
      ) : (
        <div className="card chat-view" style={{ maxHeight: "none" }}>
          {chatMessages.map((m) => (
            <div key={m.id} className={`chat-msg chat-${chatRoleClass(m.role)}`}>
              <div className="chat-head">
                <span className="badge">{ROLE_LABEL[m.role] ?? m.role}</span>
                {m.model && <span className="badge purple">{m.model}</span>}
                {m.obsName && <span className="chat-obs" title={m.obsName}>{m.obsName}</span>}
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

    </div>
  );
}
