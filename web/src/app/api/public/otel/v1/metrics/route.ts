import {
  parseOtelMetricsPayload,
  decodeOtelMetricsRequest,
  OtelDecodeError,
  db,
  metricSample,
  selfMetrics,
} from "@machora/shared";

// OTLP HTTP metrics 注入端点
// 支持 JSON / protobuf，以及 gzip / deflate / br 压缩
// 任意 OTLP metrics exporter（Prometheus RemoteWrite→OTLP、SDK metrics 等）
// 经 OTEL_EXPORTER_OTLP_METRICS_ENDPOINT 指向本端点
export async function POST(req: Request) {
  const start = Date.now();

  let body;
  try {
    body = await decodeOtelMetricsRequest(req);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (e instanceof OtelDecodeError) {
      selfMetrics.inc("machora.metrics.requests", 1, { status: e.status });
      return Response.json(
        { error: err.message },
        { status: e.status === "too-large" ? 413 : 400 },
      );
    }
    selfMetrics.inc("machora.metrics.requests", 1, { status: "bad-protobuf" });
    return Response.json({ error: `Invalid protobuf payload: ${err.message}` }, { status: 400 });
  }

  const samples = parseOtelMetricsPayload(body);
  let written = 0;
  if (samples.length > 0) {
    await db.insert(metricSample).values(
      samples.map((s) => ({
        name: s.name,
        unit: s.unit,
        kind: s.kind,
        attributes: s.attributes as unknown as typeof metricSample.$inferInsert["attributes"],
        timestamp: s.timestamp,
        value: s.value,
        count: s.count,
        sum: s.sum,
        min: s.min,
        max: s.max,
        buckets: (s.buckets ?? null) as unknown as typeof metricSample.$inferInsert["buckets"],
      })),
    );
    written = samples.length;
  }

  selfMetrics.inc("machora.metrics.requests", 1, { status: "ok" });
  selfMetrics.inc("machora.metrics.samples", samples.length);
  selfMetrics.inc("machora.metrics.written", written);
  selfMetrics.observe("machora.metrics.duration_ms", Date.now() - start);

  return Response.json({ success: true, metrics: written });
}
