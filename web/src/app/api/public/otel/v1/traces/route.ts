import { verifyApiKey, processOtelTraces, decodeOtlpProtobuf } from "@machora/shared";

// OTLP HTTP 注入端点（Phase 0：JSON；Phase 2：protobuf）
// LangChain / LangGraph / LlamaIndex 等框架通过
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT + Basic Auth 指向本端点
export async function POST(req: Request) {
  const auth = await verifyApiKey(
    req.headers.get("authorization") ?? undefined,
  );
  if (!auth) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let body: unknown;

  if (contentType.includes("protobuf")) {
    // OTLP HTTP protobuf（application/x-protobuf，多数 SDK 的默认导出格式）
    const buf = await req.arrayBuffer();
    try {
      body = decodeOtlpProtobuf(new Uint8Array(buf));
    } catch {
      return Response.json({ error: "Invalid protobuf payload" }, { status: 400 });
    }
  } else {
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const result = await processOtelTraces(auth.projectId, body);
  return Response.json({
    success: true,
    traces: result.traces,
    observations: result.observations,
    ...(result.errors.length > 0
      ? { errors: result.errors.slice(0, 20) }
      : {}),
  });
}
