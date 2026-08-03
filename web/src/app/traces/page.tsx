import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import type { ReactNode } from "react";
import {
  formatRelative,
  formatDateTime,
  formatTokens,
  formatCost,
} from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";
import {
  parseTraceFilters,
  buildTraceWhere,
} from "../../server/traceQuery";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const projectId = await getCurrentProjectId();
  const f = parseTraceFilters(sp);
  const { from, to } = f;
  const { q, userId, sessionId, model, tags, level, env, agent } = f;
  const rawPage = Number.parseInt(str(sp.page) ?? "", 10);
  const page = rawPage >= 1 ? rawPage : 1;

  const where = buildTraceWhere(projectId, f);

  // 环境下拉选项（当前项目去重）
  const envs = await prisma.trace.findMany({
    where: { projectId },
    select: { environment: true },
    distinct: ["environment"],
    orderBy: { environment: "asc" },
  });

  const items = await prisma.trace.findMany({
    where,
    orderBy: { timestamp: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      observations: {
        select: {
          model: true,
          type: true,
          level: true,
          startTime: true,
          endTime: true,
          totalTokens: true,
          totalCost: true,
        },
        orderBy: { startTime: "asc" },
      },
      scores: {
        select: { id: true, name: true, value: true, dataType: true },
        orderBy: { timestamp: "desc" },
        take: 3,
      },
      _count: { select: { observations: true, scores: true } },
    },
  });

  const total = await prisma.trace.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shown = items;

  // 排序：time / cost / latency / token（JS 层排序当前页；跨页精确排序留待聚合查询）
  const sortKey = str(sp.sort)?.trim() || "time";
  const sortDir = str(sp.dir) === "asc" ? "asc" : "desc";
  function sortValue(
    t: (typeof shown)[number],
    key: string,
  ): number | null {
    if (key === "cost")
      return t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0);
    if (key === "token")
      return t.observations.reduce((s, o) => s + (o.totalTokens ?? 0), 0);
    if (key === "latency") return firstGenLatency(t);
    return t.timestamp.getTime();
  }
  const sortedShown = [...shown].sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sortDir === "asc" ? va - vb : vb - va;
  });
  // 表头排序链接
  function sortHref(key: string): string {
    const nextDir =
      sortKey === key ? (sortDir === "desc" ? "asc" : "desc") : "desc";
    return `/traces?${buildQuery({
      from,
      to,
      q,
      userId,
      sessionId,
      model,
      tags,
      level,
      env,
      agent,
      sort: key,
      dir: nextDir,
      page: 1,
    })}`;
  }
  function sortTh(label: string, sortFor: string): ReactNode {
    const active = sortKey === sortFor;
    return (
      <th>
        <Link
          href={sortHref(sortFor)}
          prefetch={false}
          style={{
            color: active ? "var(--accent)" : "inherit",
            fontWeight: active ? 600 : 500,
          }}
        >
          {label} {active ? (sortDir === "desc" ? "↓" : "↑") : ""}
        </Link>
      </th>
    );
  }

  // 快捷时间窗：当前 from/to 落在预设区间（±10min）内时高亮
  const RANGES: { key: string; label: string; ms: number }[] = [
    { key: "1h", label: "近 1 小时", ms: 60 * 60 * 1000 },
    { key: "24h", label: "近 24 小时", ms: 24 * 60 * 60 * 1000 },
    { key: "7d", label: "近 7 天", ms: 7 * 24 * 60 * 60 * 1000 },
    { key: "30d", label: "近 30 天", ms: 30 * 24 * 60 * 60 * 1000 },
  ];
  const isRange = (fromD: Date, toD: Date, ms: number): boolean => {
    const now = Date.now();
    return (
      Math.abs(toD.getTime() - now) < 10 * 60 * 1000 &&
      Math.abs(fromD.getTime() - (now - ms)) < 10 * 60 * 1000
    );
  };
  const activeRange = RANGES.find((r) => isRange(from, to, r.ms));

  // 统计本页 latency（基于 observation 第一个 generation 的耗时）
  function firstGenLatency(t: (typeof shown)[number]): number | null {
    const g = t.observations.find((o) => o.type === "GENERATION" && o.endTime);
    if (!g?.endTime) return null;
    return g.endTime.getTime() - g.startTime.getTime();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Traces</h1>
          <div className="sub">
            时间窗 {formatDateTime(from)} → {formatDateTime(to)} · 共 {total} 条
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Link
            className="btn"
            href={`/api/export/traces?${buildQuery({
              from,
              to,
              q,
              userId,
              sessionId,
              model,
              tags,
              level,
              env,
              agent,
            })}`}
            prefetch={false}
            title="按当前筛选条件导出 CSV"
          >
            导出 CSV
          </Link>
          <Link className="btn" href="/docs" prefetch={false}>
            如何接入？
          </Link>
        </div>
      </div>

      {/* 快捷时间窗 seg（点击重置其他筛选，仅设 from/to） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.6rem",
          flexWrap: "wrap",
        }}
      >
        <span className="mute2" style={{ fontSize: 12 }}>
          快捷时间窗
        </span>
        <span className="seg">
          {RANGES.map((r) => (
            <Link
              key={r.key}
              href={`/traces?${buildQuery({
                from: new Date(Date.now() - r.ms),
                to: new Date(),
                page: 1,
              })}`}
              prefetch={false}
              className={activeRange?.key === r.key ? "seg-btn active" : "seg-btn"}
            >
              {r.label}
            </Link>
          ))}
        </span>
      </div>

      {/* 过滤表单（GET 提交，纯服务端） */}
      <form className="card filter-bar" style={{ marginBottom: "1rem" }}>
        <label>
          <span>名称搜索</span>
          <input name="q" defaultValue={q ?? ""} placeholder="trace 名称..." />
        </label>
        <label>
          <span>用户</span>
          <input name="user" defaultValue={userId ?? ""} placeholder="userId 模糊匹配..." />
        </label>
        <label>
          <span>会话</span>
          <input name="session" defaultValue={sessionId ?? ""} placeholder="sessionId 模糊匹配..." />
        </label>
        <label>
          <span>模型</span>
          <input name="model" defaultValue={model ?? ""} placeholder="模型名，如 deepseek" />
        </label>
        <label>
          <span>Agent</span>
          <input name="agent" defaultValue={agent ?? ""} placeholder="agentName 模糊匹配..." />
        </label>
        <label>
          <span>标签</span>
          <input name="tag" defaultValue={tags.join(",")} placeholder="逗号分隔，全部命中" />
        </label>
        <label>
          <span>级别</span>
          <select name="level" defaultValue={level ?? ""}>
            <option value="">全部</option>
            <option value="ERROR">ERROR</option>
            <option value="WARNING">WARNING</option>
            <option value="DEFAULT">DEFAULT</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </label>
        <label>
          <span>环境</span>
          <select name="env" defaultValue={env ?? ""}>
            <option value="">全部</option>
            {envs.map((e) => (
              <option key={e.environment} value={e.environment}>
                {e.environment}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>起始时间</span>
          <input type="datetime-local" name="from" defaultValue={toLocalInput(from)} />
        </label>
        <label>
          <span>结束时间</span>
          <input type="datetime-local" name="to" defaultValue={toLocalInput(to)} />
        </label>
        <button type="submit" className="btn primary">
          查询
        </button>
        <Link className="btn" href="/traces" prefetch={false}>
          重置
        </Link>
      </form>

      {shown.length === 0 ? (
        <div className="card empty">
          <div className="icon">≡</div>
          该时间窗内没有 Trace。试试放宽时间范围，或先注入一条数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Agent</th>
                <th>Trace ID</th>
                {sortTh("时间", "time")}
                <th>用户</th>
                <th>模型</th>
                {sortTh("耗时", "latency")}
                {sortTh("Token", "token")}
                {sortTh("成本", "cost")}
                <th>Obs</th>
                <th>Score</th>
                <th>环境</th>
              </tr>
            </thead>
            <tbody>
              {sortedShown.map((t) => {
                const latency = firstGenLatency(t);
                const hasError = t.observations.some(
                  (o) => o.level === "ERROR",
                );
                const hasWarn = !hasError && t.observations.some(
                  (o) => o.level === "WARNING",
                );
                const models = Array.from(
                  new Set(
                    t.observations
                      .map((o) => o.model)
                      .filter(Boolean) as string[],
                  ),
                );
                return (
                  <tr
                    key={t.id}
                    data-level={hasError ? "ERROR" : hasWarn ? "WARNING" : undefined}
                  >
                    <td>
                      <Link href={`/traces/${t.id}`} prefetch={false}>
                        {hasError && (
                          <span
                            style={{ color: "var(--red)", marginRight: 4 }}
                            title="该 trace 含 ERROR observation"
                          >
                            ●
                          </span>
                        )}
                        {!hasError && hasWarn && (
                          <span
                            style={{ color: "var(--amber)", marginRight: 4 }}
                            title="该 trace 含 WARNING observation"
                          >
                            ●
                          </span>
                        )}
                        {t.name || <span className="mute2">（未命名）</span>}
                      </Link>
                      {t.tags.length > 0 && (
                        <div style={{ marginTop: 2 }}>
                          {t.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="badge" style={{ marginRight: 4 }}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {t.agentName ? (
                        <span className="badge green">{t.agentName}</span>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                      {t.skillName ? (
                        <span className="badge" style={{ marginLeft: 4 }}>
                          {t.skillName}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono muted" title={t.id}>{t.id.slice(0, 8)}</td>
                    <td className="muted" title={formatDateTime(t.timestamp)}>
                      {formatRelative(t.timestamp)}
                    </td>
                    <td className="mono muted">
                      {t.userId ? short(t.userId) : <span className="mute2">—</span>}
                    </td>
                    <td>
                      {models.length > 0 ? (
                        models.map((m) => (
                          <span key={m} className="badge purple" style={{ marginRight: 4 }}>
                            {m}
                          </span>
                        ))
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">
                      {latency != null ? (
                        <span
                          style={{
                            color:
                              latency < 2000
                                ? "var(--green)"
                                : latency < 8000
                                  ? "var(--amber)"
                                  : "var(--red)",
                          }}
                        >
                          {fmtMs(latency)}
                        </span>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td className="mono">
                      {formatTokens(
                        t.observations.reduce((s, o) => s + (o.totalTokens ?? 0), 0),
                      )}
                    </td>
                    <td className="mono" style={{ color: "var(--green)" }}>
                      {formatCost(
                        t.observations.reduce((s, o) => s + (o.totalCost ?? 0), 0),
                      )}
                    </td>
                    <td>
                      <span className="badge blue">{t._count.observations}</span>
                    </td>
                    <td>
                      {t.scores.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {t.scores.slice(0, 2).map((s) => (
                            <span
                              key={s.id}
                              className="badge amber"
                              title={`${s.name}: ${formatScoreValue(s.value, s.dataType)}`}
                            >
                              {short(s.name, 8)}: {formatScoreValue(s.value, s.dataType)}
                            </span>
                          ))}
                          {t._count.scores > 2 && (
                            <span className="badge">+{t._count.scores - 2}</span>
                          )}
                        </div>
                      ) : (
                        <span className="mute2">—</span>
                      )}
                    </td>
                    <td>
                      <span className="badge">{t.environment}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <span className="info">
          {shown.length === 0
            ? `0 / ${total} 条 · 第 ${page}/${totalPages} 页`
            : `显示 ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown.length} / ${total} 条 · 第 ${page}/${totalPages} 页`}
        </span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {page > 1 && (
            <Link
              className="btn"
              href={`/traces?${buildQuery({
                from,
                to,
                q,
                userId,
                sessionId,
                model,
                tags,
                level,
                env,
                agent,
                sort: sortKey,
                dir: sortDir,
                page: page - 1,
              })}`}
              prefetch={false}
            >
              ← 上一页
            </Link>
          )}
          {/* 跳页（GET 表单保留全部筛选与排序） */}
          <form
            action="/traces"
            method="get"
            style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}
          >
            <input type="hidden" name="from" value={from.toISOString()} />
            <input type="hidden" name="to" value={to.toISOString()} />
            {q ? <input type="hidden" name="q" value={q} /> : null}
            {userId ? <input type="hidden" name="user" value={userId} /> : null}
            {sessionId ? <input type="hidden" name="session" value={sessionId} /> : null}
            {model ? <input type="hidden" name="model" value={model} /> : null}
            {tags.length > 0 ? <input type="hidden" name="tag" value={tags.join(",")} /> : null}
            {level ? <input type="hidden" name="level" value={level} /> : null}
            {env ? <input type="hidden" name="env" value={env} /> : null}
            {agent ? <input type="hidden" name="agent" value={agent} /> : null}
            {sortKey !== "time" ? <input type="hidden" name="sort" value={sortKey} /> : null}
            {sortDir !== "desc" ? <input type="hidden" name="dir" value={sortDir} /> : null}
            <input
              type="number"
              name="page"
              min={1}
              max={totalPages}
              defaultValue={page}
              style={{
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0.35rem 0.5rem",
                color: "var(--text)",
                fontSize: 13,
                width: 64,
              }}
              aria-label="跳转到页码"
            />
            <button type="submit" className="btn-sm">
              跳转
            </button>
          </form>
          {page < totalPages && (
            <Link
              className="btn primary"
              href={`/traces?${buildQuery({
                from,
                to,
                q,
                userId,
                sessionId,
                model,
                tags,
                level,
                env,
                agent,
                sort: sortKey,
                dir: sortDir,
                page: page + 1,
              })}`}
              prefetch={false}
            >
              下一页 →
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function short(s: string, len = 10): string {
  return s.length <= len ? s : `${s.slice(0, len)}…`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatScoreValue(value: number, dataType: string): string {
  if (dataType === "NUMERIC") return value.toFixed(3);
  if (dataType === "BOOLEAN") return value ? "✓" : "✗";
  return String(value);
}

function buildQuery(p: {
  from: Date;
  to: Date;
  q?: string;
  userId?: string;
  sessionId?: string;
  model?: string;
  tags?: string[];
  level?: string;
  env?: string;
  agent?: string;
  sort?: string;
  dir?: string;
  page?: number;
}): string {
  const params = new URLSearchParams();
  params.set("from", p.from.toISOString());
  params.set("to", p.to.toISOString());
  if (p.q) params.set("q", p.q);
  if (p.userId) params.set("user", p.userId);
  if (p.sessionId) params.set("session", p.sessionId);
  if (p.model) params.set("model", p.model);
  if (p.tags && p.tags.length > 0) params.set("tag", p.tags.join(","));
  if (p.level) params.set("level", p.level);
  if (p.env) params.set("env", p.env);
  if (p.agent) params.set("agent", p.agent);
  if (p.sort && p.sort !== "time") params.set("sort", p.sort);
  if (p.dir && p.dir !== "desc") params.set("dir", p.dir);
  if (p.page && p.page > 1) params.set("page", String(p.page));
  return params.toString();
}
