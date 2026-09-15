// Agent 归属单一真源。
//
// 历史缺陷：Overview / Topology 用「observation.agentName ?? trace.agentName」，
// 而 agentStats / modelStats 及对应 SQL 用「trace.agentName ?? observation.agentName」，
// 两套优先级相反，导致同一 Agent 在 /、/agents、/models、/topology 得到
// 不同的调用 / 失败数（Overview 风险榜甚至出现半行）。
//
// 统一规则（trace 级为权威字段，span 级兜底，两者皆空归 unknown），与 SQL 侧
// COALESCE(trace.agentName, observation.agentName) 完全一致。

/** 归属维度无法确定时的归类名（trace / observation 的 agentName 均为空） */
export const AGENT_UNKNOWN = "unknown";

/** Agent 归属：trace.agentName ?? observation.agentName ?? "unknown" */
export function resolveAgentName(
  traceAgent: string | null | undefined,
  obsAgent: string | null | undefined,
): string {
  return traceAgent ?? obsAgent ?? AGENT_UNKNOWN;
}
