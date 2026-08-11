// Machora OpenInference probe service.
//
// Subscribes to OpenClaw diagnostic events and re-emits them as
// OpenInference semantic spans to a Machora OTLP endpoint, so that
// agent runs, model calls and tool executions show up in the Machora
// trace explorer with correct role classification (AGENT/CHAIN/LLM/TOOL).

import { SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  MACHORA_AGENT_NAME,
  MACHORA_INPUT,
  MACHORA_LEVEL,
  MACHORA_MODEL_NAME,
  MACHORA_OUTPUT,
  MACHORA_SESSION_ID,
  MACHORA_SPAN_KIND,
  MACHORA_TOKEN_INPUT,
  MACHORA_TOKEN_OUTPUT,
  MACHORA_TOKEN_TOTAL,
  MACHORA_TOOL_CALL_ID,
  MACHORA_TOOL_NAME,
  SPAN_KIND_AGENT,
  SPAN_KIND_ENTRY,
  SPAN_KIND_LLM,
  SPAN_KIND_TOOL,
} from "./attributes.js";
import { createProbeExporter } from "./exporter.js";

export type ProbePluginConfig = {
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  flushIntervalMs?: number;
};

type PendingSpan = {
  span: Span;
};

function jsonOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function createMachoraOpenInferenceService(): OpenClawPluginService {
  let provider: BasicTracerProvider | null = null;
  let unsubscribe: (() => void) | null = null;

  const stop = async () => {
    const current = provider;
    provider = null;
    unsubscribe?.();
    unsubscribe = null;
    if (current) {
      await current.shutdown().catch(() => undefined);
    }
  };

  return {
    id: "machora-openinference",
    async start(ctx) {
      await stop();

      const cfg = (ctx.config.plugins?.entries?.["machora-openinference"]?.config ??
        {}) as ProbePluginConfig;
      const endpoint =
        cfg.endpoint?.trim() ||
        process.env.MACHORA_OTEL_ENDPOINT?.trim() ||
        "http://localhost:3100/api/public/otel/v1/traces";
      let headers: Record<string, string> | undefined = cfg.headers;
      if (!headers && process.env.MACHORA_OTEL_HEADERS?.trim()) {
        try {
          headers = JSON.parse(process.env.MACHORA_OTEL_HEADERS) as Record<string, string>;
        } catch {
          headers = undefined;
        }
      }
      const serviceName = cfg.serviceName?.trim() || process.env.MACHORA_OTEL_SERVICE_NAME || "openclaw";

      const { provider: probeProvider } = createProbeExporter({
        endpoint,
        headers,
        serviceName,
        flushIntervalMs: cfg.flushIntervalMs,
      });
      provider = probeProvider;
      const tracer = probeProvider.getTracer("machora-openinference");

      // Active span registry keyed by event identity, so completed/error
      // events can close spans started by their started-event counterparts.
      const active = new Map<string, PendingSpan>();

      const parentCtx = (parent?: Span) =>
        parent ? trace.setSpan(context.active(), parent) : undefined;

      const startSpan = (key: string, name: string, startTimeMs: number, attrs: Record<string, string | number | boolean | undefined>, parent?: Span) => {
        const span = tracer.startSpan(name, {
          startTime: startTimeMs,
          attributes: attrs,
        }, parentCtx(parent));
        active.set(key, { span });
        return span;
      };

      // Events may arrive without a matching started event (async queue drop).
      // Fall back to a span derived from the completed event's duration.
      const fallbackSpan = (key: string, name: string, evt: { ts: number; durationMs?: number }, attrs: Record<string, string | number | boolean | undefined>, parent?: Span) => {
        const startTimeMs = evt.ts - (evt.durationMs ?? 0);
        const span = tracer.startSpan(name, {
          startTime: startTimeMs,
          attributes: attrs,
        }, parentCtx(parent));
        active.set(key, { span });
        return span;
      };

      const sessionId = (evt: DiagnosticEventPayload) => {
        const id =
          "sessionId" in evt ? (evt as { sessionId?: string }).sessionId : undefined;
        const key = "sessionKey" in evt ? (evt as { sessionKey?: string }).sessionKey : undefined;
        return id ?? key ?? undefined;
      };

      const baseAttrs = (evt: DiagnosticEventPayload, kind: string): Record<string, string | number | boolean | undefined> => {
        const attrs: Record<string, string | number | boolean | undefined> = {
          [MACHORA_SPAN_KIND]: kind,
        };
        const sid = sessionId(evt);
        if (sid) {
          attrs[MACHORA_SESSION_ID] = sid;
        }
        return attrs;
      };

      const handle = (
        evt: DiagnosticEventPayload,
        _metadata: DiagnosticEventMetadata,
        privateData: DiagnosticEventPrivateData,
      ) => {
        switch (evt.type) {
          case "harness.run.started": {
            const attrs = baseAttrs(evt, SPAN_KIND_ENTRY);
            attrs[MACHORA_AGENT_NAME] = evt.harnessId;
            startSpan(`h:${evt.runId}`, `harness ${evt.harnessId}`, evt.ts, attrs);
            return;
          }
          case "harness.run.completed": {
            const key = `h:${evt.runId}`;
            const span = active.get(key)?.span ?? fallbackSpan(key, `harness ${evt.harnessId}`, evt, {
              ...baseAttrs(evt, SPAN_KIND_ENTRY),
              [MACHORA_AGENT_NAME]: evt.harnessId,
            });
            if (evt.outcome === "error") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: privateData.errorMessage ?? "error" });
              span.setAttribute(MACHORA_LEVEL, "ERROR");
            }
            active.delete(key);
            span.end(evt.ts);
            return;
          }
          case "harness.run.error": {
            const key = `h:${evt.runId}`;
            const span = active.get(key)?.span ?? fallbackSpan(key, `harness ${evt.harnessId}`, evt, {
              ...baseAttrs(evt, SPAN_KIND_ENTRY),
              [MACHORA_AGENT_NAME]: evt.harnessId,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: privateData.errorMessage ?? evt.errorCategory });
            span.setAttribute(MACHORA_LEVEL, "ERROR");
            active.delete(key);
            span.end(evt.ts);
            return;
          }
          case "run.started": {
            const attrs = baseAttrs(evt, SPAN_KIND_AGENT);
            const parent = active.get(`h:${evt.runId}`)?.span;
            startSpan(`r:${evt.runId}`, `run ${evt.model ?? evt.provider ?? ""}`.trim(), evt.ts, attrs, parent);
            return;
          }
          case "run.completed": {
            const key = `r:${evt.runId}`;
            const span = active.get(key)?.span ?? fallbackSpan(key, `run ${evt.model ?? evt.provider ?? ""}`.trim(), evt, baseAttrs(evt, SPAN_KIND_AGENT));
            if (evt.outcome === "error") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: privateData.errorMessage ?? evt.errorCategory ?? "error" });
              span.setAttribute(MACHORA_LEVEL, "ERROR");
            }
            active.delete(key);
            span.end(evt.ts);
            return;
          }
          case "model.call.started": {
            const attrs = baseAttrs(evt, SPAN_KIND_LLM);
            attrs[MACHORA_MODEL_NAME] = evt.model;
            const parent = active.get(`r:${evt.runId}`)?.span;
            startSpan(`m:${evt.callId}`, `model ${evt.model}`, evt.ts, attrs, parent);
            return;
          }
          case "model.call.completed":
          case "model.call.error": {
            const key = `m:${evt.callId}`;
            const span = active.get(key)?.span ?? fallbackSpan(key, `model ${evt.model}`, evt, {
              ...baseAttrs(evt, SPAN_KIND_LLM),
              [MACHORA_MODEL_NAME]: evt.model,
            });
            const usage = evt.usage;
            if (usage) {
              span.setAttributes({
                [MACHORA_TOKEN_INPUT]: usage.input ?? usage.promptTokens ?? 0,
                [MACHORA_TOKEN_OUTPUT]: usage.output ?? 0,
                [MACHORA_TOKEN_TOTAL]: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
              });
            }
            const input = jsonOrUndefined(privateData.modelContent?.inputMessages);
            const output = jsonOrUndefined(privateData.modelContent?.outputMessages);
            if (input) span.setAttribute(MACHORA_INPUT, input);
            if (output) span.setAttribute(MACHORA_OUTPUT, output);
            active.delete(key);
            if (evt.type === "model.call.error") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: privateData.errorMessage ?? evt.errorCategory });
              span.setAttribute(MACHORA_LEVEL, "ERROR");
            }
            span.end(evt.ts);
            return;
          }
          case "tool.execution.started": {
            const attrs = baseAttrs(evt, SPAN_KIND_TOOL);
            attrs[MACHORA_TOOL_NAME] = evt.toolName;
            if (evt.toolCallId) attrs[MACHORA_TOOL_CALL_ID] = evt.toolCallId;
            const parent = active.get(`r:${evt.runId}`)?.span;
            startSpan(`t:${evt.toolCallId ?? evt.toolName}`, `tool ${evt.toolName}`, evt.ts, attrs, parent);
            return;
          }
          case "tool.execution.completed":
          case "tool.execution.error": {
            const key = `t:${evt.toolCallId ?? evt.toolName}`;
            const span = active.get(key)?.span ?? fallbackSpan(key, `tool ${evt.toolName}`, evt, {
              ...baseAttrs(evt, SPAN_KIND_TOOL),
              [MACHORA_TOOL_NAME]: evt.toolName,
              ...(evt.toolCallId ? { [MACHORA_TOOL_CALL_ID]: evt.toolCallId } : {}),
            });
            const input = jsonOrUndefined(privateData.toolContent?.toolInput);
            const output = jsonOrUndefined(privateData.toolContent?.toolOutput);
            if (input) span.setAttribute(MACHORA_INPUT, input);
            if (output) span.setAttribute(MACHORA_OUTPUT, output);
            active.delete(key);
            if (evt.type === "tool.execution.error") {
              span.setStatus({ code: SpanStatusCode.ERROR, message: privateData.errorMessage ?? evt.errorCategory });
              span.setAttribute(MACHORA_LEVEL, "ERROR");
            }
            span.end(evt.ts);
            return;
          }
          default:
            return;
        }
      };

      const unsub = ctx.internalDiagnostics?.onEvent((evt, metadata, privateData) => {
        try {
          handle(evt, metadata, privateData);
        } catch (err) {
          ctx.logger.warn(`machora-openinference: event handling failed: ${String(err)}`);
        }
      });
      unsubscribe = unsub ?? null;
      ctx.logger.info(`machora-openinference: exporting to ${endpoint}`);
    },
    stop,
  };
}
