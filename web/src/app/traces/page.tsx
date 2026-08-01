import Link from "next/link";
import { prisma } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

// 默认时间窗：最近 7 天
function defaultWindow(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from, to };
}

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  const projectId = await getCurrentProjectId();
  const defaults = defaultWindow();
  const fromStr = str(sp.from);
  const toStr = str(sp.to);
  const from = fromStr ? new Date(fromStr) : defaults.from;
  const to = toStr ? new Date(toStr) : defaults.to;
  const cursor = str(sp.cursor);
  const q = str(sp.q)?.trim();
  const userId = str(sp.user)?.trim();
  const sessionId = str(sp.session)?.trim();
  const model = str(sp.model)?.trim();
  const tagRaw = str(sp.tag)?.trim();
  const tags = tagRaw
    ? tagRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const level = str(sp.level)?.trim();

  const where = {
    projectId,
    timestamp: { gte: from, lte: to },
    ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
    ...(userId
      ? { userId: { contains: userId, mode: "insensitive" as const } }
      : {}),
    ...(sessionId
      ? { sessionId: { contains: sessionId, mode: "insensitive" as const } }
      : {}),
    ...(model
      ? {
          observations: {
            some: { model: { contains: model, mode: "insensitive" as const } },
          },
        }
      : {}),
    ...(level
      ? { observations: { some: { level } } }
      : {}),
    ...(tags.length > 0 ? { tags: { hasEvery: tags } } : {}),
  };

  const items = await prisma.trace.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: PAGE_SIZE + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    include: {
      observations: {
        select: { model: true, type: true, startTime: true, endTime: true },
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
  const hasNext = items.length > PAGE_SIZE;
  const shown = hasNext ? items.slice(0, PAGE_SIZE) : items;
  const nextCursor = hasNext ? items[items.length - 1].id : null;

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
        <Link className="btn" href="/docs" prefetch={false}>
          如何接入？
        </Link>
      </div>

      {/* 过滤表单（GET 提交，纯服务端） */}
      <form
        className="card"
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            名称搜索
          </span>
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="trace 名称..."
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            用户
          </span>
          <input
            name="user"
            defaultValue={userId ?? ""}
            placeholder="userId 模糊匹配..."
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            会话
          </span>
          <input
            name="session"
            defaultValue={sessionId ?? ""}
            placeholder="sessionId 模糊匹配..."
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            模型
          </span>
          <input
            name="model"
            defaultValue={model ?? ""}
            placeholder="模型名，如 deepseek"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            标签
          </span>
          <input
            name="tag"
            defaultValue={tagRaw ?? ""}
            placeholder="逗号分隔，全部命中"
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            级别
          </span>
          <select name="level" defaultValue={level ?? ""} style={inputStyle}>
            <option value="">全部</option>
            <option value="ERROR">ERROR</option>
            <option value="WARNING">WARNING</option>
            <option value="DEFAULT">DEFAULT</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            起始时间
          </span>
          <input
            type="datetime-local"
            name="from"
            value={toLocalInput(from)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="mute2" style={{ fontSize: 12 }}>
            结束时间
          </span>
          <input
            type="datetime-local"
            name="to"
            value={toLocalInput(to)}
            style={inputStyle}
          />
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
                <th>Trace ID</th>
                <th>时间</th>
                <th>用户</th>
                <th>模型</th>
                <th>耗时</th>
                <th>Obs</th>
                <th>Score</th>
                <th>环境</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const latency = firstGenLatency(t);
                const models = Array.from(
                  new Set(
                    t.observations
                      .map((o) => o.model)
                      .filter(Boolean) as string[],
                  ),
                );
                return (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/traces/${t.id}`} prefetch={false}>
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
                    <td className="mono muted">{t.id}</td>
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
          显示 {shown.length} / {total} 条
        </span>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {cursor && (
            <Link className="btn" href="/traces" prefetch={false}>
              ← 首页
            </Link>
          )}
          {nextCursor && (
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
                cursor: nextCursor,
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

const inputStyle: React.CSSProperties = {
  background: "var(--bg-elev-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.35rem 0.6rem",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "var(--mono)",
};

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
  cursor?: string;
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
  if (p.cursor) params.set("cursor", p.cursor);
  return params.toString();
}
