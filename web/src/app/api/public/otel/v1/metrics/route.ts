import {
  parseOtelMetricsPayload,
  decodeOtlpMetricsProtobuf,
  db,
  metricSample,
  selfMetrics,
} from "@machora/shared";

// OTLP HTTP metrics 注入端点（JSON + protobuf 双通道）
// 任意 OTLP metrics exporter（Prometheus RemoteWrite→OTLP、SDK metrics 等）
// 经 OTEL_EXPORTER_OTLP_METRICS_ENDPOINT 指向本端点
export async function POST(req: Request) {
  const start = Date.now();
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let body: unknown;

  if (contentType.includes("protobuf")) {
    const buf = await req.arrayBuffer();
    try {
      body = decodeOtlpMetricsProtobuf(new Uint8Array(buf));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      selfMetrics.inc("machora.metrics.requests", 1, { status: "bad-protobuf" });
      return Response.json(
        { error: `Invalid protobuf payload: ${err.message}` },
        { status: 400 },
      );
    }
  } else {
    try {
      body = await req.json();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      selfMetrics.inc("machora.metrics.requests", 1, { status: "bad-json" });
      return Response.json({ error: `Invalid JSON body: ${err.message}` }, { status: 400 });
    }
  }

  const samples = parseOtelMetricsPayload(body as any);
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
