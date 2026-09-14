import {
  processOtelTraces,
  decodeOtelTraceRequest,
  OtelDecodeError,
  selfMetrics,
  queueBus,
  QUEUES,
} from "@machora/shared";

// OTLP HTTP traces 注入端点
// 支持 JSON / protobuf，以及 gzip / deflate / br 压缩
// LangChain / LangGraph / LlamaIndex 等框架通过 OTLP traces 端点变量
// （OTEL_EXPORTER_OTLP_ENDPOINT 或 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT，
//   取决于框架/导出器实现）指向本端点
// 这是唯一的写入通道：落库成功后触发在线自动评估（QUEUES.ingestion）
export async function POST(req: Request) {
  let body;
  try {
    body = await decodeOtelTraceRequest(req);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (e instanceof OtelDecodeError) {
      selfMetrics.inc("machora.traces.requests", 1, { status: e.status });
      return Response.json(
        { error: err.message },
        { status: e.status === "too-large" ? 413 : 400 },
      );
    }
    selfMetrics.inc("machora.traces.requests", 1, { status: "bad-protobuf" });
    return Response.json({ error: `Invalid protobuf payload: ${err.message}` }, { status: 400 });
  }

  const result = await processOtelTraces(body);

  // 写入后触发在线自动评估：对 autoRun 的评估配置按 trace 逐条创建任务
  // （非阻塞：queueBus 内部 setImmediate 投递）
  for (const traceId of result.traceIds) {
    queueBus.enqueue(QUEUES.ingestion, { traceId });
  }

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
