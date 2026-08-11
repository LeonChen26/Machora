// OpenInference 语义补齐测试：span.kind 显式枚举（LLM/EMBEDDING→GENERATION，
// CHAIN/AGENT/TOOL/RETRIEVER→SPAN）、input/output.value 解码、token_count/cost 提取、
// trace 级 user/session/tags/agent 提取、metadata 噪声键剔除

import { describe, it, expect } from "vitest";
import { parseOtelPayload } from "./processor.ts";
import type { OtlpExportTraceServiceRequest } from "./types.ts";

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ intValue: String(v) });
const arr = (vs: string[]) => ({
  arrayValue: { values: vs.map((v) => ({ stringValue: v })) },
});

function span(
  spanId: string,
  name: string,
  attrs: Array<[string, Record<string, unknown>]>,
  opts: { parent?: string; trace?: string } = {},
): Record<string, unknown> {
  return {
    traceId: opts.trace ?? "trace-1",
    spanId,
    parentSpanId: opts.parent ?? "",
    name,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: attrs.map(([key, value]) => ({ key, value })),
    status: { code: 0 },
  };
}

const payload = (spans: Record<string, unknown>[]): OtlpExportTraceServiceRequest => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: str("llama-svc") }] },
      scopeSpans: [{ scope: { name: "openinference" }, spans: spans as never }],
    },
  ],
});

describe("OpenInference 语义", () => {
  it("span.kind 直接落库为 type：LLM/EMBEDDING/CHAIN/AGENT/TOOL/RETRIEVER", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "llm-call", [["openinference.span.kind", str("LLM")]]),
      span("s-emb", "embed", [["openinference.span.kind", str("EMBEDDING")]]),
      span("s-chain", "chain", [["openinference.span.kind", str("CHAIN")]]),
      span("s-agent", "agent", [["openinference.span.kind", str("AGENT")]]),
      span("s-tool", "tool", [["openinference.span.kind", str("TOOL")]]),
      span("s-ret", "retriever", [["openinference.span.kind", str("RETRIEVER")]]),
    ]));
    expect(observations.map((o) => o.type)).toEqual([
      "LLM",
      "EMBEDDING",
      "CHAIN",
      "AGENT",
      "TOOL",
      "RETRIEVER",
    ]);
  });

  it("input.value / output.value 按 mime_type=json 解码为对象", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "llm", [
        ["openinference.span.kind", str("LLM")],
        ["input.mime_type", str("application/json")],
        ["input.value", str('{"role":"user","content":"hi"}')],
        ["output.value", str('{"role":"assistant","content":"hello"}')],
      ]),
    ]));
    const o = observations[0];
    expect(o.input).toEqual({ role: "user", content: "hi" });
    expect(o.output).toEqual({ role: "assistant", content: "hello" });
  });

  it("llm.token_count / llm.model_name / llm.cost.total 提取", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "llm", [
        ["openinference.span.kind", str("LLM")],
        ["llm.model_name", str("gpt-4o")],
        ["llm.token_count.prompt", int(10)],
        ["llm.token_count.completion", int(20)],
        ["llm.token_count.total", int(30)],
        ["llm.cost.total", { doubleValue: 0.0012 }],
      ]),
    ]));
    const o = observations[0];
    expect(o.model).toBe("gpt-4o");
    expect(o.inputTokens).toBe(10);
    expect(o.outputTokens).toBe(20);
    expect(o.totalTokens).toBe(30);
    expect(o.totalCost).toBeCloseTo(0.0012);
  });

  it("trace 级：openinference user.id / session.id / tag.tags / agent.name 提取", () => {
    const { traces } = parseOtelPayload("project-1", payload([
      span("s-agent", "agent", [
        ["openinference.span.kind", str("AGENT")],
        ["user.id", str("user-9")],
        ["session.id", str("sess-9")],
        ["tag.tags", arr(["demo", "llama"])],
        ["agent.name", str("my-agent")],
        ["metadata", str('{"env":"prod"}')],
      ], { trace: "t9" }),
    ]));
    const t = traces[0];
    expect(t.userId).toBe("user-9");
    expect(t.sessionId).toBe("sess-9");
    expect(t.tags).toEqual(["demo", "llama"]);
    expect(t.agentName).toBe("my-agent");
    expect(t.metadata).toEqual({ env: "prod" });
  });

  it("openinference.* / llm.* / input.* 键不残留 metadata，自定义键保留", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "llm", [
        ["openinference.span.kind", str("LLM")],
        ["input.value", str("x")],
        ["llm.token_count.prompt", int(1)],
        ["custom.key", str("kept")],
      ]),
    ]));
    const meta = observations[0].metadata as Record<string, unknown>;
    expect(meta["openinference.span.kind"]).toBeUndefined();
    expect(meta["input.value"]).toBeUndefined();
    expect(meta["llm.token_count.prompt"]).toBeUndefined();
    expect(meta["custom.key"]).toBe("kept");
  });
});
