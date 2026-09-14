// Overview 聚合：单一时间窗内的「全局健康 + Agent 风险榜 + 需要关注的 Trace」。
// 设计约定（与「观测对象 = 以 Trace 为根的 AI 任务」一致）：
//   - 不切维度：KPI 与趋势均为全局口径；维度视图交给 /agents、/sessions。
//   - Agent 归属：trace.agentName ?? observation.agentName ?? "unknown"
//     （统一走 ./attribution.resolveAgentName，与 /agents、/models、Topology 同口径）
//   - trace 是否出错：trace.status === "ERROR" 或该 trace 含 level=ERROR 的 observation
//     （status 为上游显式上报，步骤级 ERROR 兜底，保证指标始终可用）。

import { and, asc, eq, gte } from "drizzle-orm";
import { db, observation, trace } from "@machora/shared";
import { resolveAgentName } from "./attribution";
import { afterCursor, scanBatches, type ScanCursor } from "./scan";
import {
  composeWatchlist,
  detectMetricSignals,
  formatSignalShorts,
  getTraceSignals,
  type MetricSnapshot,
  type ScopeMetrics,
  type Signal,
} from "./signals";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 模型调用类 observation type */
const GENERATION_TYPES = new Set(["LLM", "EMBEDDING"]);

const UNKNOWN = "unknown";

export interface AgentRiskRow {
  name: string;
  version: string | null;
  traces: number;
  successRate: number | null;
  calls: number;
  cost: number;
  errorRate: number;
  p95: number | null;
  /** 每日调用量（长度 = days，用于行内 sparkline） */
  daily: number[];
  /** 异常标记：成本↑ / 错误率↑ / P95↑ */
  flags: string[];
  prevCalls: number | null;
  prevCost: number | null;
  prevErrorRate: number | null;
}

export interface TraceRef {
  id: string;
  name: string | null;
}

export interface OverviewTotals {
  traces: number;
  calls: number;
  cost: number;
  errorRate: number;
  p95: number | null;
}

/** 每日全局指标点（供 Overview 指标面板画 7 天迷你折线） */
export interface DailyPoint {
  label: string;
  /** 当日 Trace 数 */
  traces: number;
  /** 当日模型调用条数（LLM / Embedding） */
  calls: number;
  /** 当日总成本 */
  cost: number;
  /** 当日错误率（errors / steps） */
  errorRate: number;
  /** 当日 P95 延迟（无样本为 null） */
  p95: number | null;
}

export interface OverviewData {
  days: number;
  since: Date;
  totals: OverviewTotals;
  prevTotals: OverviewTotals;
  /** 待关注清单：全局 + 各 Agent + 各模型 + 轨迹信号，按严重度排序 */
  watchlist: Signal[];
  daily: DailyPoint[];
  agents: AgentRiskRow[];
  topCost: { t: TraceRef; cost: number }[];
  topLatency: { t: TraceRef; latency: number | null }[];
  errorTraces: { t: TraceRef; errors: number }[];
}

interface ObsAcc {
  calls: number;
  steps: number;
  errors: number;
  cost: number;
  tokens: number;
  latencies: number[];
  daily: number[];
}

interface ModelAcc {
  calls: number;
  errors: number;
  cost: number;
  latencies: number[];
}

function emptyModelAcc(): ModelAcc {
  return { calls: 0, errors: 0, cost: 0, latencies: [] };
}

/** 聚合结果 → 信号检测所需的指标快照 */
function toSnapshot(a: {
  cost: number;
  steps: number;
  errorRate: number;
  p95: number | null;
}): MetricSnapshot {
  return { cost: a.cost, steps: a.steps, errorRate: a.errorRate, p95: a.p95 };
}

interface TraceAgg {
  id: string;
  name: string | null;
  status: string | null;
  version: string | null;
  ts: Date;
  cost: number;
  starts: number[];
  ends: number[];
  errors: number;
}

interface DayBucket {
  calls: number;
  steps: number;
  errors: number;
  cost: number;
  latencies: number[];
  traces: number;
}

/**
 * 某 Agent 在某 Trace 中的归属。
 * ta 为全 trace 共享的聚合（成本/时长/名称/版本等）；
 * errored 只累计「归属该 agent 的」ERROR 行——trace 内别的 agent 出错不应拉低本 agent 成功率，
 * 与 /agents（agentStats 按 agent 桶累计 errors）口径一致。
 */
interface AgentTraceRef {
  ta: TraceAgg;
  errored: boolean;
}

function emptyAcc(days: number): ObsAcc {
  return {
    calls: 0,
    steps: 0,
    errors: 0,
    cost: 0,
    tokens: 0,
    latencies: [],
    daily: new Array<number>(days).fill(0),
  };
}

function p95of(latencies: number[]): number | null {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

function latencyOf(t: TraceAgg): number | null {
  if (t.starts.length === 0) return null;
  return Math.max(...t.ends) - Math.min(...t.starts);
}

export async function getOverview(days: number): Promise<OverviewData> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);

  const agentCur = new Map<string, ObsAcc>();
  const agentPrev = new Map<string, ObsAcc>();
  // 模型维度（仅 LLM / Embedding，供待关注清单的模型信号使用）
  const modelCur = new Map<string, ModelAcc>();
  const modelPrev = new Map<string, ModelAcc>();
  const traceCur = new Map<string, TraceAgg>();
  const tracePrev = new Map<string, TraceAgg>();
  // 每 Agent 参与的 Trace（按行归属，与 /agents、/models 同口径）：
  // trace.agentName 为空时，同一 trace 会归属其出现过的每个 observation agent。
  // 不能用「首行快照」——那会依赖未定义的行序，与 /agents 的 traces 数对不上。
  const agentTraces = new Map<string, Map<string, AgentTraceRef>>();
  // 全局每日桶（指标面板折线数据源，与 Agent 维度桶相互独立）
  const dayBuckets: DayBucket[] = Array.from({ length: days }, () => ({
    calls: 0,
    steps: 0,
    errors: 0,
    cost: 0,
    latencies: [],
    traces: 0,
  }));

  // 窗口内 observation 按 (startTime, id) 分批扫描，每批之间让出事件循环：
  // better-sqlite3 是同步驱动，一次性全量 select + 就地聚合会在整段期间独占事件循环
  // （standalone 单进程同时承载 HTTP 与写入），分批后其它请求可穿插执行。
  const fetchBatch = (after: ScanCursor | null, limit: number) => {
    const cur = afterCursor(observation.startTime, observation.id, after);
    return db
      .select({
        obsId: observation.id,
        traceId: observation.traceId,
        type: observation.type,
        agentName: observation.agentName,
        level: observation.level,
        startTime: observation.startTime,
        endTime: observation.endTime,
        totalTokens: observation.totalTokens,
        totalCost: observation.totalCost,
        model: observation.model,
        traceName: trace.name,
        traceAgent: trace.agentName,
        traceStatus: trace.status,
        traceVersion: trace.agentVersion,
        traceTimestamp: trace.timestamp,
      })
      .from(observation)
      .leftJoin(trace, eq(observation.traceId, trace.id))
      .where(
        cur
          ? and(gte(observation.startTime, prevSince), cur)
          : gte(observation.startTime, prevSince),
      )
      .orderBy(asc(observation.startTime), asc(observation.id))
      .limit(limit);
  };

  for await (const batch of scanBatches(fetchBatch, (r) => ({
    ts: r.startTime,
    id: r.obsId,
  }))) {
    for (const r of batch) {
      const isCur = r.startTime >= since;
      const agent = resolveAgentName(r.traceAgent, r.agentName);
      const isGen = GENERATION_TYPES.has(r.type);
      const dur = r.endTime ? r.endTime.getTime() - r.startTime.getTime() : null;

      // 全局当日桶（按 observation.startTime 归日）
      if (isCur) {
        const gIdx = Math.floor((r.startTime.getTime() - since.getTime()) / DAY_MS);
        if (gIdx >= 0 && gIdx < days) {
          const b = dayBuckets[gIdx]!;
          b.steps++;
          if (isGen) b.calls++;
          if (r.level === "ERROR") b.errors++;
          b.cost += r.totalCost ?? 0;
          if (dur !== null) b.latencies.push(dur);
        }
      }

      const accMap = isCur ? agentCur : agentPrev;
      const acc = accMap.get(agent) ?? emptyAcc(days);
      acc.steps++;
      if (isGen) {
        acc.calls++;
        if (isCur) {
          const idx = Math.floor((r.startTime.getTime() - since.getTime()) / DAY_MS);
          if (idx >= 0 && idx < days) acc.daily[idx]++;
        }
      }
      if (r.level === "ERROR") acc.errors++;
      acc.cost += r.totalCost ?? 0;
      acc.tokens += r.totalTokens ?? 0;
      if (dur !== null) acc.latencies.push(dur);
      accMap.set(agent, acc);

      // 模型维度累计（仅 LLM / Embedding）
      if (isGen) {
        const mMap = isCur ? modelCur : modelPrev;
        const modelName = r.model ?? UNKNOWN;
        const m = mMap.get(modelName) ?? emptyModelAcc();
        m.calls++;
        if (r.level === "ERROR") m.errors++;
        m.cost += r.totalCost ?? 0;
        if (dur !== null) m.latencies.push(dur);
        mMap.set(modelName, m);
      }

      const tMap = isCur ? traceCur : tracePrev;
      let ta = tMap.get(r.traceId);
      if (!ta) {
        ta = {
          id: r.traceId,
          name: r.traceName ?? null,
          status: r.traceStatus ?? null,
          version: r.traceVersion ?? null,
          ts: r.traceTimestamp ?? r.startTime,
          cost: 0,
          starts: [],
          ends: [],
          errors: 0,
        };
        tMap.set(r.traceId, ta);
      }
      ta.cost += r.totalCost ?? 0;
      ta.starts.push(r.startTime.getTime());
      ta.ends.push(r.endTime ? r.endTime.getTime() : r.startTime.getTime());
      if (r.level === "ERROR") ta.errors++;
      if (!ta.name && r.traceName) ta.name = r.traceName;
      if (!ta.status && r.traceStatus) ta.status = r.traceStatus;
      if (!ta.version && r.traceVersion) ta.version = r.traceVersion;

      // 该 Agent 参与此 trace（按当前窗口统计；同一 trace 可在多个 agent 下各计一次）
      if (isCur) {
        let perAgent = agentTraces.get(agent);
        if (!perAgent) {
          perAgent = new Map();
          agentTraces.set(agent, perAgent);
        }
        let ref = perAgent.get(r.traceId);
        if (!ref) {
          ref = { ta, errored: false };
          perAgent.set(r.traceId, ref);
        }
        // 只标记归属该 agent 的 ERROR 行（trace 级 status 另有判断）
        if (r.level === "ERROR") ref.errored = true;
      }
    }
  }

  const agg = (m: Map<string, ObsAcc>) => {
    let calls = 0;
    let steps = 0;
    let errors = 0;
    let cost = 0;
    const latencies: number[] = [];
    for (const a of m.values()) {
      calls += a.calls;
      steps += a.steps;
      errors += a.errors;
      cost += a.cost;
      // 避免 push(...arr) 在大样本下展开压栈
      for (const d of a.latencies) latencies.push(d);
    }
    return { calls, steps, errors, cost, errorRate: steps ? errors / steps : 0, p95: p95of(latencies) };
  };

  const cur = agg(agentCur);
  const prev = agg(agentPrev);
  const totals: OverviewTotals = {
    traces: traceCur.size,
    calls: cur.calls,
    cost: cur.cost,
    errorRate: cur.errorRate,
    p95: cur.p95,
  };
  const prevTotals: OverviewTotals = {
    traces: tracePrev.size,
    calls: prev.calls,
    cost: prev.cost,
    errorRate: prev.errorRate,
    p95: prev.p95,
  };

  // 全局异常改由 signals.ts 统一判定（见函数末尾的待关注清单）

  // 每日 Trace 数（按 trace.timestamp 归日）写入全局桶
  for (const t of traceCur.values()) {
    const idx = Math.floor((t.ts.getTime() - since.getTime()) / DAY_MS);
    if (idx >= 0 && idx < days) dayBuckets[idx]!.traces++;
  }

  // 每日全局指标点（5 个指标面板的 7 天迷你折线数据源）
  const daily: DailyPoint[] = dayBuckets.map((b, i) => {
    const dayStart = new Date(since.getTime() + i * DAY_MS);
    return {
      label: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`,
      traces: b.traces,
      calls: b.calls,
      cost: b.cost,
      errorRate: b.steps ? b.errors / b.steps : 0,
      p95: p95of(b.latencies),
    };
  });

  // Agent 风险榜
  const agentNames = new Set<string>([...agentCur.keys(), ...agentTraces.keys()]);
  const agents: AgentRiskRow[] = [];
  for (const name of agentNames) {
    const c = agentCur.get(name);
    const p = agentPrev.get(name);
    const refs = Array.from(agentTraces.get(name)?.values() ?? []);
    // 与 agentStats 一致：trace 级 status=ERROR 或该 agent 自身有 ERROR 行才算失败
    const errored = refs.filter(
      (x) => x.errored || x.ta.status === "ERROR",
    ).length;
    const calls = c?.calls ?? 0;
    const cost = c?.cost ?? 0;
    const errorRate = c && c.steps ? c.errors / c.steps : 0;
    const lat = c?.latencies ?? [];
    const p95 = p95of(lat);
    const prevP95 = p ? p95of(p.latencies) : null;

    // 行内标记统一走 signals.ts（阈值唯一来源）
    const flags = formatSignalShorts(
      detectMetricSignals({
        scope: "agent",
        name,
        cur: { cost, steps: c?.steps ?? 0, errorRate, p95 },
        prev: p
          ? {
              cost: p.cost,
              steps: p.steps,
              errorRate: p.steps ? p.errors / p.steps : 0,
              p95: prevP95,
            }
          : null,
        days,
      }),
    );

    // 版本：取该 Agent 最近一条带版本的 trace
    let version: string | null = null;
    let versionTs = 0;
    for (const { ta } of refs) {
      if (ta.version && ta.ts.getTime() > versionTs) {
        version = ta.version;
        versionTs = ta.ts.getTime();
      }
    }

    agents.push({
      name,
      version,
      traces: refs.length,
      successRate: refs.length ? 1 - errored / refs.length : null,
      calls,
      cost,
      errorRate,
      p95,
      daily: c?.daily ?? new Array<number>(days).fill(0),
      flags,
      prevCalls: p?.calls ?? null,
      prevCost: p?.cost ?? null,
      prevErrorRate: p && p.steps ? p.errors / p.steps : null,
    });
  }
  // 排序：有异常标记者优先，其次调用量
  agents.sort((a, b) => b.flags.length - a.flags.length || b.calls - a.calls);

  // 待关注清单：全局 + 各 Agent + 各模型 + 轨迹信号，统一由 signals.ts 判定
  const agentScopes: ScopeMetrics[] = agents.map((a) => {
    const c = agentCur.get(a.name);
    const p = agentPrev.get(a.name);
    return {
      name: a.name,
      cur: { cost: a.cost, steps: c?.steps ?? 0, errorRate: a.errorRate, p95: a.p95 },
      prev: p
        ? {
            cost: p.cost,
            steps: p.steps,
            errorRate: p.steps ? p.errors / p.steps : 0,
            p95: p95of(p.latencies),
          }
        : null,
    };
  });
  const modelScopes: ScopeMetrics[] = Array.from(modelCur.entries()).map(
    ([name, m]) => {
      const p = modelPrev.get(name);
      const curSnap: MetricSnapshot = {
        cost: m.cost,
        steps: m.calls,
        errorRate: m.calls ? m.errors / m.calls : 0,
        p95: p95of(m.latencies),
      };
      return {
        name,
        cur: curSnap,
        prev: p
          ? {
              cost: p.cost,
              steps: p.calls,
              errorRate: p.calls ? p.errors / p.calls : 0,
              p95: p95of(p.latencies),
            }
          : null,
      };
    },
  );
  const traceSignals = await getTraceSignals(since);
  const watchlist = composeWatchlist({
    days,
    global: { cur: toSnapshot(cur), prev: toSnapshot(prev) },
    agents: agentScopes,
    models: modelScopes,
    traces: traceSignals,
    traceTotal: traceCur.size,
  });

  // 需要关注
  const allTraces = Array.from(traceCur.values());
  const topCost = allTraces
    .filter((t) => t.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map((t) => ({ t: { id: t.id, name: t.name }, cost: t.cost }));
  const topLatency = allTraces
    .filter((t) => latencyOf(t) !== null)
    .sort((a, b) => (latencyOf(b) ?? 0) - (latencyOf(a) ?? 0))
    .slice(0, 5)
    .map((t) => ({ t: { id: t.id, name: t.name }, latency: latencyOf(t) }));
  const errorTraces = allTraces
    .filter((t) => t.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 5)
    .map((t) => ({ t: { id: t.id, name: t.name }, errors: t.errors }));

  return {
    days,
    since,
    totals,
    prevTotals,
    watchlist,
    daily,
    agents,
    topCost,
    topLatency,
    errorTraces,
  };
}
