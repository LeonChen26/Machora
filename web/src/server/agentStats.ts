// Agent 维度聚合（/agents 目录页 + /agents/[name] 详情页唯一数据源）。
//
// 口径（与 Overview「Agent 风险榜」统一，避免同一 Agent 在不同页面口径打架）：
//   - Agent 归属：trace.agentName ?? observation.agentName ?? "unknown"
//     （trace 级为权威字段，span 级兜底；两者皆空归 unknown）
//   - trace 数（traces）= 该 Agent 对应 Trace 数（一个 trace = 一次完整链路执行）
//   - 调用（calls）= 该 Agent 名下 LLM / EMBEDDING observation 数
//   - 成功/失败：trace.status === "ERROR" 或该 trace 含 level=ERROR 的 observation
//   - 错误率 = ERROR observation / 全部 observation（步骤级兜底，保证指标恒可用）
//   - 成本 / Token = 该 Agent 名下全部 observation 累加
//   - 版本 = 该 Agent 最近一条带 agentVersion 的 trace
//
// 时间窗：以 since 为界拆「当前窗口 / 前一等长窗口」，供环比与异常标记使用。

import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import {
  classifyTrajectoryKind,
  db,
  isGenerationType,
  observation,
  score,
  trace,
} from "@machora/shared";
import {
  detectMetricSignals,
  formatSignalDetails,
  formatSignalShorts,
  type MetricSnapshot,
} from "./signals";
import { AGENT_UNKNOWN, resolveAgentName } from "./attribution";
import { chunk } from "./chunk";
import { afterCursor, scanBatches } from "./scan";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Agent 页时间窗选项（天） */
export const AGENT_DAY_OPTIONS = [7, 14, 30] as const;

// 归属常量与规则收敛在 ./attribution（与 Overview / Topology / modelStats 共用同一优先级）
export { AGENT_UNKNOWN };

/** 详情页调用明细分页大小 */
export const AGENT_TRACE_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// 通用统计（按模型 / 任意维度），Overview 按模型汇总复用
// ---------------------------------------------------------------------------

export interface ModelStat {
  count: number;
  latencies: number[];
  errors: number;
  warnings: number;
  tokens: number;
  cost: number;
}

export function emptyStat(): ModelStat {
  return { count: 0, latencies: [], errors: 0, warnings: 0, tokens: 0, cost: 0 };
}

export function summarize(m: ModelStat) {
  const sorted = [...m.latencies].sort((a, b) => a - b);
  const avg = sorted.length
    ? sorted.reduce((s, x) => s + x, 0) / sorted.length
    : null;
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : null;
  return {
    count: m.count,
    avg,
    p95,
    errors: m.errors,
    warnings: m.warnings,
    errorRate: m.count ? m.errors / m.count : 0,
    tokens: m.tokens,
    cost: m.cost,
  };
}

// ---------------------------------------------------------------------------
// Agent 指标
// ---------------------------------------------------------------------------

/** 单一窗口内的 Agent 指标 */
export interface AgentMetrics {
  /** Trace 数（同一 trace 只计一次） */
  traces: number;
  /** Trace 成功率（无 trace 为 null） */
  successRate: number | null;
  /** 模型调用数（LLM / EMBEDDING） */
  calls: number;
  /** 步骤数（全部 observation，错误率分母） */
  steps: number;
  errors: number;
  warnings: number;
  errorRate: number;
  tokens: number;
  cost: number;
  avg: number | null;
  p95: number | null;
}

/** 目录页行：指标 + 身份（版本）+ 趋势 + 异常标记 + 前窗环比 */
export interface AgentRow extends AgentMetrics {
  name: string;
  version: string | null;
  /** 近 days 天每日调用量（sparkline） */
  daily: number[];
  /** 异常标记（成本↑ / 错误率↑ / P95↑） */
  flags: string[];
  /** 前一等长窗口指标（无数据为 null） */
  prev: AgentMetrics | null;
}

export interface AgentDirectory {
  agents: AgentRow[];
  totals: AgentMetrics;
  prevTotals: AgentMetrics;
  /** 全局环比异常提示 */
  anomalies: string[];
  since: Date;
  days: number;
}

export interface AgentVersionRow {
  version: string | null;
  traces: number;
  successRate: number | null;
  calls: number;
  cost: number;
  errorRate: number;
  last: Date;
}

export interface AgentToolRow {
  name: string;
  count: number;
  errors: number;
  avgDur: number | null;
}

export interface AgentModelRow {
  name: string;
  count: number;
  tokens: number;
  cost: number;
}

export interface AgentDailyPoint {
  label: string;
  traces: number;
  calls: number;
  cost: number;
  errorRate: number;
}

export interface AgentTraceRow {
  id: string;
  name: string | null;
  timestamp: Date;
  status: string | null;
  version: string | null;
  sessionId: string | null;
  calls: number;
  tokens: number;
  cost: number;
  errors: number;
  latency: number | null;
  errored: boolean;
}

export interface AgentSessionRow {
  sessionId: string;
  traces: number;
  last: Date;
  cost: number;
}

export interface AgentScoreRow {
  name: string;
  dataType: string;
  count: number;
  avg: number;
}

export interface AgentDetail {
  name: string;
  version: string | null;
  days: number;
  since: Date;
  metrics: AgentMetrics;
  prev: AgentMetrics | null;
  daily: AgentDailyPoint[];
  versions: AgentVersionRow[];
  tools: AgentToolRow[];
  models: AgentModelRow[];
  traces: AgentTraceRow[];
  traceTotal: number;
  sessions: AgentSessionRow[];
  scores: AgentScoreRow[];
}

// ---------------------------------------------------------------------------
// 内部聚合结构
// ---------------------------------------------------------------------------

interface TraceAgg {
  id: string;
  name: string | null;
  ts: Date;
  status: string | null;
  version: string | null;
  sessionId: string | null;
  calls: number;
  steps: number;
  errors: number;
  warnings: number;
  tokens: number;
  cost: number;
  minStart: number;
  maxEnd: number;
}

interface ToolAgg {
  count: number;
  errors: number;
  durs: number[];
}

interface ModelAgg {
  count: number;
  tokens: number;
  cost: number;
}

interface AgentAcc {
  traces: Map<string, TraceAgg>;
  tools: Map<string, ToolAgg>;
  models: Map<string, ModelAgg>;
  /** 全部 observation 耗时（当前窗口用于 avg/p95） */
  latencies: number[];
  dailyCalls: number[];
  dailyCost: number[];
  dailyErrors: number[];
  dailySteps: number[];
  dailyTraces: number[];
}

function emptyAgentAcc(days: number): AgentAcc {
  return {
    traces: new Map(),
    tools: new Map(),
    models: new Map(),
    latencies: [],
    dailyCalls: new Array<number>(days).fill(0),
    dailyCost: new Array<number>(days).fill(0),
    dailyErrors: new Array<number>(days).fill(0),
    dailySteps: new Array<number>(days).fill(0),
    dailyTraces: new Array<number>(days).fill(0),
  };
}

/** 参与聚合的 observation ⟕ trace 行 */
interface AggRow {
  obsId: string;
  traceId: string;
  traceName: string | null;
  traceAgent: string | null;
  traceVersion: string | null;
  traceStatus: string | null;
  traceTimestamp: Date;
  traceSession: string | null;
  obsAgent: string | null;
  obsType: string;
  obsName: string | null;
  obsModel: string | null;
  obsLevel: string;
  obsStart: Date;
  obsEnd: Date | null;
  obsTokens: number | null;
  obsCost: number | null;
  obsParent: string | null;
  obsMetadata: unknown;
}

function selectRows() {
  return db
    .select({
      obsId: observation.id,
      traceId: observation.traceId,
      traceName: trace.name,
      traceAgent: trace.agentName,
      traceVersion: trace.agentVersion,
      traceStatus: trace.status,
      traceTimestamp: trace.timestamp,
      traceSession: trace.sessionId,
      obsAgent: observation.agentName,
      obsType: observation.type,
      obsName: observation.name,
      obsModel: observation.model,
      obsLevel: observation.level,
      obsStart: observation.startTime,
      obsEnd: observation.endTime,
      obsTokens: observation.totalTokens,
      obsCost: observation.totalCost,
      obsParent: observation.parentObservationId,
      obsMetadata: observation.metadata,
    })
    .from(observation)
    .leftJoin(trace, eq(observation.traceId, trace.id));
}

/** Agent 归属条件：COALESCE(trace.agentName, observation.agentName) = name（unknown 取 IS NULL） */
function attributionCond(name: string) {
  const attributed = sql`COALESCE(${trace.agentName}, ${observation.agentName})`;
  return name === AGENT_UNKNOWN
    ? sql`${attributed} IS NULL`
    : sql`${attributed} = ${name}`;
}

/**
 * 增量聚合器：按批喂入 observation 行并就地累计。
 * 取代「一次性 select 全窗口 → aggregate(rows)」，使调用方能分批读取、批间让出事件循环。
 */
function createAggregator(since: Date, days: number) {
  const cur = new Map<string, AgentAcc>();
  const prev = new Map<string, AgentAcc>();

  const add = (r: AggRow): void => {
    const agent = resolveAgentName(r.traceAgent, r.obsAgent);
    const isCur = r.obsStart.getTime() >= since.getTime();
    const bucket = isCur ? cur : prev;
    let acc = bucket.get(agent);
    if (!acc) {
      acc = emptyAgentAcc(days);
      bucket.set(agent, acc);
    }

    const dayIdx = Math.floor(
      (r.obsStart.getTime() - since.getTime()) / DAY_MS,
    );
    const inDay = dayIdx >= 0 && dayIdx < days;

    let t = acc.traces.get(r.traceId);
    if (!t) {
      t = {
        id: r.traceId,
        name: r.traceName,
        ts: r.traceTimestamp,
        status: r.traceStatus,
        version: r.traceVersion,
        sessionId: r.traceSession,
        calls: 0,
        steps: 0,
        errors: 0,
        warnings: 0,
        tokens: 0,
        cost: 0,
        minStart: r.obsStart.getTime(),
        maxEnd: r.obsEnd ? r.obsEnd.getTime() : r.obsStart.getTime(),
      };
      acc.traces.set(r.traceId, t);
      // Trace 计数按 trace.timestamp 归日（与 modelStats / overview 一致）；
      // 其余 daily* 是 observation 级指标，仍按 obsStart 归日（见下方 inDay）
      if (isCur) {
        const tDayIdx = Math.floor(
          (r.traceTimestamp.getTime() - since.getTime()) / DAY_MS,
        );
        if (tDayIdx >= 0 && tDayIdx < days) acc.dailyTraces[tDayIdx]++;
      }
    } else {
      if (!t.name && r.traceName) t.name = r.traceName;
      if (!t.status && r.traceStatus) t.status = r.traceStatus;
      if (!t.version && r.traceVersion) t.version = r.traceVersion;
      if (!t.sessionId && r.traceSession) t.sessionId = r.traceSession;
    }

    const dur = r.obsEnd ? r.obsEnd.getTime() - r.obsStart.getTime() : null;
    t.steps++;
    if (isGenerationType(r.obsType)) t.calls++;
    if (r.obsLevel === "ERROR") t.errors++;
    if (r.obsLevel === "WARNING") t.warnings++;
    t.tokens += r.obsTokens ?? 0;
    t.cost += r.obsCost ?? 0;
    const start = r.obsStart.getTime();
    if (start < t.minStart) t.minStart = start;
    if (r.obsEnd) {
      const end = r.obsEnd.getTime();
      if (end > t.maxEnd) t.maxEnd = end;
    }

    if (isCur) {
      if (dur != null) acc.latencies.push(dur);
      if (inDay) {
        acc.dailySteps[dayIdx]++;
        acc.dailyCost[dayIdx] += r.obsCost ?? 0;
        if (isGenerationType(r.obsType)) acc.dailyCalls[dayIdx]++;
        if (r.obsLevel === "ERROR") acc.dailyErrors[dayIdx]++;
      }

      const kind = classifyTrajectoryKind({
        type: r.obsType,
        metadata: r.obsMetadata,
        model: r.obsModel,
        agentName: r.obsAgent,
        workflowName: null,
        skillName: null,
        hasParent: r.obsParent != null,
      });
      if (kind === "tool" && r.obsName) {
        let ta = acc.tools.get(r.obsName);
        if (!ta) {
          ta = { count: 0, errors: 0, durs: [] };
          acc.tools.set(r.obsName, ta);
        }
        ta.count++;
        if (r.obsLevel === "ERROR") ta.errors++;
        if (dur != null) ta.durs.push(dur);
      } else if ((kind === "llm" || kind === "embedding") && r.obsModel) {
        let ma = acc.models.get(r.obsModel);
        if (!ma) {
          ma = { count: 0, tokens: 0, cost: 0 };
          acc.models.set(r.obsModel, ma);
        }
        ma.count++;
        ma.tokens += r.obsTokens ?? 0;
        ma.cost += r.obsCost ?? 0;
      }
    }
  };

  return { add, result: () => ({ cur, prev }) };
}

/**
 * 按 (startTime, id) 分批扫描命中 conds 的 observation，逐批喂给增量聚合器。
 * 批间让出事件循环，避免同步驱动下一次全量读取长时间独占（standalone 单进程）。
 */
async function aggregateWindow(
  conds: SQL<unknown>[],
  since: Date,
  days: number,
): Promise<{ cur: Map<string, AgentAcc>; prev: Map<string, AgentAcc> }> {
  const agg = createAggregator(since, days);
  for await (const batch of scanBatches(
    async (after, limit) =>
      (await selectRows()
        .where(
          after
            ? and(...conds, afterCursor(observation.startTime, observation.id, after))
            : and(...conds),
        )
        .orderBy(asc(observation.startTime), asc(observation.id))
        .limit(limit)) as AggRow[],
    (r) => ({ ts: r.obsStart, id: r.obsId }),
  )) {
    for (const r of batch) agg.add(r);
  }
  return agg.result();
}

/**
 * 把同一 trace 在多个 Agent 桶中的分片合并回一条。
 *
 * trace.agentName 为空、而各 observation 携带不同 agentName 时，同一条 trace 会
 * 按行落入多个 Agent 桶（这正是「调用归属到观测 agent」的预期）。逐桶求和会让
 * totals 的 trace 数 / 成功率重复计数，故合计前先按 traceId 合并分片。
 */
function mergeTrace(target: TraceAgg, src: TraceAgg): void {
  target.calls += src.calls;
  target.steps += src.steps;
  target.errors += src.errors;
  target.warnings += src.warnings;
  target.tokens += src.tokens;
  target.cost += src.cost;
  if (src.minStart < target.minStart) target.minStart = src.minStart;
  if (src.maxEnd > target.maxEnd) target.maxEnd = src.maxEnd;
  if (!target.name && src.name) target.name = src.name;
  if (!target.status && src.status) target.status = src.status;
  if (!target.version && src.version) target.version = src.version;
  if (!target.sessionId && src.sessionId) target.sessionId = src.sessionId;
}

function metricsOf(accs: Iterable<AgentAcc>): AgentMetrics {
  const list = Array.from(accs);

  // trace 数 / 成功率按 traceId 去重；steps/calls/cost 等按行累加（行在桶间是划分，不会重复）
  const merged = new Map<string, TraceAgg>();
  for (const acc of list) {
    for (const t of acc.traces.values()) {
      const existing = merged.get(t.id);
      if (existing) mergeTrace(existing, t);
      else merged.set(t.id, { ...t });
    }
  }

  let errored = 0;
  let calls = 0;
  let steps = 0;
  let errors = 0;
  let warnings = 0;
  let tokens = 0;
  let cost = 0;
  for (const t of merged.values()) {
    if (isErroredTrace(t)) errored++;
    calls += t.calls;
    steps += t.steps;
    errors += t.errors;
    warnings += t.warnings;
    tokens += t.tokens;
    cost += t.cost;
  }

  // 避免 push(...arr) 在大样本下展开压栈（RangeError: Maximum call stack size exceeded）
  const latencies: number[] = [];
  for (const acc of list) for (const d of acc.latencies) latencies.push(d);
  latencies.sort((a, b) => a - b);

  const avg = latencies.length
    ? latencies.reduce((s, x) => s + x, 0) / latencies.length
    : null;
  const p95 = latencies.length
    ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
    : null;

  return {
    traces: merged.size,
    successRate: merged.size ? 1 - errored / merged.size : null,
    calls,
    steps,
    errors,
    warnings,
    errorRate: steps ? errors / steps : 0,
    tokens,
    cost,
    avg,
    p95,
  };
}

function isErroredTrace(t: TraceAgg): boolean {
  return t.status === "ERROR" || t.errors > 0;
}

function latestVersion(acc: AgentAcc | undefined): string | null {
  if (!acc) return null;
  let version: string | null = null;
  let ts = 0;
  for (const t of acc.traces.values()) {
    if (t.version && t.ts.getTime() >= ts) {
      version = t.version;
      ts = t.ts.getTime();
    }
  }
  return version;
}

/** AgentMetrics → 信号检测指标快照 */
function snapshot(m: AgentMetrics): MetricSnapshot {
  return { cost: m.cost, steps: m.steps, errorRate: m.errorRate, p95: m.p95 };
}

function windowBounds(days: number): { since: Date; prevSince: Date } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);
  return { since, prevSince };
}

// ---------------------------------------------------------------------------
// 目录页
// ---------------------------------------------------------------------------

export async function getAgentDirectory(days: number): Promise<AgentDirectory> {
  const { since, prevSince } = windowBounds(days);

  const { cur, prev } = await aggregateWindow(
    [gte(observation.startTime, prevSince)],
    since,
    days,
  );

  const agents: AgentRow[] = [];
  for (const [name, acc] of cur) {
    const metrics = metricsOf([acc]);
    const prevMetrics = prev.has(name) ? metricsOf([prev.get(name)!]) : null;
    agents.push({
      name,
      version: latestVersion(acc),
      ...metrics,
      daily: acc.dailyCalls,
      flags: formatSignalShorts(
        detectMetricSignals({
          scope: "agent",
          name,
          cur: snapshot(metrics),
          prev: prevMetrics ? snapshot(prevMetrics) : null,
          days,
        }),
      ),
      prev: prevMetrics,
    });
  }
  // 排序：有异常标记者优先，其次按模型调用量
  agents.sort((a, b) => b.flags.length - a.flags.length || b.calls - a.calls);

  const totals = metricsOf(cur.values());
  const prevTotals = metricsOf(prev.values());
  const anomalies = formatSignalDetails(
    detectMetricSignals({
      scope: "global",
      name: null,
      cur: snapshot(totals),
      prev: snapshot(prevTotals),
      days,
    }),
  );

  return { agents, totals, prevTotals, anomalies, since, days };
}

// ---------------------------------------------------------------------------
// 详情页
// ---------------------------------------------------------------------------

export async function getAgentDetail(
  name: string,
  days: number,
  page: number,
): Promise<AgentDetail | null> {
  const { since, prevSince } = windowBounds(days);

  const { cur, prev } = await aggregateWindow(
    [gte(observation.startTime, prevSince), attributionCond(name)],
    since,
    days,
  );

  if (cur.size === 0 && prev.size === 0) return null;

  const acc = cur.get(name);
  const prevAcc = prev.get(name);

  const metrics = metricsOf(acc ? [acc] : []);
  const prevMetrics = prevAcc ? metricsOf([prevAcc]) : null;

  const traceList = acc ? Array.from(acc.traces.values()) : [];
  traceList.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const traceTotal = traceList.length;
  const pageCount = Math.max(1, Math.ceil(traceTotal / AGENT_TRACE_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);

  const traces: AgentTraceRow[] = traceList.map((t) => ({
    id: t.id,
    name: t.name,
    timestamp: t.ts,
    status: t.status,
    version: t.version,
    sessionId: t.sessionId,
    calls: t.calls,
    tokens: t.tokens,
    cost: t.cost,
    errors: t.errors,
    latency: t.maxEnd > t.minStart ? t.maxEnd - t.minStart : null,
    errored: isErroredTrace(t),
  }));

  // 版本演进：按 agentVersion 分组（当前窗口）
  const versionAcc = new Map<
    string,
    { version: string | null; traces: number; errored: number; calls: number; cost: number; last: Date }
  >();
  for (const t of traceList) {
    const key = t.version ?? "";
    let v = versionAcc.get(key);
    if (!v) {
      v = {
        version: t.version,
        traces: 0,
        errored: 0,
        calls: 0,
        cost: 0,
        last: t.ts,
      };
      versionAcc.set(key, v);
    }
    v.traces++;
    if (isErroredTrace(t)) v.errored++;
    v.calls += t.calls;
    v.cost += t.cost;
    if (t.ts > v.last) v.last = t.ts;
  }
  const versions: AgentVersionRow[] = Array.from(versionAcc.values())
    .map((v) => ({
      version: v.version,
      traces: v.traces,
      successRate: v.traces ? 1 - v.errored / v.traces : null,
      calls: v.calls,
      cost: v.cost,
      errorRate: v.traces ? v.errored / v.traces : 0,
      last: v.last,
    }))
    .sort((a, b) => b.last.getTime() - a.last.getTime());

  const tools: AgentToolRow[] = acc
    ? Array.from(acc.tools.entries())
        .map(([toolName, s]) => ({
          name: toolName,
          count: s.count,
          errors: s.errors,
          avgDur: s.durs.length
            ? Math.round(s.durs.reduce((x, y) => x + y, 0) / s.durs.length)
            : null,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  const models: AgentModelRow[] = acc
    ? Array.from(acc.models.entries())
        .map(([modelName, m]) => ({
          name: modelName,
          count: m.count,
          tokens: m.tokens,
          cost: m.cost,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  const daily: AgentDailyPoint[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(since.getTime() + i * DAY_MS);
    const steps = acc?.dailySteps[i] ?? 0;
    return {
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      traces: acc?.dailyTraces[i] ?? 0,
      calls: acc?.dailyCalls[i] ?? 0,
      cost: acc?.dailyCost[i] ?? 0,
      errorRate: steps ? (acc!.dailyErrors[i] ?? 0) / steps : 0,
    };
  });

  // 关联会话（当前窗口全部 trace，不限分页）
  const sessionMap = new Map<string, AgentSessionRow>();
  for (const t of traceList) {
    if (!t.sessionId) continue;
    let s = sessionMap.get(t.sessionId);
    if (!s) {
      s = { sessionId: t.sessionId, traces: 0, last: t.ts, cost: 0 };
      sessionMap.set(t.sessionId, s);
    }
    s.traces++;
    s.cost += t.cost;
    if (t.ts > s.last) s.last = t.ts;
  }
  const sessions = Array.from(sessionMap.values()).sort(
    (a, b) => b.last.getTime() - a.last.getTime(),
  );

  // 评分汇总（挂在该 Agent 当前窗口 trace 上）
  const traceIds = traceList.map((t) => t.id);
  // 分块查询：traceIds 规模不受控，一次性 IN 展开会触达 SQLite 绑定参数上限
  const scoreRows: { name: string; value: number; dataType: string }[] = [];
  for (const part of chunk(traceIds)) {
    const partRows = await db
      .select({
        name: score.name,
        value: score.value,
        dataType: score.dataType,
      })
      .from(score)
      .where(and(inArray(score.traceId, part), gte(score.timestamp, since)));
    // 用循环而非 push(...partRows)：单块结果仍可能很大，展开会压栈溢出
    for (const r of partRows) scoreRows.push(r);
  }
  const scoreMap = new Map<string, { dataType: string; count: number; sum: number }>();
  for (const s of scoreRows) {
    let e = scoreMap.get(s.name);
    if (!e) {
      e = { dataType: s.dataType, count: 0, sum: 0 };
      scoreMap.set(s.name, e);
    }
    e.count++;
    e.sum += s.value;
  }
  const scores: AgentScoreRow[] = Array.from(scoreMap.entries())
    .map(([scoreName, e]) => ({
      name: scoreName,
      dataType: e.dataType,
      count: e.count,
      avg: e.count ? e.sum / e.count : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const paged = traces.slice(
    (safePage - 1) * AGENT_TRACE_PAGE_SIZE,
    safePage * AGENT_TRACE_PAGE_SIZE,
  );

  return {
    name,
    version: latestVersion(acc ?? prevAcc),
    days,
    since,
    metrics,
    prev: prevMetrics,
    daily,
    versions,
    tools,
    models,
    traces: paged,
    traceTotal,
    sessions,
    scores,
  };
}
