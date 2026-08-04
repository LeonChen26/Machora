// OTLP protobuf（Content-Type: application/x-protobuf）解码
//
// 把二进制 ExportTraceServiceRequest 解码为与 OTLP JSON 相同的结构
// （见 types.ts 的 OtlpExportTraceServiceRequest），复用下游 parseOtelPayload
// 处理管线，无需改 processor。
//
// 说明：OTLP 规范约定 JSON 编码里 trace_id/span_id 为 hex 字符串、
// int64/fixed64 为十进制字符串、bytes 为 base64。因此解码时统一转成
// 这些字符串形态，保证 JSON / protobuf 两条通道产出的数据一致。

import protobuf from "protobufjs";

// ---------------------------------------------------------------------------
// 修复：protobufjs 解码 OTLP 时，如果 string 字段（span.name、attribute.
// stringValue 等）包含非法 UTF-8 字节，会在 util/utf8.js 的 readStrict
// 里直接抛 TypeError: "The encoded data was not valid for encoding utf-8"，
// 整条 trace 被丢弃。
//
// protobufjs 8.x 的 decode 由 codegen 生成，并不会直接走 Reader.prototype.
// string，而是在 Type.eval 里调用 util.utf8.readStrict → utf8_read_decoder，
// 用的是 Node util.TextDecoder({ fatal: true })。所以要在更底层做容错：
//   1) 覆写 util.utf8.readStrict，严格解码失败时退化成 { fatal: false }，
//      非法字节替换成 U+FFFD replacement char；
//   2) 同时 patch Reader.prototype.string 兜底，兼容手动调用的场景。
// ---------------------------------------------------------------------------
(function patchProtobufjsUtf8Decoder() {
  const utf8Util = (protobuf.util as any)?.utf8;
  if (!utf8Util) return;

  let tolerantDecoder: TextDecoder | undefined;

  const fallbackRead = (bytes: Uint8Array, start: number, end: number): string => {
    if (!tolerantDecoder) {
      tolerantDecoder = new TextDecoder("utf-8", { fatal: false });
    }
    const safeStart = Math.max(0, Math.min(start, bytes.length));
    const safeEnd = Math.max(safeStart, Math.min(end, bytes.length));
    return tolerantDecoder.decode(bytes.subarray(safeStart, safeEnd));
  };

  // readStrict(bytes, start, end) → string  (throws on invalid utf-8)
  const originalReadStrict: ((b: Uint8Array, s: number, e: number) => string) | undefined =
    utf8Util.readStrict;
  if (typeof originalReadStrict === "function") {
    utf8Util.readStrict = function patchedReadStrict(
      bytes: Uint8Array,
      start: number,
      end: number,
    ): string {
      try {
        return originalReadStrict(bytes, start, end);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/utf-?8/i.test(msg) && !msg.includes("decode")) throw e;
        return fallbackRead(bytes, start, end);
      }
    };
  }

  // 有些老版本走 read(bytes, start, end) 而不是 readStrict，顺手覆写。
  const originalRead: ((b: Uint8Array, s: number, e: number) => string) | undefined =
    utf8Util.read;
  if (typeof originalRead === "function") {
    utf8Util.read = function patchedRead(
      bytes: Uint8Array,
      start: number,
      end: number,
    ): string {
      try {
        return originalRead(bytes, start, end);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/utf-?8/i.test(msg) && !msg.includes("decode")) throw e;
        return fallbackRead(bytes, start, end);
      }
    };
  }

  // Reader.prototype.string 兜底（codegen 路径一般不走，但是外部直接调时要安全）
  type ReaderLike = { buf: Uint8Array; pos: number; string(length: number): string };
  const proto = (protobuf.Reader.prototype as unknown) as ReaderLike;
  const originalString = proto.string;
  if (typeof originalString === "function") {
    proto.string = function patchedString(this: ReaderLike, length: number): string {
      if (length <= 0) return originalString.call(this, length);
      try {
        return originalString.call(this, length);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/utf-?8/i.test(msg) && !msg.includes("decode")) throw e;
        const start = this.pos;
        const safeLen = Math.max(0, Math.min(length, this.buf.length - start));
        this.pos = start + safeLen;
        return fallbackRead(this.buf, start, start + safeLen);
      }
    };
  }
})();

import type {
  OtlpAnyValue,
  OtlpExportMetricsServiceRequest,
  OtlpExportTraceServiceRequest,
  OtlpKeyValue,
  OtlpMetric,
  OtlpMetricDataPoint,
  OtlpResourceMetrics,
  OtlpResourceSpans,
  OtlpScopeMetrics,
  OtlpScopeSpans,
  OtlpSpan,
  OtlpSpanEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 内嵌 OTLP trace 相关 .proto（opentelemetry-proto 字段号与类型同官方规范）
// 仅含本平台需要的消息；未知字段会被 protobufjs 自动跳过，天然向前兼容
// ---------------------------------------------------------------------------

const COMMON_PROTO = `
syntax = "proto3";

package opentelemetry.proto.common.v1;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    bytes bytes_value = 5;
    ArrayValue array_value = 6;
    KeyValueList kvlist_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}
`;

const RESOURCE_PROTO = `
syntax = "proto3";

package opentelemetry.proto.resource.v1;

message Resource {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}
`;

const TRACE_PROTO = `
syntax = "proto3";

package opentelemetry.proto.trace.v1;

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  // 字段号与官方 opentelemetry-proto v1.3.0 trace.proto 完全一致：
  //   attributes=9, dropped_attributes_count=10, events=11,
  //   dropped_events_count=12, links=13, dropped_links_count=14,
  //   status=15, flags=16
  // 之前把 status 错写成 13、links 错写成 15 且加了 otel_ 前缀双字段，
  // 与官方 wire 格式不兼容——最新 OpenClaw SDK 的 status 在字段 15 会被
  // 误解析为 Link，导致解码错乱。这里回归官方编号。
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  fixed32 flags = 16;
}

enum SpanKind {
  SPAN_KIND_UNSPECIFIED = 0;
  SPAN_KIND_INTERNAL = 1;
  SPAN_KIND_SERVER = 2;
  SPAN_KIND_CLIENT = 3;
  SPAN_KIND_PRODUCER = 4;
  SPAN_KIND_CONSUMER = 5;
}

message Event {
  fixed64 time_unix_nano = 1;
  string name = 2;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 4;
  uint32 dropped_attributes_count = 5;
}

message Status {
  reserved 1; // deprecated status_message
  string message = 2;
  // OTel 规范 code=3；保留 code=2 (deprecated_code) 用于对旧 SDK 的 wire 兼容性
  StatusCode code = 3;
}

enum StatusCode {
  STATUS_CODE_UNSET = 0;
  STATUS_CODE_OK = 1;
  STATUS_CODE_ERROR = 2;
}

// OTel 从 0.7 开始 InstrumentationLibrary → InstrumentationScope 重命名。
// 两个字段号相同都指向 1/2，protobuf oneof 不兼容。为同时支持新老 wire，
// protobufjs 的解析允许同一消息里两种命名都映射到同字段（靠字段号而非名字），
// 这里写较新的 InstrumentationScope，同时下游 Pb* 类型会把 instrumentationLibrary
// 属性兜底也映射。
message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}
`;

const COLLECTOR_TRACE_PROTO = `
syntax = "proto3";

package opentelemetry.proto.collector.trace.v1;

message ExportTraceServiceRequest {
  repeated opentelemetry.proto.trace.v1.ResourceSpans resource_spans = 1;
}
`;

const METRICS_PROTO = `
syntax = "proto3";

package opentelemetry.proto.metrics.v1;

message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  // OTel 规范 v1.3.0 枚举：oneof data { Gauge=5, Sum=7, Histogram=9, ExponentialHistogram=10, Summary=11 }
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary summary = 11;
  }
}

message Gauge {
  repeated NumberDataPoint data_points = 1;
}

message Sum {
  repeated NumberDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
  bool is_monotonic = 3;
}

message Histogram {
  repeated HistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message ExponentialHistogram {
  repeated ExponentialHistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message Summary {
  repeated SummaryDataPoint data_points = 1;
}

// 字段号与官方 opentelemetry-proto v1.3.0 metrics.proto 一致：
//   NumberDataPoint:    attributes=7, exemplars=5, flags=8
//   HistogramDataPoint: attributes=9, exemplars=8, flags=10, min=11, max=12
//   SummaryDataPoint:   attributes=7, quantile_values=6, flags=8
//   ExponentialHistogramDataPoint: attributes=1, scale=6, zero_count=7, ...
// 之前把 attributes 错写成 1（与官方 7/9/7 相反），min/max 错写成 10/11，
// 导致官方 SDK 编码的 attributes 全被跳过、min/max 错位。回归官方编号。
message NumberDataPoint {
  reserved 1; // 官方保留字段（废弃的 labels）
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value {
    double as_double = 4;
    sfixed64 as_int = 6;
  }
  repeated Exemplar exemplars = 5;
  uint32 flags = 8;
}

message HistogramDataPoint {
  reserved 1; // 官方保留字段（废弃的 labels）
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
  repeated Exemplar exemplars = 8;
  uint32 flags = 10;
  double min = 11;
  double max = 12;
}

message ExponentialHistogramDataPoint {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  sint32 scale = 6;
  fixed64 zero_count = 7;
  Buckets positive = 8;
  Buckets negative = 9;
  double zero_threshold = 10;
  repeated Exemplar exemplars = 11;
  uint32 flags = 12;
  double min = 13;
  double max = 14;
}

message Buckets {
  sint32 offset = 1;
  repeated fixed64 bucket_counts = 2;
}

message SummaryDataPoint {
  reserved 1; // 官方保留字段（废弃的 labels）
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated ValueAtQuantile quantile_values = 6;
  uint32 flags = 8;
}

message ValueAtQuantile {
  double quantile = 1;
  double value = 2;
}

message Exemplar {
  repeated opentelemetry.proto.common.v1.KeyValue filtered_attributes = 7;
  fixed64 time_unix_nano = 2;
  oneof value {
    double as_double = 3;
    sfixed64 as_int = 6;
  }
  bytes span_id = 4;
  bytes trace_id = 5;
}

enum AggregationTemporality {
  AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
  AGGREGATION_TEMPORALITY_DELTA = 1;
  AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
}

message ScopeMetrics {
  opentelemetry.proto.trace.v1.InstrumentationScope scope = 1;
  repeated Metric metrics = 2;
  string schema_url = 3;
}

message ResourceMetrics {
  opentelemetry.proto.resource.v1.Resource resource = 1;
  repeated ScopeMetrics scope_metrics = 2;
  string schema_url = 3;
}
`;

const COLLECTOR_METRICS_PROTO = `
syntax = "proto3";

package opentelemetry.proto.collector.metrics.v1;

message ExportMetricsServiceRequest {
  repeated opentelemetry.proto.metrics.v1.ResourceMetrics resource_metrics = 1;
}
`;

const root = new protobuf.Root();
protobuf.parse(COMMON_PROTO, root);
protobuf.parse(RESOURCE_PROTO, root);
protobuf.parse(TRACE_PROTO, root);
protobuf.parse(COLLECTOR_TRACE_PROTO, root);
protobuf.parse(METRICS_PROTO, root);
protobuf.parse(COLLECTOR_METRICS_PROTO, root);
root.resolveAll();
const ExportTraceServiceRequestType = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);
const ExportMetricsServiceRequestType = root.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);

// ---------------------------------------------------------------------------
// protobufjs 解码产物（camelCase）的局部类型
// ---------------------------------------------------------------------------

interface PbAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: { toString(): string };
  doubleValue?: number;
  bytesValue?: Uint8Array;
  arrayValue?: { values?: PbAnyValue[] };
  kvlistValue?: { values?: PbKeyValue[] };
}

interface PbKeyValue {
  key?: string;
  value?: PbAnyValue;
}

interface PbSpanStatus {
  message?: string;
  code?: number;
}

interface PbSpanEvent {
  timeUnixNano?: { toString(): string };
  name?: string;
  attributes?: PbKeyValue[];
}

interface PbSpan {
  traceId?: Uint8Array;
  spanId?: Uint8Array;
  parentSpanId?: Uint8Array;
  name?: string;
  kind?: number;
  startTimeUnixNano?: { toString(): string };
  endTimeUnixNano?: { toString(): string };
  attributes?: PbKeyValue[];
  events?: PbSpanEvent[];
  status?: PbSpanStatus;
}

interface PbScopeSpans {
  scope?: { name?: string; version?: string };
  instrumentationLibrary?: { name?: string; version?: string };
  spans?: PbSpan[];
}

interface PbResourceSpans {
  resource?: { attributes?: PbKeyValue[] };
  scopeSpans?: PbScopeSpans[];
}

interface PbExportTraceServiceRequest {
  resourceSpans?: PbResourceSpans[];
}

// ---------------------------------------------------------------------------
// 字节 / 数值 → OTLP JSON 字符串形态
// ---------------------------------------------------------------------------

/**
 * 判断字段是否真的在 wire 上出现过。
 * protobufjs v8 解码产物是 Message 实例：未设置的 proto3 标量字段会通过
 * 原型 getter 返回默认值（string→""、bool→false、int→0），不能用
 * `!== undefined` 判断，必须查 own property。
 */
function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Buffer 仅 Node 运行时；纯 JS 兜底保证可移植
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** protobufjs Long / 数值 → 十进制字符串（对齐 OTLP JSON 的 int64/fixed64 编码） */
function longToStr(v: { toString(): string }): string {
  return v.toString();
}

// ---------------------------------------------------------------------------
// 消息映射：protobufjs 产物 → OTLP JSON 结构
// ---------------------------------------------------------------------------

function mapAnyValue(v: PbAnyValue | undefined): OtlpAnyValue | undefined {
  if (!v || typeof v !== "object") return undefined;
  if (has(v, "stringValue")) return { stringValue: v.stringValue! };
  if (has(v, "boolValue")) return { boolValue: v.boolValue! };
  if (has(v, "intValue")) return { intValue: longToStr(v.intValue!) };
  if (has(v, "doubleValue")) return { doubleValue: v.doubleValue! };
  if (has(v, "bytesValue")) return { bytesValue: bytesToBase64(v.bytesValue!) };
  if (has(v, "arrayValue")) {
    return {
      arrayValue: {
        values: (v.arrayValue?.values ?? []).map((x) => mapAnyValue(x) ?? {}),
      },
    };
  }
  if (has(v, "kvlistValue")) {
    return { kvlistValue: { values: (v.kvlistValue?.values ?? []).map(mapKeyValue) } };
  }
  return undefined;
}

function mapKeyValue(kv: PbKeyValue): OtlpKeyValue {
  return { key: has(kv, "key") ? kv.key! : "", value: mapAnyValue(kv.value) };
}

function mapSpanEvent(e: PbSpanEvent): OtlpSpanEvent {
  const out: OtlpSpanEvent = {};
  if (has(e, "timeUnixNano")) out.timeUnixNano = longToStr(e.timeUnixNano!);
  if (has(e, "name")) out.name = e.name;
  if (has(e, "attributes")) out.attributes = e.attributes!.map(mapKeyValue);
  return out;
}

function mapSpan(span: PbSpan): OtlpSpan {
  const out: OtlpSpan = {};
  if (has(span, "traceId")) out.traceId = bytesToHex(span.traceId!);
  if (has(span, "spanId")) out.spanId = bytesToHex(span.spanId!);
  if (has(span, "parentSpanId")) out.parentSpanId = bytesToHex(span.parentSpanId!);
  if (has(span, "name")) out.name = span.name;
  if (has(span, "kind")) out.kind = span.kind;
  if (has(span, "startTimeUnixNano")) out.startTimeUnixNano = longToStr(span.startTimeUnixNano!);
  if (has(span, "endTimeUnixNano")) out.endTimeUnixNano = longToStr(span.endTimeUnixNano!);

  // attributes/events/status 与官方 trace.proto 字段号一一对应，
  // 无需再合并 otel_ 前缀的双字段（已删）。
  if (has(span, "attributes") && span.attributes!.length > 0) {
    out.attributes = span.attributes!.map(mapKeyValue);
  }

  if (has(span, "events") && span.events!.length > 0) {
    out.events = span.events!.map(mapSpanEvent);
  }

  if (has(span, "status")) {
    out.status = {};
    if (has(span.status!, "message")) out.status.message = span.status!.message;
    if (has(span.status!, "code")) out.status.code = span.status!.code;
  }
  return out;
}

function mapScopeSpans(ss: PbScopeSpans): OtlpScopeSpans {
  const out: OtlpScopeSpans = {};
  const scopeSrc = has(ss, "scope") ? ss.scope! : ss.instrumentationLibrary;
  if (scopeSrc) {
    out.scope = {};
    if (has(scopeSrc, "name")) out.scope.name = scopeSrc.name;
    if (has(scopeSrc, "version")) out.scope.version = scopeSrc.version;
  }
  if (has(ss, "spans") && ss.spans!.length > 0) out.spans = ss.spans!.map(mapSpan);
  return out;
}

function mapResourceSpans(rs: PbResourceSpans): OtlpResourceSpans {
  const out: OtlpResourceSpans = {};
  if (has(rs, "resource")) {
    out.resource = {};
    if (has(rs.resource!, "attributes") && rs.resource!.attributes!.length > 0) {
      out.resource.attributes = rs.resource!.attributes!.map(mapKeyValue);
    }
  }
  if (has(rs, "scopeSpans") && rs.scopeSpans!.length > 0) {
    out.scopeSpans = rs.scopeSpans!.map(mapScopeSpans);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 解码 OTLP protobuf 二进制（ExportTraceServiceRequest）
 * 输出与 OTLP JSON 一致的结构，可直接喂给 parseOtelPayload
 */
export function decodeOtlpProtobuf(bytes: Uint8Array): OtlpExportTraceServiceRequest {
  const decoded = ExportTraceServiceRequestType.decode(bytes) as unknown as PbExportTraceServiceRequest;
  const out: OtlpExportTraceServiceRequest = {};
  // resourceSpans 是 repeated 字段，构造时初始化为 []；为空时省略，
  // 与 JSON 通道的空 payload 行为一致
  if (decoded.resourceSpans && decoded.resourceSpans.length > 0) {
    out.resourceSpans = decoded.resourceSpans.map(mapResourceSpans);
  }
  return out;
}

// ---------------------------------------------------------------------------
// OTLP Metrics：protobufjs 产物 → OTLP JSON 结构
// ---------------------------------------------------------------------------

interface PbMetricDataPoint {
  attributes?: PbKeyValue[];
  startTimeUnixNano?: { toString(): string };
  timeUnixNano?: { toString(): string };
  asDouble?: number;
  asInt?: { toString(): string };
  count?: { toString(): string };
  sum?: number;
  min?: number;
  max?: number;
  bucketCounts?: Array<number | { toString(): string }>;
  explicitBounds?: number[];
  // ExponentialHistogram
  scale?: number;
  zeroCount?: { toString(): string };
  positive?: { offset?: number; bucketCounts?: Array<number | { toString(): string }> };
  negative?: { offset?: number; bucketCounts?: Array<number | { toString(): string }> };
  zeroThreshold?: number;
}

interface PbMetric {
  name?: string;
  description?: string;
  unit?: string;
  gauge?: { dataPoints?: PbMetricDataPoint[] };
  sum?: { dataPoints?: PbMetricDataPoint[]; aggregationTemporality?: number; isMonotonic?: boolean };
  histogram?: { dataPoints?: PbMetricDataPoint[]; aggregationTemporality?: number };
  exponentialHistogram?: { dataPoints?: PbMetricDataPoint[]; aggregationTemporality?: number };
  summary?: { dataPoints?: PbMetricDataPoint[] };
}

interface PbScopeMetrics {
  scope?: { name?: string; version?: string };
  instrumentationLibrary?: { name?: string; version?: string };
  metrics?: PbMetric[];
}

interface PbResourceMetrics {
  resource?: { attributes?: PbKeyValue[] };
  scopeMetrics?: PbScopeMetrics[];
}

interface PbExportMetricsServiceRequest {
  resourceMetrics?: PbResourceMetrics[];
}

function mapMetricDataPoint(dp: PbMetricDataPoint): OtlpMetricDataPoint {
  const out: OtlpMetricDataPoint = {};
  if (has(dp, "attributes") && dp.attributes!.length > 0) {
    out.attributes = dp.attributes!.map(mapKeyValue);
  }
  if (has(dp, "startTimeUnixNano")) out.startTimeUnixNano = longToStr(dp.startTimeUnixNano!);
  if (has(dp, "timeUnixNano")) out.timeUnixNano = longToStr(dp.timeUnixNano!);
  if (has(dp, "asDouble")) out.asDouble = dp.asDouble;
  if (has(dp, "asInt")) out.asInt = longToStr(dp.asInt!);
  if (has(dp, "count")) out.count = longToStr(dp.count!);
  if (has(dp, "sum")) out.sum = dp.sum;
  if (has(dp, "min")) out.min = dp.min;
  if (has(dp, "max")) out.max = dp.max;
  if (has(dp, "bucketCounts") && dp.bucketCounts!.length > 0) {
    // fixed64 → protobufjs Long 对象，统一转字符串与 JSON 通道（"10"）对齐
    out.bucketCounts = dp.bucketCounts!.map((b) =>
      typeof b === "object" ? b.toString() : b,
    );
  }
  if (has(dp, "explicitBounds") && dp.explicitBounds!.length > 0) {
    out.explicitBounds = dp.explicitBounds!;
  }
  return out;
}

function mapMetric(m: PbMetric): OtlpMetric {
  const out: OtlpMetric = {};
  if (has(m, "name")) out.name = m.name;
  if (has(m, "description")) out.description = m.description;
  if (has(m, "unit")) out.unit = m.unit;
  if (has(m, "gauge") && m.gauge!.dataPoints!.length > 0) {
    out.gauge = { dataPoints: m.gauge!.dataPoints!.map(mapMetricDataPoint) };
  }
  if (has(m, "sum") && m.sum!.dataPoints!.length > 0) {
    out.sum = {
      dataPoints: m.sum!.dataPoints!.map(mapMetricDataPoint),
      ...(has(m.sum!, "aggregationTemporality")
        ? { aggregationTemporality: m.sum!.aggregationTemporality }
        : {}),
      ...(has(m.sum!, "isMonotonic") ? { isMonotonic: m.sum!.isMonotonic } : {}),
    };
  }
  if (has(m, "histogram") && m.histogram!.dataPoints!.length > 0) {
    out.histogram = {
      dataPoints: m.histogram!.dataPoints!.map(mapMetricDataPoint),
      ...(has(m.histogram!, "aggregationTemporality")
        ? { aggregationTemporality: m.histogram!.aggregationTemporality }
        : {}),
    };
  }
  if (has(m, "exponentialHistogram") && m.exponentialHistogram!.dataPoints!.length > 0) {
    out.exponentialHistogram = {
      dataPoints: m.exponentialHistogram!.dataPoints!.map(mapMetricDataPoint),
      ...(has(m.exponentialHistogram!, "aggregationTemporality")
        ? { aggregationTemporality: m.exponentialHistogram!.aggregationTemporality }
        : {}),
    };
  }
  if (has(m, "summary") && m.summary!.dataPoints!.length > 0) {
    out.summary = { dataPoints: m.summary!.dataPoints!.map(mapMetricDataPoint) };
  }
  return out;
}

function mapScopeMetrics(sm: PbScopeMetrics): OtlpScopeMetrics {
  const out: OtlpScopeMetrics = {};
  // OTel 0.7+ scope；老 SDK 仍会写 instrumentationLibrary 老名字
  const scopeSrc = has(sm, "scope") ? sm.scope! : sm.instrumentationLibrary;
  if (scopeSrc) {
    out.scope = {};
    if (has(scopeSrc, "name")) out.scope.name = scopeSrc.name;
    if (has(scopeSrc, "version")) out.scope.version = scopeSrc.version;
  }
  if (has(sm, "metrics") && sm.metrics!.length > 0) out.metrics = sm.metrics!.map(mapMetric);
  return out;
}

function mapResourceMetrics(rm: PbResourceMetrics): OtlpResourceMetrics {
  const out: OtlpResourceMetrics = {};
  if (has(rm, "resource")) {
    out.resource = {};
    if (has(rm.resource!, "attributes") && rm.resource!.attributes!.length > 0) {
      out.resource.attributes = rm.resource!.attributes!.map(mapKeyValue);
    }
  }
  if (has(rm, "scopeMetrics") && rm.scopeMetrics!.length > 0) {
    out.scopeMetrics = rm.scopeMetrics!.map(mapScopeMetrics);
  }
  return out;
}

/**
 * 解码 OTLP metrics protobuf 二进制（ExportMetricsServiceRequest）
 * 输出与 OTLP JSON 一致的结构，可直接喂给 parseOtelMetricsPayload
 */
export function decodeOtlpMetricsProtobuf(
  bytes: Uint8Array,
): OtlpExportMetricsServiceRequest {
  const decoded = ExportMetricsServiceRequestType.decode(
    bytes,
  ) as unknown as PbExportMetricsServiceRequest;
  const out: OtlpExportMetricsServiceRequest = {};
  if (decoded.resourceMetrics && decoded.resourceMetrics.length > 0) {
    out.resourceMetrics = decoded.resourceMetrics.map(mapResourceMetrics);
  }
  return out;
}
