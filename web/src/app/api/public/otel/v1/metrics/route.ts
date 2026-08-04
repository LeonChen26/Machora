import {
  verifyApiKey,
  parseOtelMetricsPayload,
  decodeOtlpMetricsProtobuf,
  prisma,
  selfMetrics,
} from "@machora/shared";

// OTLP HTTP metrics 注入端点（JSON + protobuf 双通道）
// 任意 OTLP metrics exporter（Prometheus RemoteWrite→OTLP、SDK metrics 等）
// 经 OTEL_EXPORTER_OTLP_METRICS_ENDPOINT + Basic Auth 指向本端点
export async function POST(req: Request) {
  const start = Date.now();
  const auth = await verifyApiKey(
    req.headers.get("authorization") ?? undefined,
  );
  if (!auth) {
    selfMetrics.inc("machora.metrics.requests", 1, { status: "unauthorized" });
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let body: unknown;

  if (contentType.includes("protobuf")) {
    const buf = await req.arrayBuffer();
    try {
      body = decodeOtlpMetricsProtobuf(new Uint8Array(buf));
    } catch {
      selfMetrics.inc("machora.metrics.requests", 1, { status: "bad-protobuf" });
      return Response.json(
        { error: "Invalid protobuf payload" },
        { status: 400 },
      );
    }
  } else {
    try {
      body = await req.json();
    } catch {
      selfMetrics.inc("machora.metrics.requests", 1, { status: "bad-json" });
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const samples = parseOtelMetricsPayload(body as any, auth.projectId);
  let written = 0;
  if (samples.length > 0) {
    const created = await prisma.metricSample.createMany({
      data: samples.map((s) => ({
        projectId: s.projectId,
        name: s.name,
        unit: s.unit,
        kind: s.kind,
        attributes: s.attributes as object,
        timestamp: s.timestamp,
        value: s.value,
        count: s.count,
        sum: s.sum,
        min: s.min,
        max: s.max,
        buckets: s.buckets as object | undefined,
      })),
    });
    written = created.count;
  }

  selfMetrics.inc("machora.metrics.requests", 1, { status: "ok" });
  selfMetrics.inc("machora.metrics.samples", samples.length);
  selfMetrics.inc("machora.metrics.written", written);
  selfMetrics.observe("machora.metrics.duration_ms", Date.now() - start);

  return Response.json({ success: true, metrics: written });
}
