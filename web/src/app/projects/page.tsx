import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { desc, count } from "drizzle-orm";
import { db, project, observation, score, trace } from "@machora/shared";
import { formatDateTime, formatRelative } from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";
import { CreateProjectForm } from "./CreateProjectForm";
import { DeleteProjectButton } from "./DeleteProjectButton";
import { EnterProjectButton } from "./EnterProjectButton";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  await requireUser();
  const [projects, currentId, obsGroups, scoreGroups] = await Promise.all([
    (async () => {
      const rows = await db.query.project.findMany({
        orderBy: (p, { desc }) => [desc(p.createdAt)],
        with: { apiKeys: { columns: { publicKey: true, id: true } } },
      });
      // _count.traces：trace 表按 projectId 聚合；_count.apiKeys 用 apiKeys.length
      const traceGroups = await db
        .select({ projectId: trace.projectId, c: count() })
        .from(trace)
        .groupBy(trace.projectId);
      const traceCountBy = new Map(traceGroups.map((g) => [g.projectId, g.c]));
      return rows.map((p) => ({
        ...p,
        _count: { traces: traceCountBy.get(p.id) ?? 0, apiKeys: p.apiKeys.length },
      }));
    })(),
    getCurrentProjectId(),
    db
      .select({ projectId: observation.projectId, _all: count() })
      .from(observation)
      .groupBy(observation.projectId),
    db
      .select({ projectId: score.projectId, _all: count() })
      .from(score)
      .groupBy(score.projectId),
  ]);

  const obsByProject = new Map(obsGroups.map((g) => [g.projectId, g._all]));
  const scoreByProject = new Map(scoreGroups.map((g) => [g.projectId, g._all]));
  const canDelete = projects.length > 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="sub">共 {projects.length} 个项目 · 当前：{currentId}</div>
        </div>
      </div>

      <CreateProjectForm />

      {projects.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="folder" />
          暂无项目，用上方表单创建一个。
        </div>
      ) : (
        <div className="grid grid-2">
          {projects.map((p) => {
            const isCurrent = p.id === currentId;
            return (
              <div
                className={isCurrent ? "card card-active" : "card"}
                key={p.id}
              >
                <div className="card-head">
                  <span className="card-title">{p.name}</span>
                  <span>
                    {isCurrent && <span className="badge blue" style={{ marginRight: 6 }}>当前</span>}
                    <span className="badge">{p._count.traces} traces</span>
                  </span>
                </div>
                <div className="mono mute2 text-xs" style={{ marginTop: 4, marginBottom: 12 }}>
                  {p.id}
                </div>
                <dl className="kv">
                  <dt>创建时间</dt>
                  <dd className="muted" title={formatDateTime(p.createdAt)}>
                    {formatRelative(p.createdAt)}
                  </dd>
                  <dt>Traces</dt>
                  <dd>{p._count.traces}</dd>
                  <dt>Observations</dt>
                  <dd>{obsByProject.get(p.id) ?? 0}</dd>
                  <dt>Scores</dt>
                  <dd>{scoreByProject.get(p.id) ?? 0}</dd>
                  <dt>API Keys</dt>
                  <dd>{p._count.apiKeys}</dd>
                </dl>
                {p.apiKeys.length > 0 && (
                  <div className="mt-2">
                    <div className="mute2 text-xs mb-1">
                      PUBLIC KEY
                    </div>
                    <div className="mono text-sm" style={{ wordBreak: "break-all" }}>
                      {p.apiKeys[0].publicKey}
                    </div>
                  </div>
                )}
                <div className="btn-group mt-2">
                  <EnterProjectButton id={p.id} />
                  {canDelete && <DeleteProjectButton id={p.id} name={p.name} isCurrent={isCurrent} />}
                  <Link className="btn" href="/api-keys" prefetch={false}>
                    API Keys
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
