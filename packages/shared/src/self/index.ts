// Machora 自观测模块（轻量自产自销）
//
// 进程内计数器记录服务自身运行指标（ingestion 吞吐/延迟、队列处理、
// 评估任务、外部 metrics 写入量等），定时落库为 MetricSample
// （归属专用 system 项目），由"系统指标"页展示。零新增依赖。
//
// 指标命名约定：machora.<模块>.<指标>，维度放 attributes。
// 落库形态：每个采集窗口（默认 60s）一条 SUM 采样，value=窗口内 sum，
// 均值由 UI 按 sum/count 计算。

import { lt } from "drizzle-orm";
import { db } from "../db.ts";
import { metricSample, project } from "../drizzle/schema.ts";

export const SYSTEM_PROJECT_ID = "machora-system";
export const SELF_METRICS_INTERVAL_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 指标保留 7 天

interface CounterState {
  count: number;
  sum: number;
}

export interface SelfMetricEntry {
  name: string;
  count: number;
  sum: number;
  attrs: Record<string, unknown>;
}

class SelfMetrics {
  private counters = new Map<string, CounterState>();
  private attrs = new Map<string, Record<string, unknown>>();

  private key(name: string, attrs: Record<string, unknown>): string {
    return Object.keys(attrs).length > 0
      ? `${name}|${JSON.stringify(attrs)}`
      : name;
  }

  /** 计数 + 累加（sum 用于均值/吞吐）；value 默认 1 */
  inc(name: string, value = 1, attrs: Record<string, unknown> = {}): void {
    const k = this.key(name, attrs);
    const c = this.counters.get(k);
    if (c) {
      c.count += 1;
      c.sum += value;
    } else {
      this.counters.set(k, { count: 1, sum: value });
      this.attrs.set(k, attrs);
    }
  }

  /** 观测采样值（等价 inc：count+1、sum+=value） */
  observe(name: string, value: number, attrs: Record<string, unknown> = {}): void {
    this.inc(name, value, attrs);
  }

  /** 取出全部计数并重置（drain） */
  drain(): SelfMetricEntry[] {
    const out: SelfMetricEntry[] = [];
    for (const [k, c] of this.counters) {
      out.push({
        name: k.split("|")[0]!,
        count: c.count,
        sum: c.sum,
        attrs: this.attrs.get(k) ?? {},
      });
    }
    this.counters.clear();
    this.attrs.clear();
    return out;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __machoraSelfMetrics: SelfMetrics | undefined;
}

// 与 queueBus 同理：Next.js 会把 @machora/shared 内联进 web 路由 bundle，若不用
// globalThis 兜底，路由内 inc 的计数与 start.ts 周期 flush 的是两个实例，永远落不了库。
export const selfMetrics: SelfMetrics =
  globalThis.__machoraSelfMetrics ?? new SelfMetrics();
globalThis.__machoraSelfMetrics = selfMetrics;

declare global {
  // eslint-disable-next-line no-var
  var __machoraStartedAt: number | undefined;
}

/** 记录进程启动时间（start.ts 调用；globalThis 兜底保证 web 侧可读） */
export function markSelfStarted(): void {
  if (globalThis.__machoraStartedAt === undefined) {
    globalThis.__machoraStartedAt = Date.now();
  }
}

/** 进程启动时间戳（System 健康面板展示运行时长） */
export function getSelfStartedAt(): number | null {
  return globalThis.__machoraStartedAt ?? null;
}

let timer: NodeJS.Timeout | null = null;

/** 启动周期落库（默认 60s），返回停止函数 */
export function startSelfMetrics(intervalMs = SELF_METRICS_INTERVAL_MS): () => void {
  if (timer) return () => stopSelfMetrics();
  timer = setInterval(() => {
    flushSelfMetrics().catch((e) =>
      console.error("[self] flush failed:", e),
    );
  }, intervalMs);
  timer.unref?.();
  return () => stopSelfMetrics();
}

export function stopSelfMetrics(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** system 专用项目（自观测指标归属，UI 按此过滤） */
export async function ensureSystemProject(): Promise<void> {
  await db
    .insert(project)
    .values({ id: SYSTEM_PROJECT_ID, name: "Machora System" })
    .onConflictDoNothing({ target: project.id });
}

/** 把窗口内计数落库为 MetricSample（SUM，value=sum）并清理过期数据 */
export async function flushSelfMetrics(): Promise<void> {
  const entries = selfMetrics.drain();
  if (entries.length > 0) {
    await ensureSystemProject();
    const now = new Date();
    const data = entries.map((e) => ({
      projectId: SYSTEM_PROJECT_ID,
      name: e.name,
      unit: null,
      kind: "SUM",
      attributes: e.attrs as unknown as typeof metricSample.$inferInsert["attributes"],
      timestamp: now,
      value: e.sum,
    }));
    await db.insert(metricSample).values(data);
  }
  await pruneOldMetrics();
}

export async function pruneOldMetrics(): Promise<void> {
  await db
    .delete(metricSample)
    .where(lt(metricSample.timestamp, new Date(Date.now() - RETENTION_MS)));
}
