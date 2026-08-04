// OTLP metrics 解析：ExportMetricsServiceRequest → MetricSample 落库输入
// 与 processor.ts（trace）同级：JSON / protobuf 双通道解码后走同一解析管线

import type {
  OtlpExportMetricsServiceRequest,
  OtlpMetric,
  OtlpMetricDataPoint,
} from "./types.ts";
import { decodeAttributes } from "./types.ts";

export type MetricSampleKind = "GAUGE" | "SUM" | "HISTOGRAM";

export interface MetricSampleInput {
  projectId: string;
  name: string;
  unit: string | null;
  kind: MetricSampleKind;
  attributes: Record<string, unknown>;
  timestamp: Date;
  value: number | null;
  count: number | null;
  sum: number | null;
  min: number | null;
  max: number | null;
  buckets: { boundary: number; count: number }[] | null;
}

function asNumber(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function nanoToDate(v: string | number | undefined): Date | null {
  if (v === undefined || v === null) return null;
  const ms = Number(v) / 1e6;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** 累计直方图 bucket_counts → [{ boundary, count }]（boundary 为 explicitBounds 上界） */
function mapBuckets(
  bounds: number[] | undefined,
  counts: Array<string | number> | undefined,
): { boundary: number; count: number }[] | null {
  if (!bounds || !counts || bounds.length === 0) return null;
  const out: { boundary: number; count: number }[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const c = asNumber(counts[i]);
    if (c == null) continue;
    out.push({ boundary: bounds[i]!, count: c });
  }
  return out.length > 0 ? out : null;
}

function mapDataPoint(
  dp: OtlpMetricDataPoint,
  metric: OtlpMetric,
  kind: MetricSampleKind,
  projectId: string,
): MetricSampleInput {
  const attributes = decodeAttributes(dp.attributes);
  const timestamp = nanoToDate(dp.timeUnixNano) ?? new Date();

  if (kind === "HISTOGRAM") {
    return {
      projectId,
      name: metric.name ?? "unnamed",
      unit: metric.unit ?? null,
      kind,
      attributes,
      timestamp,
      value: null,
      count: asNumber(dp.count),
      sum: dp.sum ?? null,
      min: dp.min ?? null,
      max: dp.max ?? null,
      buckets: mapBuckets(dp.explicitBounds, dp.bucketCounts),
    };
  }

  // GAUGE / SUM：单值（asDouble 优先；asInt 为 OTLP JSON 字符串）
  const raw = dp.asDouble ?? dp.asInt;
  const value = asNumber(raw);
  return {
    projectId,
    name: metric.name ?? "unnamed",
    unit: metric.unit ?? null,
    kind,
    attributes,
    timestamp,
    value,
    count: null,
    sum: null,
    min: null,
    max: null,
    buckets: null,
  };
}

/**
 * 解析 OTLP metrics 请求 → MetricSample 落库输入数组
 * 支持 gauge / sum / histogram / summary；exponential_histogram 暂不映射
 */
export function parseOtelMetricsPayload(
  req: OtlpExportMetricsServiceRequest,
  projectId: string,
): MetricSampleInput[] {
  const out: MetricSampleInput[] = [];
  for (const rm of req.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        if (metric.gauge?.dataPoints?.length) {
          for (const dp of metric.gauge.dataPoints) {
            out.push(mapDataPoint(dp, metric, "GAUGE", projectId));
          }
        }
        if (metric.sum?.dataPoints?.length) {
          for (const dp of metric.sum.dataPoints) {
            out.push(mapDataPoint(dp, metric, "SUM", projectId));
          }
        }
        if (metric.histogram?.dataPoints?.length) {
          for (const dp of metric.histogram.dataPoints) {
            out.push(mapDataPoint(dp, metric, "HISTOGRAM", projectId));
          }
        }
        if (metric.summary?.dataPoints?.length) {
          // summary 落为 HISTOGRAM（count/sum/min/max 摘要字段）
          for (const dp of metric.summary.dataPoints) {
            out.push(mapDataPoint(dp, metric, "HISTOGRAM", projectId));
          }
        }
      }
    }
  }
  return out;
}
