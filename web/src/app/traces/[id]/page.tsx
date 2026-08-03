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
      const showLabel = pos.width > 18;
      const barTip =
        `${o.name || o.id}\n` +
        `${formatDateTime(o.startTime)} → ${o.endTime ? formatDateTime(o.endTime) : "—"}\n` +
        `耗时 ${formatDuration(dur)}`;
      const row = (
        <tr key={o.id} data-obs={o.id}>
          <td>
            <div style={{ paddingLeft: depth * 18 }}>
              <div>{o.name || <span className="mute2">（未命名）</span>}</div>
              <div className="mono mute2" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                {o.id}
                <CopyButton text={o.id} />
              </div>
              <div style={{ marginTop: 2 }}>
                <span className={`badge ${typeColor}`}>{o.type}</span>
              </div>
            </div>
          </td>
          <td>
            {o.model ? (
              <span className="badge purple">{o.model}</span>
            ) : (
              <span className="mute2">—</span>
            )}
          </td>
          <td className="mono muted" style={{ fontSize: 11 }}>
            {formatDateTime(o.startTime)}
          </td>
          <td className="mono">{formatDuration(dur)}</td>
          <td>
            {o.totalTokens != null && o.totalTokens > 0 ? (
              <>
                <div className="mono" style={{ fontSize: 12 }}>
                  {formatTokens(o.totalTokens)}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--green)" }}>
                  {formatCost(o.totalCost)}
                </div>
              </>
            ) : (
              <span className="mute2">—</span>
            )}
          </td>
          <td>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div
                style={{
                  position: "relative",
                  height: 16,
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
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {showLabel && (
                    <span
                      style={{
                        fontSize: 9,
                        color: "#fff",
                        whiteSpace: "nowrap",
                        fontFamily: "var(--mono)",
                      }}
                    >
                      {formatDuration(dur)}
                    </span>
                  )}
                </div>
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

      {/* 基本信息 */}
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
            <span className="badge">{trace.environment}</span>
          </dd>
          <dt>用户</dt>
          <dd className="mono">{trace.userId || <span className="mute2">—</span>}</dd>
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
              <span className="badge green">{trace.agentName}</span>
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
                <span key={t} className="badge" style={{ marginRight: 4 }}>
                  {t}
                </span>
              ))
            ) : (
              <span className="mute2">—</span>
            )}
          </dd>
          <dt>总跨度</dt>
          <dd className="mono">{formatDuration(traceEnd - traceStart)}</dd>
        </dl>
      </div>

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
                <th style={{ width: 200 }}>名称 / 类型</th>
                <th>模型</th>
                <th>开始</th>
                <th>耗时</th>
                <th>Token / 成本</th>
                <th style={{ width: "30%" }}>时间轴</th>
                <th>级别</th>
              </tr>
            </thead>
            <tbody>{renderObsRows(visibleTree, 0)}</tbody>
          </table>
        </div>
      )}

      {/* Observations 输入输出（选中详览：点表格行或 ‹/› 切换） */}
      <div className="section-title">
        Observation 详情 <span className="count">{obsViews.length}</span>
      </div>
      <ObservationDetailPanel observations={obsViews} />

      {/* Scores */}
      <div className="section-title">
        Scores <span className="count">{trace.scores.length}</span>
      </div>
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
                          : String(s.value)}
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

      {/* Trace input/output/metadata */}
      {(trace.input != null || trace.output != null || trace.metadata != null) && (
        <>
          <div className="section-title">Trace 元数据</div>
          <div className="grid grid-3">
            {trace.input != null && (
              <JsonBlock title="INPUT" json={prettyJson(trace.input)} />
            )}
            {trace.output != null && (
              <JsonBlock title="OUTPUT" json={prettyJson(trace.output)} />
            )}
            {trace.metadata != null && (
              <JsonBlock title="METADATA" json={prettyJson(trace.metadata)} />
            )}
          </div>
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
