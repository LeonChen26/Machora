// 数据集：评测资产页。Tag 数据集（trace 标签派生，只读概览）+ Prompt 级数据集（用例管理）。
// 批量评测的「操作」入口留在 /evaluations，本页只做资产查看与管理。
import { Link } from "../../components/NativeLink";
import { EmptyIcon } from "../../components/EmptyIcon";
import { asc } from "drizzle-orm";
import { db, evaluationConfig, trace } from "@machora/shared";
import { DatasetManager } from "./DatasetManager";

export const dynamic = "force-dynamic";

export default async function DatasetsPage() {
  const [configs, tagRows] = await Promise.all([
    db.query.evaluationConfig.findMany({
      orderBy: (t, { asc }) => [asc(t.createdAt)],
      columns: { id: true, name: true, evaluatorType: true },
    }),
    db.select({ tags: trace.tags }).from(trace).limit(500),
  ]);

  const byTag = new Map<string, number>();
  for (const r of tagRows) {
    for (const tag of r.tags ?? []) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
  }
  const tags = Array.from(byTag.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>数据集</h1>
          <div className="sub">
            评测资产 · {tags.length} 个 Tag 数据集 · {configs.length} 个评估配置
          </div>
        </div>
        <Link className="btn" href="/evaluations?tab=batch" prefetch={false}>
          去发起批量评测 →
        </Link>
      </div>

      <div className="section-title">
        Tag 数据集 <span className="count">由 trace 标签派生 · 只读</span>
      </div>
      {tags.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无 Tag 数据。给 trace 打上标签后即可按标签批量评测。
        </div>
      ) : (
        <div className="card mb-3">
          <div className="form-inline">
            {tags.map((t) => (
              <Link
                key={t.tag}
                href={`/traces?tag=${encodeURIComponent(t.tag)}`}
                prefetch={false}
                className="badge"
                title={`查看带 ${t.tag} 标签的 trace`}
              >
                {t.tag} <span className="count">{t.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">
        Prompt 级数据集 <span className="count">独立用例 · 不依赖 trace</span>
      </div>
      <DatasetManager
        configs={configs.map((c) => ({
          id: c.id,
          name: c.name,
          evaluatorType: c.evaluatorType,
        }))}
      />
    </>
  );
}
