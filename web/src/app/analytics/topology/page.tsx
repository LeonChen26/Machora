import { Link } from "../../../components/NativeLink";
import { EmptyIcon } from "../../../components/EmptyIcon";
import { TopologyDiagram } from "../../../components/topology/TopologyDiagram";
import { getCurrentProjectId } from "../../../server/project";
import { requireUser } from "../../../server/session";
import { buildTopology } from "../../../server/topology";
import { formatDuration, formatTokens, formatCost } from "../../../lib/format";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_OPTIONS = [7, 14, 30] as const;

export default async function TopologyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const sp = await searchParams;
  const str = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const rawDays = Number.parseInt(str(sp.days) ?? "", 10);
  const days = (DAY_OPTIONS as readonly number[]).includes(rawDays) ? rawDays : 7;

  const projectId = await getCurrentProjectId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);

  const topo = await buildTopology(projectId, since);

  const agentTools = new Map(
    topo.agents.map((a) => [
      a.name,
      topo.tools.filter((t) => t.agent === a.name),
    ]),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent 拓扑</h1>
          <div className="sub">
            近 {days} 天 · {topo.agents.length} 个 Agent · {topo.tools.length} 个工具 ·{" "}
            {topo.models.length} 个模型 · {topo.totalTraces} 条 Trace
          </div>
        </div>
      </div>

      <div className="seg">
        {DAY_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/analytics/topology?days=${d}`}
            prefetch={false}
            className={d === days ? "seg-btn active" : "seg-btn"}
            aria-current={d === days ? "true" : undefined}
          >
            {d} 天
          </Link>
        ))}
        <span className="spacer" />
        <Link href="/analytics" prefetch={false} className="seg-btn">
          返回总览
        </Link>
      </div>

      <div className="section-title">
        依赖拓扑 <span className="count">线宽 = 调用/共现强度 · 每层 Top 10</span>
      </div>
      <div className="card">
        {topo.agents.length === 0 && topo.tools.length === 0 ? (
          <div className="card empty">
            <EmptyIcon type="grid" />
            近 {days} 天暂无 Agent 语义数据（需要 gen_ai.agent.name 或 tool 节点）。
          </div>
        ) : (
          <TopologyDiagram
            agents={topo.agents}
            tools={topo.tools}
            models={topo.models}
          />
        )}
      </div>

      <div className="section-title">
        按 Agent 汇总 <span className="count">gen_ai.agent.name / trace.agentName 维度</span>
      </div>
      {topo.agents.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">工具</th>
                <th scope="col">工具调用</th>
                <th scope="col">模型调用</th>
                <th scope="col">Token</th>
                <th scope="col">成本</th>
              </tr>
            </thead>
            <tbody>
              {topo.agents.map((a) => {
                const ts = agentTools.get(a.name) ?? [];
                return (
                  <tr key={a.name}>
                    <td>
                      <span className="badge green">{a.name}</span>
                    </td>
                    <td>
                      {ts.length === 0 ? (
                        <span className="mute2">—</span>
                      ) : (
                        ts.slice(0, 8).map((t) => (
                          <span key={t.name} className="badge mr-1">
                            {t.name} <span className="count">{t.count}</span>
                          </span>
                        ))
                      )}
                      {ts.length > 8 && <span className="mute2">+{ts.length - 8}</span>}
                    </td>
                    <td className="mono">{a.toolCalls}</td>
                    <td className="mono">{a.llmCalls}</td>
                    <td className="mono">{formatTokens(a.tokens)}</td>
                    <td className={a.cost > 0 ? "mono cost" : "mono"}>
                      {formatCost(a.cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="section-title">
        按工具汇总 <span className="count">关联模型 = 同 Trace 共现</span>
      </div>
      {topo.tools.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="grid" />
          暂无工具调用数据。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">工具</th>
                <th scope="col">归属 Agent</th>
                <th scope="col">调用数</th>
                <th scope="col">平均耗时</th>
                <th scope="col">ERROR</th>
                <th scope="col">WARNING</th>
                <th scope="col">关联模型</th>
              </tr>
            </thead>
            <tbody>
              {topo.tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <span className="badge blue">{t.name}</span>
                  </td>
                  <td>
                    <span className="badge green">{t.agent}</span>
                  </td>
                  <td className="mono">{t.count}</td>
                  <td className="mono">{formatDuration(t.avgDur)}</td>
                  <td>
                    {t.errors > 0 ? (
                      <span className="badge red">{t.errors}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
                  </td>
                  <td>
                    {t.warnings > 0 ? (
                      <span className="badge amber">{t.warnings}</span>
                    ) : (
                      <span className="mute2">0</span>
                    )}
                  </td>
                  <td>
                    {t.models.length === 0 ? (
                      <span className="mute2">—</span>
                    ) : (
                      t.models.slice(0, 5).map((m) => (
                        <span key={m.name} className="badge purple mr-1">
                          {m.name} <span className="count">{m.count}</span>
                        </span>
                      ))
                    )}
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
