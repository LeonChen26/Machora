// 跨 Trace 拓扑（Agent Ontology 简化版）：Agent → Tool → Model 依赖聚合。
// 复用轨迹分类器识别 tool / llm 节点；Tool↔Model 边为同 trace 共现计数（关联强度），
// Agent 归属统一走 ./attribution.resolveAgentName：trace.agentName ?? observation.agentName ?? "unknown"。

import { and, asc, eq, gte } from "drizzle-orm";
import {
  db,
  observation,
  trace,
  classifyTrajectoryKind,
} from "@machora/shared";
import { resolveAgentName } from "./attribution";
import { afterCursor, scanBatches, type ScanCursor } from "./scan";

// get-or-init：Map 缺 key 时用工厂初始化并写入，避免 ?? set().get()! 的非空断言模式
function getOrInit<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = init();
    map.set(key, v);
  }
  return v;
}

export interface TopologyModel {
  name: string;
  count: number;
  tokens: number;
  cost: number;
}

export interface TopologyTool {
  name: string;
  agent: string;
  count: number;
  errors: number;
  warnings: number;
  avgDur: number | null; // ms
  models: { name: string; count: number }[]; // 同 trace 共现，按次数降序
}

export interface TopologyAgent {
  name: string;
  toolCount: number; // 不同工具数
  toolCalls: number;
  llmCalls: number;
  tokens: number;
  cost: number;
}

export interface TopologyData {
  agents: TopologyAgent[];
  tools: TopologyTool[];
  models: TopologyModel[];
  totalTraces: number;
}

interface AgentAcc {
  tools: Set<string>;
  toolCalls: number;
  llmCalls: number;
  tokens: number;
  cost: number;
}

interface ToolAcc {
  name: string;
  agent: string;
  count: number;
  errors: number;
  warnings: number;
  durs: number[];
}

/** (agent, tool) 复合键：同一工具被多个 agent 使用时各自独立统计 */
function toolKeyOf(agent: string, toolName: string): string {
  return `${agent}\u0000${toolName}`;
}

export async function buildTopology(since: Date): Promise<TopologyData> {
  // trace 级：工具集合 + 模型集合 + agent 归属（tool↔model 共现边用）
  const perTrace = new Map<
    string,
    { tools: Map<string, number>; models: Set<string> }
  >();
  const toolMap = new Map<string, ToolAcc>();
  const modelMap = new Map<string, TopologyModel>();
  const agentMap = new Map<string, AgentAcc>();

  // 窗口内 observation 分批扫描，批间让出事件循环：
  // better-sqlite3 同步驱动，一次性全量读取会在整段期间独占事件循环
  const fetchBatch = (after: ScanCursor | null, limit: number) => {
    const cur = afterCursor(observation.startTime, observation.id, after);
    return db
      .select({
        obsId: observation.id,
        traceId: observation.traceId,
        type: observation.type,
        name: observation.name,
        model: observation.model,
        agentName: observation.agentName,
        level: observation.level,
        startTime: observation.startTime,
        endTime: observation.endTime,
        totalTokens: observation.totalTokens,
        totalCost: observation.totalCost,
        metadata: observation.metadata,
        parentObservationId: observation.parentObservationId,
        traceAgent: trace.agentName,
      })
      .from(observation)
      .leftJoin(trace, eq(observation.traceId, trace.id))
      .where(
        cur ? and(gte(observation.startTime, since), cur) : gte(observation.startTime, since),
      )
      .orderBy(asc(observation.startTime), asc(observation.id))
      .limit(limit);
  };

  for await (const batch of scanBatches(fetchBatch, (r) => ({
    ts: r.startTime,
    id: r.obsId,
  }))) {
    for (const r of batch) {
      const kind = classifyTrajectoryKind({
        type: r.type,
        metadata: r.metadata,
        model: r.model,
        agentName: r.agentName,
        workflowName: null,
        skillName: null,
        hasParent: r.parentObservationId != null,
      });
      const agent = resolveAgentName(r.traceAgent, r.agentName);
      const t = getOrInit(perTrace, r.traceId, () => ({
        tools: new Map(),
        models: new Set(),
      }));

      if (kind === "tool" && r.name) {
        const toolName = r.name;
        const toolKey = toolKeyOf(agent, toolName);
        t.tools.set(toolKey, (t.tools.get(toolKey) ?? 0) + 1);
        const s = getOrInit(toolMap, toolKey, () => ({
          name: toolName,
          agent,
          count: 0,
          errors: 0,
          warnings: 0,
          durs: [],
        }));
        s.count++;
        if (r.level === "ERROR") s.errors++;
        if (r.level === "WARNING") s.warnings++;
        if (r.endTime) s.durs.push(r.endTime.getTime() - r.startTime.getTime());
        const a = getOrInit(agentMap, agent, () => ({
          tools: new Set<string>(),
          toolCalls: 0,
          llmCalls: 0,
          tokens: 0,
          cost: 0,
        }));
        a.toolCalls++;
        a.tools.add(toolName);
      } else if (kind === "llm" && r.model) {
        t.models.add(r.model);
        const m = getOrInit(modelMap, r.model, () => ({
          name: r.model,
          count: 0,
          tokens: 0,
          cost: 0,
        }));
        m.count++;
        m.tokens += r.totalTokens ?? 0;
        m.cost += r.totalCost ?? 0;
        const a = getOrInit(agentMap, agent, () => ({
          tools: new Set<string>(),
          toolCalls: 0,
          llmCalls: 0,
          tokens: 0,
          cost: 0,
        }));
        a.llmCalls++;
        a.tokens += r.totalTokens ?? 0;
        a.cost += r.totalCost ?? 0;
      }
    }
  }

  // tool → model 共现边（同 trace 内各计一次，关联强度）；键与 toolMap 一致为 (agent, tool)
  const edgeMap = new Map<string, Map<string, number>>();
  for (const t of perTrace.values()) {
    for (const toolKey of t.tools.keys()) {
      if (t.models.size === 0) continue;
      const m = edgeMap.get(toolKey) ?? new Map<string, number>();
      for (const model of t.models) m.set(model, (m.get(model) ?? 0) + 1);
      edgeMap.set(toolKey, m);
    }
  }

  const agents = Array.from(agentMap.entries())
    .map(([name, a]) => ({
      name,
      toolCount: a.tools.size,
      toolCalls: a.toolCalls,
      llmCalls: a.llmCalls,
      tokens: a.tokens,
      cost: a.cost,
    }))
    .sort((x, y) => y.toolCalls + y.llmCalls - (x.toolCalls + x.llmCalls));

  const tools = Array.from(toolMap.entries())
    .map(([toolKey, s]) => ({
      name: s.name,
      agent: s.agent,
      count: s.count,
      errors: s.errors,
      warnings: s.warnings,
      avgDur: s.durs.length
        ? Math.round(s.durs.reduce((x, y) => x + y, 0) / s.durs.length)
        : null,
      models: Array.from((edgeMap.get(toolKey) ?? new Map()).entries())
        .map(([mn, c]) => ({ name: mn, count: c }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  const models = Array.from(modelMap.entries())
    .map(([name, m]) => m)
    .sort((a, b) => b.count - a.count);

  return { agents, tools, models, totalTraces: perTrace.size };
}
