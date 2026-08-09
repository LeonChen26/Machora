// OTLP trace exporter setup for the Machora probe.
// Uses an independent BasicTracerProvider so it never conflicts with the
// diagnostics-otel plugin (which owns the global/ambient OTel setup).

import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export type ProbeExporterOptions = {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  flushIntervalMs?: number;
};

export function createProbeExporter(opts: ProbeExporterOptions): {
  provider: BasicTracerProvider;
  shutdown: () => Promise<void>;
} {
  const exporter = new OTLPTraceExporter({
    url: opts.endpoint,
    headers: opts.headers,
  });

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName ?? "machora-openclaw-probe",
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: Math.max(1000, opts.flushIntervalMs ?? 5000),
      }),
    ],
  });

  const shutdown = async () => {
    await provider.shutdown().catch(() => undefined);
  };
  return { provider, shutdown };
}
