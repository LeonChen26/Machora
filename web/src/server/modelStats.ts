// Model 维度聚合（/models 目录页 + /models/[name] 详情页唯一数据源）。
//
// 与 agentStats 的口径关系（哪些一致、哪些刻意不同，汇总见仓库 OBSERVABILITY.md）：
//   一致：归属优先级、任务 = Trace 数、成功/失败判定、时间窗切分、信号阈值
//   刻意不同（对象本质不同，UI 已用 title 标注粒度）：
//     · agent 的「调用 / 成本 / Token」覆盖其名下全部 observation（含工具等步骤），
//       model 的「调用 / 成本 / Token」只覆盖该模型自身的 generation 调用；
//     · 错误率分母：agent 用 steps（全部 observation），model 用 calls（本模型调用）。
//   本文件内：
//   - 模型归属 = observation.model（仅 LLM / EMBEDDING 观测携带模型）
//   - 调用（calls）= 该模型名下 LLM / EMBEDDING observation 数
//   - trace 数（traces）= 含该模型「模型调用」的去重 Trace 数
//   - 成功/失败：trace.status === "ERROR" 或该 trace 含 level=ERROR 的 observation
//     （trace 级错误按「该 trace 的全部 observation」统计，而非只算该模型的调用，
//     保证同一条 trace 在 Agents 页与 Models 页的成败判定一致）
//   - 错误率 = ERROR 调用 / 全部调用（调用级口径）
//   - 成本 / Token = 该模型自身的 generation 调用累加
//   - 延迟 = 调用 endTime − startTime（avg / P95）
//
// 时间窗：以 since 为界拆「当前窗口 / 前一等长窗口」，供环比与异常标记使用。
// trace 级指标按 trace.timestamp 归属窗口，调用级指标按 observation.startTime 归属。

import { and, asc, eq, gte, inArray, type SQL } from "drizzle-orm";
import {
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
import { afterCursor, scanBatches, yieldToEventLoop } from "./scan";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Models 页时间窗选项（天） */
export const MODEL_DAY_OPTIONS = [7, 14, 30] as const;

/** 归属维度无法确定时的归类名（与 Agents 页共用同一常量，保证两页 unknown 桶一致） */
export const MODEL_UNKNOWN = AGENT_UNKNOWN;

/** 详情页调用明细分页大小 */
export const MODEL_CALL_PAGE_SIZE = 25;

/** 全局合计用的合成桶键（不出现在目录列表中） */
const ALL_KEY = "__all__";

// ---------------------------------------------------------------------------
// 指标结构
// ---------------------------------------------------------------------------

/** 单一窗口内的模型指标 */
export interface ModelMetrics {
  /** 模型调用数（LLM / EMBEDDING） */
  calls: number;
  /** Trace 数（含该模型调用的去重 Trace 数） */
  traces: number;
  /** Trace 成功率（无 trace 为 null） */
  successRate: number | null;
  errors: number;
  warnings: number;
  /** 调用级错误率 = ERROR 调用 / 全部调用 */
  errorRate: number;
  tokens: number;
  cost: number;
  avg: number | null;
  p95: number | null;
}

export interface ModelRow extends ModelMetrics {
  name: string;
  /** 近 days 天每日调用量（sparkline） */
  daily: number[];
  /** 异常标记（成本↑ / 错误率↑ / P95↑） */
  flags: string[];
  /** 前一等长窗口指标（无数据为 null） */
  prev: ModelMetrics | null;
}

export interface ModelDirectory {
  models: ModelRow[];
  totals: ModelMetrics;
  prevTotals: ModelMetrics;
  /** 全局环比异常提示 */
  anomalies: string[];
  /** 未标注 model 的模型调用数（口径提示用） */
  unattributedCalls: number;
  since: Date;
  days: number;
}

export interface ModelAgentRow {
  name: string;
  calls: number;
  tokens: number;
  cost: number;
  errorRate: number;
}

export interface ModelDailyPoint {
  label: string;
  calls: number;
  traces: number;
  cost: number;
  errorRate: number;
}

export interface ModelCallRow {
  id: string;
  time: Date;
  latency: number | null;
  level: string;
  tokens: number | null;
  cost: number | null;
  traceId: string;
  traceName: string | null;
  agent: string | null;
}

export interface ModelSessionRow {
  sessionId: string;
  traces: number;
  last: Date;
  cost: number;
}

export interface ModelScoreRow {
  name: string;
  dataType: string;
  count: number;
  avg: number;
}

export interface ModelDetail {
  name: string;
  days: number;
  since: Date;
  metrics: ModelMetrics;
  prev: ModelMetrics | null;
  daily: ModelDailyPoint[];
  agents: ModelAgentRow[];
  calls: ModelCallRow[];
  callTotal: number;
  sessions: ModelSessionRow[];
  scores: ModelScoreRow[];
}

// ---------------------------------------------------------------------------
// 内部聚合结构
// ---------------------------------------------------------------------------

interface MTrace {
  id: string;
  name: string | null;
  ts: Date;
  status: string | null;
  agent: string | null;
  sessionId: string | null;
  /** 该 trace 全量 ERROR observation 数（任务成败判定） */
  errors: number;
  /** 该 trace 涉及的模型集合（模型调用） */
  models: Set<string>;
  /** 该 trace 内本模型的调用数 */
  calls: number;
  tokens: number;
  cost: number;
}

interface AgentAgg {
  calls: number;
  tokens: number;
  cost: number;
  errors: number;
}

interface ModelAcc {
  traces: Map<string, MTrace>;
  agents: Map<string, AgentAgg>;
  calls: number;
  errors: number;
  warnings: number;
  tokens: number;
  cost: number;
  latencies: number[];
  dailyCalls: number[];
  dailyCost: number[];
  dailyErrors: number[];
  dailyTraces: number[];
}

function emptyModelAcc(days: number): ModelAcc {
  return {
    traces: new Map(),
    agents: new Map(),
    calls: 0,
    errors: 0,
    warnings: 0,
    tokens: 0,
    cost: 0,
    latencies: [],
    dailyCalls: new Array<number>(days).fill(0),
    dailyCost: new Array<number>(days).fill(0),
    dailyErrors: new Array<number>(days).fill(0),
    dailyTraces: new Array<number>(days).fill(0),
  };
}

/** 参与聚合的 observation ⟕ trace 行（全部类型，供 trace 级错误口径使用） */
interface AggRow {
  traceId: string;
  traceName: string | null;
  traceAgent: string | null;
  traceStatus: string | null;
  traceTimestamp: Date;
  traceSession: string | null;
  obsAgent: string | null;
  obsType: string;
  obsId: string;
  obsModel: string | null;
  obsLevel: string;
  obsStart: Date;
  obsEnd: Date | null;
  obsTokens: number | null;
  obsCost: number | null;
}

function selectRows() {
  return db
    .select({
      traceId: observation.traceId,
      traceName: trace.name,
      traceAgent: trace.agentName,
      traceStatus: trace.status,
      traceTimestamp: trace.timestamp,
      traceSession: trace.sessionId,
      obsAgent: observation.agentName,
      obsType: observation.type,
      obsId: observation.id,
      obsModel: observation.model,
      obsLevel: observation.level,
      obsStart: observation.startTime,
      obsEnd: observation.endTime,
      obsTokens: observation.totalTokens,
      obsCost: observation.totalCost,
    })
    .from(observation)
    .leftJoin(trace, eq(observation.traceId, trace.id));
}

function windowBounds(days: number): { since: Date; prevSince: Date } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevSince = new Date(since.getTime() - days * DAY_MS);
  return { since, prevSince };
}

/**
 * 分批读取命中 conds 的 observation 行（批间让出事件循环）。
 *
 * 仍返回全量数组：本模块的聚合需要多遍完成（trace 元信息 → 注册 trace → 调用级累加 →
 * 每日 trace 数），无法融成单遍增量。分批只为避免同步驱动下一次大读取长时间独占事件循环。
 */
async function collectRows(conds: SQL<unknown>[]): Promise<AggRow[]> {
  const rows: AggRow[] = [];
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
    for (const r of batch) rows.push(r);
  }
  return rows;
}

function agentOf(r: AggRow): string {
  return resolveAgentName(r.traceAgent, r.obsAgent);
}

function registerTrace(t: MTrace, acc: ModelAcc) {
  acc.traces.set(t.id, {
    id: t.id,
    name: t.name,
    ts: t.ts,
    status: t.status,
    agent: t.agent,
    sessionId: t.sessionId,
    errors: t.errors,
    models: t.models,
    calls: 0,
    tokens: 0,
    cost: 0,
  });
}
function aggregate(
  rows: AggRow[],
  since: Date,
  days: number,
): { cur: Map<string, ModelAcc>; prev: Map<string, ModelAcc> } {
  const cur = new Map<string, ModelAcc>();
  const prev = new Map<string, ModelAcc>();
  const getAcc = (bucket: Map<string, ModelAcc>, key: string): ModelAcc => {
    let a = bucket.get(key);
    if (!a) {
      a = emptyModelAcc(days);
      bucket.set(key, a);
    }
    return a;
  };

  // 第一遍：trace 元信息（trace 级错误按全部 observation 统计，与 Agents 口径一致）
  const traceMeta = new Map<string, MTrace>();
  for (const r of rows) {
    let t = traceMeta.get(r.traceId);
    if (!t) {
      t = {
        id: r.traceId,
        name: r.traceName,
        ts: r.traceTimestamp,
        status: r.traceStatus,
        agent: agentOf(r),
        sessionId: r.traceSession,
        errors: 0,
        models: new Set<string>(),
        calls: 0,
        tokens: 0,
        cost: 0,
      };
      traceMeta.set(r.traceId, t);
    } else {
      if (!t.name && r.traceName) t.name = r.traceName;
      if (!t.status && r.traceStatus) t.status = r.traceStatus;
      if (!t.sessionId && r.traceSession) t.sessionId = r.traceSession;
    }
    if (r.obsLevel === "ERROR") t.errors++;
    if (r.obsModel && isGenerationType(r.obsType)) t.models.add(r.obsModel);
  }

  // 注册 trace 到其涉及的模型（含全局合计桶）
  for (const t of traceMeta.values()) {
    if (t.models.size === 0) continue;
    const bucket = t.ts.getTime() >= since.getTime() ? cur : prev;
    for (const model of t.models) registerTrace(t, getAcc(bucket, model));
    registerTrace(t, getAcc(bucket, ALL_KEY));
  }

  // 第二遍：调用级累加 + Agent 分布 + 每日趋势
  for (const r of rows) {
    if (!r.obsModel || !isGenerationType(r.obsType)) continue;
    const isCur = r.obsStart.getTime() >= since.getTime();
    const bucket = isCur ? cur : prev;
    const dur = r.obsEnd ? r.obsEnd.getTime() - r.obsStart.getTime() : null;
    const tokens = r.obsTokens ?? 0;
    const cost = r.obsCost ?? 0;
    for (const key of [r.obsModel, ALL_KEY]) {
      const acc = getAcc(bucket, key);
      acc.calls++;
      acc.tokens += tokens;
      acc.cost += cost;
      if (r.obsLevel === "ERROR") acc.errors++;
      if (r.obsLevel === "WARNING") acc.warnings++;
      if (dur != null) acc.latencies.push(dur);

      const t = acc.traces.get(r.traceId);
      if (t) {
        t.calls++;
        t.tokens += tokens;
        t.cost += cost;
      }

      const agent = agentOf(r);
      let aa = acc.agents.get(agent);
      if (!aa) {
        aa = { calls: 0, tokens: 0, cost: 0, errors: 0 };
        acc.agents.set(agent, aa);
      }
      aa.calls++;
      aa.tokens += tokens;
      aa.cost += cost;
      if (r.obsLevel === "ERROR") aa.errors++;

      if (isCur) {
        const dayIdx = Math.floor(
          (r.obsStart.getTime() - since.getTime()) / DAY_MS,
        );
        if (dayIdx >= 0 && dayIdx < days) {
          acc.dailyCalls[dayIdx]++;
          acc.dailyCost[dayIdx] += cost;
          if (r.obsLevel === "ERROR") acc.dailyErrors[dayIdx]++;
        }
      }
    }
  }

  // 每日 trace 数（按 trace.timestamp 归属）
  for (const t of traceMeta.values()) {
    if (t.models.size === 0) continue;
    if (t.ts.getTime() < since.getTime()) continue;
    const dayIdx = Math.floor((t.ts.getTime() - since.getTime()) / DAY_MS);
    if (dayIdx < 0 || dayIdx >= days) continue;
    for (const model of t.models) {
      const acc = cur.get(model);
      if (acc) acc.dailyTraces[dayIdx]++;
    }
    const allAcc = cur.get(ALL_KEY);
    if (allAcc) allAcc.dailyTraces[dayIdx]++;
  }

  return { cur, prev };
}

function isErroredTrace(t: MTrace): boolean {
  return t.status === "ERROR" || t.errors > 0;
}

function metricsOf(acc: ModelAcc | undefined): ModelMetrics {
  if (!acc) {
    return {
      calls: 0,
      traces: 0,
      successRate: null,
      errors: 0,
      warnings: 0,
      errorRate: 0,
      tokens: 0,
      cost: 0,
      avg: null,
      p95: null,
    };
  }
  let traces = 0;
  let errored = 0;
  for (const t of acc.traces.values()) {
    traces++;
    if (isErroredTrace(t)) errored++;
  }
  const sorted = [...acc.latencies].sort((a, b) => a - b);
  const avg = sorted.length
    ? sorted.reduce((s, x) => s + x, 0) / sorted.length
    : null;
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    : null;
  return {
    calls: acc.calls,
    traces,
    successRate: traces ? 1 - errored / traces : null,
    errors: acc.errors,
    warnings: acc.warnings,
    errorRate: acc.calls ? acc.errors / acc.calls : 0,
    tokens: acc.tokens,
    cost: acc.cost,
    avg,
    p95,
  };
}

/** ModelMetrics → 信号检测指标快照（steps = 调用数） */
function snapshot(m: ModelMetrics): MetricSnapshot {
  return { cost: m.cost, steps: m.calls, errorRate: m.errorRate, p95: m.p95 };
}

// ---------------------------------------------------------------------------
// 目录页
// ---------------------------------------------------------------------------

export async function getModelDirectory(days: number): Promise<ModelDirectory> {
  const { since, prevSince } = windowBounds(days);

  const rows = await collectRows([gte(observation.startTime, prevSince)]);

  const { cur, prev } = aggregate(rows, since, days);

  const models: ModelRow[] = [];
  for (const [name, acc] of cur) {
    if (name === ALL_KEY) continue;
    const metrics = metricsOf(acc);
    const prevMetrics = prev.has(name) ? metricsOf(prev.get(name)) : null;
    models.push({
      name,
      ...metrics,
      daily: acc.dailyCalls,
      flags: formatSignalShorts(
        detectMetricSignals({
          scope: "model",
          name,
          cur: snapshot(metrics),
          prev: prevMetrics ? snapshot(prevMetrics) : null,
          days,
        }),
      ),
      prev: prevMetrics,
    });
  }
  models.sort((a, b) => b.flags.length - a.flags.length || b.calls - a.calls);

  const totals = metricsOf(cur.get(ALL_KEY));
  const prevTotals = metricsOf(prev.get(ALL_KEY));
  const anomalies = formatSignalDetails(
    detectMetricSignals({
      scope: "global",
      name: null,
      cur: snapshot(totals),
      prev: snapshot(prevTotals),
      days,
    }),
  );

  const unattributedCalls = rows.filter(
    (r) =>
      isGenerationType(r.obsType) &&
      !r.obsModel &&
      r.obsStart.getTime() >= since.getTime(),
  ).length;

  return { models, totals, prevTotals, anomalies, unattributedCalls, since, days };
}

// ---------------------------------------------------------------------------
// 详情页
// ---------------------------------------------------------------------------

export async function getModelDetail(
  name: string,
  days: number,
  page: number,
): Promise<ModelDetail | null> {
  const { since, prevSince } = windowBounds(days);

  // 先定位「使用过该模型」的 trace，再取这些 trace 的全部 observation，
  // 以保证 trace 级错误判定覆盖所有步骤（与 Agents 页同口径）。
  const traceIds = (
    await db
      .selectDistinct({ id: observation.traceId })
      .from(observation)
      .where(
        and(
          eq(observation.model, name),
          inArray(observation.type, ["LLM", "EMBEDDING"]),
          gte(observation.startTime, prevSince),
        ),
      )
  ).map((r) => r.id);

  if (traceIds.length === 0) return null;

  const rows: AggRow[] = [];
  // traceIds 规模不受控，按块 IN 查询后合并，规避 SQLite 绑定参数上限；
  // 块间让出事件循环，避免连续大 IN 查询长时间独占
  for (const part of chunk(traceIds)) {
    const partRows = (await selectRows().where(
      and(
        inArray(observation.traceId, part),
        gte(observation.startTime, prevSince),
      ),
    )) as AggRow[];
    // 用循环而非 push(...partRows)：单块结果仍可能很大，展开会压栈溢出
    for (const r of partRows) rows.push(r);
    await yieldToEventLoop();
  }

  const { cur, prev } = aggregate(rows, since, days);
  const acc = cur.get(name);
  const prevAcc = prev.get(name);

  const metrics = metricsOf(acc);
  const prevMetrics = prevAcc ? metricsOf(prevAcc) : null;

  const daily: ModelDailyPoint[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(since.getTime() + i * DAY_MS);
    const calls = acc?.dailyCalls[i] ?? 0;
    return {
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      calls,
      traces: acc?.dailyTraces[i] ?? 0,
      cost: acc?.dailyCost[i] ?? 0,
      errorRate: calls ? (acc!.dailyErrors[i] ?? 0) / calls : 0,
    };
  });

  const agents: ModelAgentRow[] = acc
    ? Array.from(acc.agents.entries())
        .map(([agentName, a]) => ({
          name: agentName,
          calls: a.calls,
          tokens: a.tokens,
          cost: a.cost,
          errorRate: a.calls ? a.errors / a.calls : 0,
        }))
        .sort((a, b) => b.calls - a.calls)
    : [];

  // 调用明细（当前窗口内该模型的全部模型调用，按时间倒序分页）
  const callList = rows
    .filter(
      (r) =>
        r.obsModel === name &&
        isGenerationType(r.obsType) &&
        r.obsStart.getTime() >= since.getTime(),
    )
    .sort((a, b) => b.obsStart.getTime() - a.obsStart.getTime());
  const callTotal = callList.length;
  const callPageCount = Math.max(1, Math.ceil(callTotal / MODEL_CALL_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), callPageCount);
  const calls: ModelCallRow[] = callList
    .slice((safePage - 1) * MODEL_CALL_PAGE_SIZE, safePage * MODEL_CALL_PAGE_SIZE)
    .map((r) => ({
      id: r.obsId,
      time: r.obsStart,
      latency: r.obsEnd ? r.obsEnd.getTime() - r.obsStart.getTime() : null,
      level: r.obsLevel,
      tokens: r.obsTokens,
      cost: r.obsCost,
      traceId: r.traceId,
      traceName: r.traceName,
      agent: r.traceAgent ?? r.obsAgent,
    }));

  // 关联会话（当前窗口内该模型涉及的全部 trace，不限分页）
  const sessionMap = new Map<string, ModelSessionRow>();
  for (const t of acc?.traces.values() ?? []) {
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

  // 评分汇总（挂在该模型当前窗口 trace 上）
  const modelTraceIds = Array.from(acc?.traces.keys() ?? []);
  const scoreRows: { name: string; value: number; dataType: string }[] = [];
  for (const part of chunk(modelTraceIds)) {
    const partRows = await db
      .select({
        name: score.name,
        value: score.value,
        dataType: score.dataType,
      })
      .from(score)
      .where(
        and(inArray(score.traceId, part), gte(score.timestamp, since)),
      );
    // 用循环而非 push(...partRows)：单块结果仍可能很大，展开会压栈溢出
    for (const r of partRows) scoreRows.push(r);
  }
  const scoreMap = new Map<
    string,
    { dataType: string; count: number; sum: number }
  >();
  for (const s of scoreRows) {
    let e = scoreMap.get(s.name);
    if (!e) {
      e = { dataType: s.dataType, count: 0, sum: 0 };
      scoreMap.set(s.name, e);
    }
    e.count++;
    e.sum += s.value;
  }
  const scores: ModelScoreRow[] = Array.from(scoreMap.entries())
    .map(([scoreName, e]) => ({
      name: scoreName,
      dataType: e.dataType,
      count: e.count,
      avg: e.count ? e.sum / e.count : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    name,
    days,
    since,
    metrics,
    prev: prevMetrics,
    daily,
    agents,
    calls,
    callTotal,
    sessions,
    scores,
  };
}
