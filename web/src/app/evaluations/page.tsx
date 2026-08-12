// 评估中心：任务（Tab 1）+ 配置（Tab 2）+ 数据集（Tab 3，占位后续）
// SSR 直查 db（force-dynamic），交互走 /api/evaluations REST
import { Link } from "../../components/NativeLink";
import { and, desc, eq } from "drizzle-orm";
import { db, evaluation, evaluationConfig, trace } from "@machora/shared";
import { formatRelative, formatDateTime } from "../../lib/format";
import { EmptyIcon } from "../../components/EmptyIcon";
import { getCurrentProjectId } from "../../server/project";
import { requireUser } from "../../server/session";
import { EvalConfigForm } from "./EvalConfigForm";
import { EvalConfigActions } from "./EvalConfigActions";
import { DatasetBatchPanel } from "./DatasetBatchPanel";

export const dynamic = "force-dynamic";

const TAB_KEYS = ["tasks", "config", "datasets"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "待执行", cls: "idle" },
  RUNNING: { label: "运行中", cls: "run" },
  COMPLETED: { label: "完成", cls: "ok" },
  ERROR: { label: "失败", cls: "err" },
};

export default async function EvaluationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const tabRaw = str(sp.tab);
  const tab: TabKey = TAB_KEYS.includes(tabRaw as TabKey) ? (tabRaw as TabKey) : "tasks";

  const projectId = await getCurrentProjectId();

  // 任务列表
  const tasks =
    tab === "tasks" && projectId
      ? await db.query.evaluation.findMany({
          where: eq(evaluation.projectId, projectId),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
          limit: 200,
          with: { trace: true },
        })
      : [];

  const taskCount = tasks.length;
  const okCount = tasks.filter((t) => t.status === "COMPLETED").length;
  const errCount = tasks.filter((t) => t.status === "ERROR").length;
  const runCount = tasks.filter((t) => t.status === "RUNNING").length;

  // 配置列表
  const configs =
    (tab === "config" || tab === "datasets") && projectId
      ? await db.query.evaluationConfig.findMany({
          where: eq(evaluationConfig.projectId, projectId),
          orderBy: (t, { asc }) => [asc(t.createdAt)],
        })
      : [];

  // 数据集占位：trace 按 tag 分组计数（后续扩展为 Dataset 表）
  const datasets: { tag: string; count: number }[] = [];
  if (tab === "datasets" && projectId) {
    const rows = await db
      .select({ tag: trace.tags })
      .from(trace)
      .where(eq(trace.projectId, projectId))
      .limit(500);
    const byTag = new Map<string, number>();
    for (const r of rows) {
      for (const tag of r.tag ?? []) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      }
    }
    for (const [tag, count] of byTag.entries()) {
      datasets.push({ tag, count });
    }
    datasets.sort((a, b) => b.count - a.count);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>评估</h1>
          <div className="sub">LLM judge 与规则评估任务 · 配置管理</div>
        </div>
      </div>

      <div className="seg mb-3">
        <Link
          href="/evaluations?tab=tasks"
          prefetch={false}
          className={tab === "tasks" ? "seg-btn active" : "seg-btn"}
          aria-current={tab === "tasks" ? "true" : undefined}
        >
          任务
        </Link>
        <Link
          href="/evaluations?tab=config"
          prefetch={false}
          className={tab === "config" ? "seg-btn active" : "seg-btn"}
          aria-current={tab === "config" ? "true" : undefined}
        >
          配置
        </Link>
        <Link
          href="/evaluations?tab=datasets"
          prefetch={false}
          className={tab === "datasets" ? "seg-btn active" : "seg-btn"}
          aria-current={tab === "datasets" ? "true" : undefined}
        >
          数据集
        </Link>
      </div>

      {tab === "tasks" && (
        <>
          <div className="grid grid-4 mb-3">
            <div className="card">
              <div className="label">总任务</div>
              <div className="value text-accent">{taskCount}</div>
            </div>
            <div className="card">
              <div className="label">成功</div>
              <div className="value text-accent">{okCount}</div>
            </div>
            <div className="card">
              <div className="label">失败</div>
              <div className="value text-accent">{errCount}</div>
            </div>
            <div className="card">
              <div className="label">运行中</div>
              <div className="value text-accent">{runCount}</div>
            </div>
          </div>

          {tasks.length === 0 ? (
            <div className="card empty">
              <EmptyIcon type="star" />
              暂无评估任务。请先在「配置」页创建评估配置，或从 Trace 详情页触发评估。
            </div>
          ) : (
            <div className="card p-0">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">评估器</th>
                      <th scope="col">任务名</th>
                      <th scope="col">目标 Trace</th>
                      <th scope="col">状态</th>
                      <th scope="col">结果</th>
                      <th scope="col">耗时</th>
                      <th scope="col">创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const sm = STATUS_META[t.status] ?? { label: t.status, cls: "idle" };
                      const result = (t.result ?? {}) as Record<string, unknown>;
                      const val = result.value;
                      const dataType = result.dataType as string | undefined;
                      const comment = (result.comment as string | undefined) ?? t.error;
                      return (
                        <tr key={t.id}>
                          <td>
                            <span className={`badge ${t.evaluatorType === "llm" ? "blue" : ""}`}>
                              {t.evaluatorType === "llm" ? "LLM" : "规则"}
                            </span>
                          </td>
                          <td title={comment ?? undefined}>{t.name}</td>
                          <td>
                            <Link
                              href={`/traces/${encodeURIComponent(t.traceId)}`}
                              prefetch={false}
                              className="mono muted text-xs"
                              title={t.traceId}
                            >
                              {t.traceId.slice(0, 12)}…
                            </Link>
                          </td>
                          <td>
                            <span className={`badge ${sm.cls}`} title={t.status === "ERROR" ? t.error ?? undefined : undefined}>
                              {sm.label}
                            </span>
                          </td>
                          <td>
                            {val === undefined ? (
                              <span className="mute2">—</span>
                            ) : dataType === "BOOLEAN" ? (
                              <span className="mono">{val ? "✓" : "✗"}</span>
                            ) : (
                              <span className="mono">{Number(val).toFixed(3)}</span>
                            )}
                          </td>
                          <td className="mono muted text-xs">
                            {typeof result.durationMs === "number"
                              ? `${(result.durationMs / 1000).toFixed(1)}s`
                              : "—"}
                          </td>
                          <td className="mono muted text-xs" title={formatDateTime(t.createdAt)}>
                            {formatRelative(t.createdAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "config" && (
        <>
          <EvalConfigForm />
          {configs.length === 0 ? (
            <div className="card empty">
              <EmptyIcon type="star" />
              暂无评估配置。创建 LLM judge 或规则配置后，可从 Trace 详情页一键评估。
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
              {configs.map((c) => {
                const cfg = (c.config ?? {}) as Record<string, unknown>;
                const isLlm = c.evaluatorType === "llm";
                return (
                  <div className="card" key={c.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="flex-between">
                      <div className="label" style={{ margin: 0 }}>
                        {c.name}
                        {!c.enabled && <span className="badge idle ml-1">已停用</span>}
                      </div>
                      <span className={`badge ${isLlm ? "blue" : ""}`}>
                        {isLlm ? "LLM judge" : `规则 · ${c.evaluatorType}`}
                      </span>
                    </div>
                    <div className="text-sm muted" style={{ lineHeight: 1.7 }}>
                      {isLlm ? (
                        <>
                          <div>模型：<code className="mono">{String(cfg.model ?? "—")}</code></div>
                          <div>端点：<code className="mono">{String(cfg.apiBase ?? "https://api.openai.com/v1")}</code></div>
                          <div>轨迹摘要：{cfg.includeTrajectory === false ? "关" : "开"}</div>
                          {cfg.systemPrompt && (
                            <div className="text-xs" style={{ opacity: 0.8 }}>提示词：{(cfg.systemPrompt as string).slice(0, 60)}…</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div>
                            参数：
                            {c.evaluatorType === "latency" && `thresholdMs=${cfg.thresholdMs ?? 5000}`}
                            {c.evaluatorType === "cost" && `thresholdUsd=${cfg.thresholdUsd ?? 0.01}`}
                            {c.evaluatorType === "token" && `thresholdTokens=${cfg.thresholdTokens ?? 10000}`}
                            {c.evaluatorType === "tag" && `tag=${cfg.tag ?? ""}`}
                            {c.evaluatorType === "error" && "（内置）"}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="form-inline" style={{ marginTop: "auto" }}>
                      <EvalConfigActions
                        row={{ ...c, config: (c.config ?? {}) as Record<string, unknown> }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "datasets" && (
        <>
          <DatasetBatchPanel
            tags={datasets}
            configs={configs.map((c) => ({
              id: c.id,
              name: c.name,
              evaluatorType: c.evaluatorType,
            }))}
          />
          <div className="section-title">
            数据集（按 tag） <span className="count">{datasets.length}</span>
          </div>
          {datasets.length === 0 ? (
            <div className="card empty">
              <EmptyIcon type="star" />
              暂无带标签的 trace。给 trace 打上 tag 后会自动出现在这里，可作数据集批量评测。
            </div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {datasets.map((d) => (
                <div className="card" key={d.tag}>
                  <div className="label">{d.tag}</div>
                  <div className="value text-accent">{d.count}</div>
                  <div className="hint">traces · 选中后在左上方批量评测</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
