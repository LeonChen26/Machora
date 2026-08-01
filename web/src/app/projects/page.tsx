import { Link } from "../../components/NativeLink";
import { prisma } from "@machora/shared";
import { formatDateTime, formatRelative } from "../../lib/format";
import { getCurrentProjectId } from "../../server/project";
import { CreateProjectForm } from "./CreateProjectForm";
import { DeleteProjectButton } from "./DeleteProjectButton";
import { EnterProjectButton } from "./EnterProjectButton";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const [projects, currentId, obsGroups, scoreGroups] = await Promise.all([
    prisma.project.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { traces: true, apiKeys: true } },
        apiKeys: { select: { publicKey: true, id: true } },
      },
    }),
    getCurrentProjectId(),
    prisma.observation.groupBy({
      by: ["projectId"],
      _count: { _all: true },
    }),
    prisma.score.groupBy({
      by: ["projectId"],
      _count: { _all: true },
    }),
  ]);

  const obsByProject = new Map(obsGroups.map((g) => [g.projectId, g._count._all]));
  const scoreByProject = new Map(scoreGroups.map((g) => [g.projectId, g._count._all]));
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
          <div className="icon">▤</div>
          暂无项目，用上方表单创建一个。
        </div>
      ) : (
        <div className="grid grid-2">
          {projects.map((p) => {
            const isCurrent = p.id === currentId;
            return (
              <div
                className="card"
                key={p.id}
                style={isCurrent ? { borderColor: "var(--accent)" } : undefined}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <strong style={{ fontSize: 16 }}>{p.name}</strong>
                  <span>
                    {isCurrent && <span className="badge blue" style={{ marginRight: 6 }}>当前</span>}
                    <span className="badge">{p._count.traces} traces</span>
                  </span>
                </div>
                <div className="mono mute2" style={{ fontSize: 11, marginTop: 4, marginBottom: 12 }}>
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
                  <div style={{ marginTop: 12 }}>
                    <div className="mute2" style={{ fontSize: 11, marginBottom: 4 }}>
                      PUBLIC KEY
                    </div>
                    <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                      {p.apiKeys[0].publicKey}
                    </div>
                  </div>
                )}
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
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
