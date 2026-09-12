// 统一信号检测器（观测层唯一异常口径）。
//
// 历史问题：成本突增 / 错误率上升 / 延迟恶化的阈值原先被复制在 4 处
// （Overview 全局、Overview 按 Agent、Analytics 按模型、Agent 目录与详情），
// 改一次阈值要改 4 遍，且容易出现「同一对象在不同页面标记不一致」。
// 本模块收敛为唯一实现，页面只负责渲染。
//
// 阈值口径（与原实现完全一致，本次不做行为变更）：
//   - 成本突增 ：前窗 ≥ $0.005 且 当前 ≥ 前窗 × 1.5 且 增量 ≥ $0.005
//   - 错误率上升：前后窗样本 ≥ 3 且 绝对上升 ≥ 10pp 且 当前 ≥ 10%
//   - 延迟恶化 ：前后窗样本 ≥ 3 且 P95 ≥ 前窗 × 1.5 且 增量 ≥ 500ms
//
// 轨迹类信号（重复调用 / 疑似无效循环 / 长任务）直接复用 trajectory.buildTrajectoryRows
// 的既有判定，不另起一套口径。

import { asc, desc, gte, inArray } from "drizzle-orm";
import { db, observation, trace } from "@machora/shared";
import { formatCost, formatDuration } from "../lib/format";
import { buildObsTree, buildTrajectoryRows, type Obs } from "./trajectory";
import { chunk } from "./chunk";

/** 集中定义的阈值，页面不得再自行复制 */
export const SIGNAL_THRESHOLDS = {
  costMinPrev: 0.005,
  costRatio: 1.5,
  costMinDelta: 0.005,
  minSamples: 3,
  errorRise: 0.1,
  errorMin: 0.1,
  latencyRatio: 1.5,
  latencyMinDelta: 500,
} as const;

export type SignalSeverity = "high" | "medium";

export type SignalKind = "error" | "cost" | "latency" | "loop" | "long_task";

export type SignalScope = "global" | "agent" | "model" | "trace";

export interface Signal {
  /** 稳定 id：同一信号在多次渲染间不变，便于去重与定位 */
  id: string;
  kind: SignalKind;
  severity: SignalSeverity;
  scope: SignalScope;
  /** 作用域名称（global / trace 聚合为 null） */
  scopeName: string | null;
  /** 一句话标题 */
  title: string;
  /** 短标签（表格徽标用） */
  short: string;
  /** 长描述（含对比值，面板与告警用） */
  detail: string;
  /** 点击去向（无合适目标为 null） */
  href: string | null;
}

/** 指标快照：成本 / 样本数 / 错误率 / P95 延迟 */
export interface MetricSnapshot {
  cost: number;
  /** 样本数：全局与 Agent 为步骤数，模型为模型调用数 */
  steps: number;
  errorRate: number;
  p95: number | null;
}

const SEVERITY_RANK: Record<SignalSeverity, number> = { high: 0, medium: 1 };
const KIND_RANK: Record<SignalKind, number> = {
  error: 0,
  cost: 1,
  latency: 2,
  loop: 3,
  long_task: 4,
};

function hrefFor(
  kind: SignalKind,
  scope: SignalScope,
  name: string | null,
  days: number,
): string | null {
  switch (scope) {
    case "agent":
      return name ? `/agents/${encodeURIComponent(name)}?days=${days}` : null;
    case "model":
      return name
        ? `/models/${encodeURIComponent(name)}?days=${days}`
        : null;
    case "trace":
      return "/traces";
    case "global":
      return kind === "cost" ? "/analytics" : "/traces";
  }
}

export interface MetricSignalInput {
  scope: SignalScope;
  /** 作用域名称（global 传 null） */
  name?: string | null;
  cur: MetricSnapshot;
  prev: MetricSnapshot | null;
  days: number;
}

/** 检测单个作用域的指标类信号（无前窗或无命中返回空数组） */
export function detectMetricSignals(input: MetricSignalInput): Signal[] {
  const { scope, cur, prev, days } = input;
  const name = input.name ?? null;
  if (!prev) return [];

  const t = SIGNAL_THRESHOLDS;
  const prefix = `${scope}:${name ?? "all"}`;
  const out: Signal[] = [];

  // 成本突增
  if (
    prev.cost >= t.costMinPrev &&
    cur.cost >= prev.cost * t.costRatio &&
    cur.cost - prev.cost >= t.costMinDelta
  ) {
    const pct = Math.round((cur.cost / prev.cost - 1) * 100);
    out.push({
      id: `${prefix}:cost`,
      kind: "cost",
      severity: "medium",
      scope,
      scopeName: name,
      title: "成本突增",
      short: `成本↑${pct}%`,
      detail: `成本 ${formatCost(prev.cost)} → ${formatCost(cur.cost)}（↑${pct}%）`,
      href: hrefFor("cost", scope, name, days),
    });
  }

  // 错误率上升
  if (
    prev.steps >= t.minSamples &&
    cur.steps >= t.minSamples &&
    cur.errorRate >= prev.errorRate + t.errorRise &&
    cur.errorRate >= t.errorMin
  ) {
    out.push({
      id: `${prefix}:error`,
      kind: "error",
      severity: "high",
      scope,
      scopeName: name,
      title: "错误率上升",
      short: "错误率↑",
      detail: `错误率 ${(prev.errorRate * 100).toFixed(0)}% → ${(cur.errorRate * 100).toFixed(0)}%`,
      href: hrefFor("error", scope, name, days),
    });
  }

  // 延迟恶化
  if (
    prev.steps >= t.minSamples &&
    cur.steps >= t.minSamples &&
    prev.p95 != null &&
    cur.p95 != null &&
    cur.p95 >= prev.p95 * t.latencyRatio &&
    cur.p95 - prev.p95 >= t.latencyMinDelta
  ) {
    out.push({
      id: `${prefix}:latency`,
      kind: "latency",
      severity: "medium",
      scope,
      scopeName: name,
      title: "延迟恶化",
      short: "P95↑",
      detail: `P95 ${formatDuration(prev.p95)} → ${formatDuration(cur.p95)}`,
      href: hrefFor("latency", scope, name, days),
    });
  }

  return out;
}

/** 长描述列表（面板与「异常检测」行使用） */
export function formatSignalDetails(signals: Signal[]): string[] {
  return signals.map((s) => s.detail);
}

/** 短标签列表（表格徽标使用） */
export function formatSignalShorts(signals: Signal[]): string[] {
  return signals.map((s) => s.short);
}

// ---------------------------------------------------------------------------
// 轨迹类信号（重复调用 / 疑似无效循环 / 长任务）
// ---------------------------------------------------------------------------

export interface TraceSignalSummary {
  /** 实际扫描的 trace 数 */
  scanned: number;
  /** 出现「仅重复」的 trace 数 */
  repeatTraces: number;
  /** 出现「疑似无效循环」的 trace 数 */
  ineffectiveTraces: number;
  /** 长任务（STEP 思考节点 ≥ 8）的 trace 数（信号名固定为「长任务」） */
  longTraces: number;
  /** 「重复调用」类 trace 内的最大连续次数 */
  maxRepeatStreak: number;
  /** 「疑似无效循环」类 trace 内的最大连续次数 */
  maxIneffectiveStreak: number;
}

const EMPTY_TRACE_SIGNALS: TraceSignalSummary = {
  scanned: 0,
  repeatTraces: 0,
  ineffectiveTraces: 0,
  longTraces: 0,
  maxRepeatStreak: 0,
  maxIneffectiveStreak: 0,
};

/** 单条 trace 的轨迹信号 */
export interface TraceSignalInfo {
  /** 「重复调用」最高连续次数（0 = 无） */
  repeatStreak: number;
  /** 「疑似无效循环」最高连续次数（0 = 无） */
  ineffectiveStreak: number;
  /** 长任务（STEP 思考节点 ≥ 8） */
  longTask: boolean;
}

/**
 * 由 observation 列表计算单条 trace 的轨迹信号。
 * 与 Trace 详情页共用 buildTrajectoryRows，保证徽标与统计口径一致。
 * 导出供 Trace 详情页复用同一口径（列表列 / 详情信号条 / Overview 汇总三者一致）。
 */
export function traceSignalOf(obs: readonly Obs[]): TraceSignalInfo {
  const { rows, longTask } = buildTrajectoryRows(buildObsTree(obs));
  let repeatStreak = 0;
  let ineffectiveStreak = 0;
  for (const r of rows) {
    if (!r.loop) continue;
    const streak = Number(r.badge?.match(/×(\d+)/)?.[1] ?? 0);
    if (r.loopLevel === "ineffective") {
      if (streak > ineffectiveStreak) ineffectiveStreak = streak;
    } else if (streak > repeatStreak) {
      repeatStreak = streak;
    }
  }
  return { repeatStreak, ineffectiveStreak, longTask };
}

/** 读取指定 trace 的 observation（按开始时间升序）并按 trace 分组 */
async function loadObservationsByTrace(
  traceIds: string[],
): Promise<Map<string, Obs[]>> {
  const byTrace = new Map<string, Obs[]>();
  if (traceIds.length === 0) return byTrace;

  const rows: Obs[] = [];
  // 只取轨迹判定所需列（不拉 input 等大 JSON）；traceIds 分批 IN，规避绑定参数上限
  for (const part of chunk(traceIds)) {
    const partRows: Obs[] = await db
      .select({
        id: observation.id,
        traceId: observation.traceId,
        parentObservationId: observation.parentObservationId,
        name: observation.name,
        type: observation.type,
        level: observation.level,
        model: observation.model,
        agentName: observation.agentName,
        workflowName: observation.workflowName,
        skillName: observation.skillName,
        startTime: observation.startTime,
        endTime: observation.endTime,
        output: observation.output,
        metadata: observation.metadata,
      })
      .from(observation)
      .where(inArray(observation.traceId, part))
      .orderBy(asc(observation.startTime));
    for (const r of partRows) rows.push(r);
  }

  for (const r of rows) {
    const list = byTrace.get(r.traceId);
    if (list) list.push(r);
    else byTrace.set(r.traceId, [r]);
  }
  return byTrace;
}

/** 指定 trace 的轨迹信号表（仅返回确有信号的条目，供列表页标记） */
export async function getTraceSignalMap(
  traceIds: string[],
): Promise<Map<string, TraceSignalInfo>> {
  const out = new Map<string, TraceSignalInfo>();
  const byTrace = await loadObservationsByTrace(traceIds);
  for (const [id, list] of byTrace) {
    const info = traceSignalOf(list);
    if (info.repeatStreak > 0 || info.ineffectiveStreak > 0 || info.longTask) {
      out.set(id, info);
    }
  }
  return out;
}

/** 轨迹信号扫描上限（保护 Overview 首页耗时；超出部分不参与统计） */
export const TRACE_SIGNAL_SCAN_LIMIT = 100;

/**
 * 扫描窗口内最近 N 个 trace 的轨迹信号。
 * 复用 buildTrajectoryRows，保证与 Trace 详情页的「重复调用 / 疑似无效循环 / 长任务」判定一致。
 */
export async function getTraceSignals(
  since: Date,
  limit = TRACE_SIGNAL_SCAN_LIMIT,
): Promise<TraceSignalSummary> {
  const recent = await db
    .select({ id: trace.id })
    .from(trace)
    .where(gte(trace.timestamp, since))
    .orderBy(desc(trace.timestamp))
    .limit(limit);
  if (recent.length === 0) return EMPTY_TRACE_SIGNALS;

  const byTrace = await loadObservationsByTrace(recent.map((t) => t.id));

  let repeatTraces = 0;
  let ineffectiveTraces = 0;
  let longTraces = 0;
  let maxRepeatStreak = 0;
  let maxIneffectiveStreak = 0;

  for (const list of byTrace.values()) {
    const info = traceSignalOf(list);
    if (info.longTask) longTraces++;
    if (info.ineffectiveStreak > 0) {
      ineffectiveTraces++;
      if (info.ineffectiveStreak > maxIneffectiveStreak) {
        maxIneffectiveStreak = info.ineffectiveStreak;
      }
    } else if (info.repeatStreak > 0) {
      repeatTraces++;
      if (info.repeatStreak > maxRepeatStreak) {
        maxRepeatStreak = info.repeatStreak;
      }
    }
  }

  return {
    scanned: byTrace.size,
    repeatTraces,
    ineffectiveTraces,
    longTraces,
    maxRepeatStreak,
    maxIneffectiveStreak,
  };
}

// ---------------------------------------------------------------------------
// 待关注清单（Overview）
// ---------------------------------------------------------------------------

export interface ScopeMetrics {
  name: string;
  cur: MetricSnapshot;
  prev: MetricSnapshot | null;
}

export interface WatchlistInput {
  days: number;
  global: { cur: MetricSnapshot; prev: MetricSnapshot | null };
  agents: ScopeMetrics[];
  models: ScopeMetrics[];
  traces?: TraceSignalSummary | null;
  /** 窗口内任务总数（扫描被截断时用于如实标注统计范围） */
  traceTotal?: number;
}

/** 汇总全局 + 各 Agent + 各模型 + 轨迹信号，按严重度排序 */
export function composeWatchlist(input: WatchlistInput): Signal[] {
  const { days } = input;
  const out: Signal[] = [];

  out.push(
    ...detectMetricSignals({
      scope: "global",
      name: null,
      cur: input.global.cur,
      prev: input.global.prev,
      days,
    }),
  );
  for (const a of input.agents) {
    out.push(
      ...detectMetricSignals({
        scope: "agent",
        name: a.name,
        cur: a.cur,
        prev: a.prev,
        days,
      }),
    );
  }
  for (const m of input.models) {
    out.push(
      ...detectMetricSignals({
        scope: "model",
        name: m.name,
        cur: m.cur,
        prev: m.prev,
        days,
      }),
    );
  }

  const tr = input.traces;
  if (tr) {
    // 扫描被截断时如实标注范围，避免把「最近 N 个 trace」的数字误读为全量
    const capped =
      input.traceTotal != null && tr.scanned > 0 && input.traceTotal > tr.scanned;
    const scopeNote = capped ? `（仅统计最近 ${tr.scanned} 个 trace）` : "";
    if (tr.ineffectiveTraces > 0) {
      out.push({
        id: "trace:ineffective",
        kind: "loop",
        severity: "high",
        scope: "trace",
        scopeName: null,
        title: "疑似无效循环",
        short: "无效循环",
        detail: `${tr.ineffectiveTraces} 个 trace 出现疑似无效循环（最高连续 ${tr.maxIneffectiveStreak} 次）${scopeNote}`,
        href: "/traces",
      });
    } else if (tr.repeatTraces > 0) {
      out.push({
        id: "trace:repeat",
        kind: "loop",
        severity: "medium",
        scope: "trace",
        scopeName: null,
        title: "重复工具调用",
        short: "重复调用",
        detail: `${tr.repeatTraces} 个 trace 出现重复工具调用（最高连续 ${tr.maxRepeatStreak} 次）${scopeNote}`,
        href: "/traces",
      });
    }
    if (tr.longTraces > 0) {
      out.push({
        id: "trace:long",
        kind: "long_task",
        severity: "medium",
        scope: "trace",
        scopeName: null,
        title: "长任务",
        short: "长任务",
        detail: `${tr.longTraces} 个 trace 的思考步骤 ≥ 8${scopeNote}`,
        href: "/traces",
      });
    }
  }

  out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.scopeName ?? "").localeCompare(b.scopeName ?? ""),
  );
  return out;
}
