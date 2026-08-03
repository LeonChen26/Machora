import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { prisma } from "@machora/shared";
import {
  formatRelative,
  formatDateTime,
  formatTokens,
  formatCost,
} from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireUser();
  const projectId = await getCurrentProjectId();
  const traces = await prisma.trace.findMany({
    where: { projectId, userId: { not: null } },
    select: {
      userId: true,
      timestamp: true,
      observations: {
        select: {
          totalTokens: true,
          totalCost: true,
          level: true,
        },
      },
      _count: { select: { scores: true } },
    },
  });

  // 按 userId 聚合
  const byUser = new Map<
    string,
    {
      userId: string;
      traceCount: number;
      obsCount: number;
      tokens: number;
      cost: number;
      errors: number;
      last: Date;
    }
  >();
  for (const t of traces) {
    const uid = t.userId!;
    const u = byUser.get(uid) ?? {
      userId: uid,
      traceCount: 0,
      obsCount: 0,
      tokens: 0,
      cost: 0,
      errors: 0,
      last: t.timestamp,
    };
    u.traceCount++;
    u.obsCount += t.observations.length;
    for (const o of t.observations) {
      u.tokens += o.totalTokens ?? 0;
      u.cost += o.totalCost ?? 0;
      if (o.level === "ERROR") u.errors++;
    }
    if (t.timestamp > u.last) u.last = t.timestamp;
    byUser.set(uid, u);
  }

  const users = Array.from(byUser.values()).sort(
    (a, b) => b.last.getTime() - a.last.getTime(),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Users</h1>
          <div className="sub">
            按 userId 聚合的用户 · 共 {users.length} 个
          </div>
        </div>
      </div>

      {users.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="target" />
          暂无用户数据。注入 trace 时带上 userId 即可聚合。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Traces</th>
                <th scope="col">Obs</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
                <th scope="col">ERROR</th>
                <th scope="col">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId}>
                  <td>
                    <Link
                      href={`/traces?user=${encodeURIComponent(u.userId)}`}
                      prefetch={false}
                    >
                      <span className="mono">{u.userId}</span>
                    </Link>
                  </td>
                  <td>
                    <span className="badge blue">{u.traceCount}</span>
                  </td>
                  <td>
                    <span className="badge blue">{u.obsCount}</span>
                  </td>
                  <td className="mono">{formatTokens(u.tokens)}</td>
                  <td
                    className={u.cost > 0 ? "mono cost" : "mono"}
                  >
                    {formatCost(u.cost)}
                  </td>
                  <td>
                    {u.errors > 0 ? (
                      <span className="badge red">{u.errors}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
                  </td>
                  <td className="muted" title={formatDateTime(u.last)}>
                    {formatRelative(u.last)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
