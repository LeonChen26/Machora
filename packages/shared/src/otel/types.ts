// OTLP JSON（ExportTraceServiceRequest）类型与 AnyValue 解码
// 参考 https://opentelemetry.io/docs/specs/otlp/ JSON 编码规范（int64 以十进制字符串传输）

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  bytesValue?: string;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: Array<{ key: string; value?: OtlpAnyValue }> };
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpSpanEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpSpanStatus {
  code?: number; // 0=unset 1=ok 2=error
  message?: string;
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status?: OtlpSpanStatus;
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

// ---------------------------------------------------------------------------
// OTLP Metrics（ExportMetricsServiceRequest）
// ---------------------------------------------------------------------------

export interface OtlpMetricDataPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asDouble?: number;
  asInt?: string | number;
  // histogram
  count?: string | number;
  sum?: number;
  min?: number;
  max?: number;
  bucketCounts?: Array<string | number>;
  explicitBounds?: number[];
}

export interface OtlpMetric {
  name?: string;
  description?: string;
  unit?: string;
  gauge?: { dataPoints?: OtlpMetricDataPoint[] };
  sum?: {
    dataPoints?: OtlpMetricDataPoint[];
    aggregationTemporality?: number;
    isMonotonic?: boolean;
  };
  histogram?: {
    dataPoints?: OtlpMetricDataPoint[];
    aggregationTemporality?: number;
  };
  exponentialHistogram?: {
    dataPoints?: OtlpMetricDataPoint[];
    aggregationTemporality?: number;
  };
  summary?: { dataPoints?: OtlpMetricDataPoint[] };
}

export interface OtlpScopeMetrics {
  scope?: { name?: string; version?: string };
  metrics?: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeMetrics?: OtlpScopeMetrics[];
}

export interface OtlpExportMetricsServiceRequest {
  resourceMetrics?: OtlpResourceMetrics[];
}

/** 解码 OTLP AnyValue → JSON 值 */
export function decodeAnyValue(v: OtlpAnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : String(v.intValue);
  }
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue?.values) return v.arrayValue.values.map(decodeAnyValue);
  if (v.kvlistValue?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of v.kvlistValue.values) obj[kv.key] = decodeAnyValue(kv.value);
    return obj;
  }
  return null;
}

/** 解码 attributes 列表 → 扁平键值对 */
export function decodeAttributes(
  attrs: OtlpKeyValue[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) out[a.key] = decodeAnyValue(a.value);
  return out;
}
