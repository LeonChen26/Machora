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
import { freemem, loadavg, totalmem } from "node:os";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const SYSTEM_PROJECT_ID = "machora-system";
export const SELF_METRICS_INTERVAL_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 指标保留 7 天

interface CounterState {
  count: number;
  sum: number;
  kind: "SUM" | "GAUGE";
}

export interface SelfMetricEntry {
  name: string;
  count: number;
  sum: number;
  attrs: Record<string, unknown>;
  kind: "SUM" | "GAUGE";
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
      this.counters.set(k, { count: 1, sum: value, kind: "SUM" });
      this.attrs.set(k, attrs);
    }
  }

  /** 观测采样值（等价 inc：count+1、sum+=value） */
  observe(name: string, value: number, attrs: Record<string, unknown> = {}): void {
    this.inc(name, value, attrs);
  }

  /** GAUGE 采样：瞬间值，同窗口内重复采样直接覆盖为最新（count=1） */
  gauge(name: string, value: number, attrs: Record<string, unknown> = {}): void {
    const k = this.key(name, attrs);
    this.counters.set(k, { count: 1, sum: value, kind: "GAUGE" });
    this.attrs.set(k, attrs);
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
        kind: c.kind,
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

/** 启动周期落库（默认 60s），collect 为可选采集回调（如进程资源采样），返回停止函数 */
export function startSelfMetrics(
  intervalMs = SELF_METRICS_INTERVAL_MS,
  collect?: () => Promise<void> | void,
): () => void {
  if (timer) return () => stopSelfMetrics();
  timer = setInterval(() => {
    (async () => {
      if (collect) await collect();
      await flushSelfMetrics();
    })().catch((e) =>
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
      kind: e.kind,
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

// ---------------------------------------------------------------------------
// 进程/主机资源采集（GAUGE）：CPU%、内存、负载、事件循环延迟、数据目录大小
// ---------------------------------------------------------------------------

let lastCpuUsage: { user: number; system: number } | null = null;
let lastCpuWall = 0n;

/** 事件循环延迟：多次 setImmediate 轮询取平均（ms） */
export async function measureEventLoopDelay(samples = 5): Promise<number> {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint();
    await new Promise<void>((r) => setImmediate(r));
    sum += Number(process.hrtime.bigint() - t0) / 1e6;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** 递归统计目录总字节数（PGlite 数据目录 MB 级，60s 一次开销可忽略） */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          /* 忽略瞬时不可读 */
        }
      }
    }
  }
  await walk(dir);
  return total;
}

/**
 * 进程/主机资源采样并落 GAUGE：
 * - CPU 百分比（跨窗口差值 / 墙钟）
 * - 内存 RSS / 堆占用
 * - 系统负载（1min）与内存使用率
 * - 事件循环延迟
 * - 数据目录大小（传入 dataDir 才统计）
 */
export async function collectSystemMetrics(dataDir?: string): Promise<void> {
  const now = process.hrtime.bigint();
  const wallMs = Number(now - lastCpuWall) / 1e6;
  const cur = process.cpuUsage();
  if (lastCpuUsage && wallMs > 0) {
    const delta =
      (cur.user - lastCpuUsage.user + cur.system - lastCpuUsage.system) /
      1000; // µs → ms
    selfMetrics.gauge(
      "machora.process.cpu_percent",
      Math.round((Math.min(100, (delta / wallMs) * 100)) * 10) / 10,
    );
  }
  lastCpuUsage = cur;
  lastCpuWall = now;

  const mem = process.memoryUsage();
  selfMetrics.gauge("machora.process.memory_rss_bytes", mem.rss);
  selfMetrics.gauge("machora.process.memory_heap_bytes", mem.heapUsed);

  selfMetrics.gauge("machora.process.load1", loadavg()[0] ?? 0);

  const total = totalmem();
  const free = freemem();
  selfMetrics.gauge("machora.process.mem_free_bytes", free);
  selfMetrics.gauge(
    "machora.process.mem_used_percent",
    total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0,
  );

  selfMetrics.gauge("machora.process.event_loop_ms", await measureEventLoopDelay());

  if (dataDir) {
    selfMetrics.gauge("machora.process.data_dir_bytes", await dirSizeBytes(dataDir));
  }
}
