import {
  processOtelTraces,
  decodeOtelTraceRequest,
  OtelDecodeError,
  selfMetrics,
} from "@machora/shared";

// OTLP HTTP traces 注入端点
// 支持 JSON / protobuf，以及 gzip / deflate / br 压缩
// LangChain / LangGraph / LlamaIndex 等框架通过
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 指向本端点
export async function POST(req: Request) {
  let body;
  try {
    body = await decodeOtelTraceRequest(req);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (e instanceof OtelDecodeError) {
      selfMetrics.inc("machora.traces.requests", 1, { status: e.status });
      return Response.json({ error: err.message }, { status: 400 });
    }
    selfMetrics.inc("machora.traces.requests", 1, { status: "bad-protobuf" });
    return Response.json({ error: `Invalid protobuf payload: ${err.message}` }, { status: 400 });
  }

  const result = await processOtelTraces(body);
  selfMetrics.inc("machora.traces.requests", 1, { status: "ok" });
  return Response.json({
    success: true,
    traces: result.traces,
    observations: result.observations,
    ...(result.errors.length > 0
      ? { errors: result.errors.slice(0, 20) }
      : {}),
  });
}
