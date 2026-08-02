// LoongSuite GenAI SemConv 语义补齐测试（阿里云 loongsuite-otel-util-genai，见 design.md §6.8）：
// AGENT_OPERATIONS 扩展（entry / react_step / rerank / invoke_skill → SPAN）、
// gen_ai.skill.* 提取（skillName 专用列 + id/description/version 留 metadata）、
// trace 级提升（agentName/skillName/userId/sessionId 经 Baggage 传播）

import { describe, it, expect } from "vitest";
import { parseOtelPayload } from "./processor.ts";
import type { OtlpExportTraceServiceRequest } from "./types.ts";

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ intValue: String(v) });

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
      resource: { attributes: [{ key: "service.name", value: str("loong-svc") }] },
      scopeSpans: [{ scope: { name: "loongsuite" }, spans: spans as never }],
    },
  ],
});

describe("LoongSuite 语义", () => {
  it("operation entry / react_step / rerank / invoke_skill / create_skill → SPAN（chat 对照 GENERATION）", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-entry", "entry", [["gen_ai.operation.name", str("entry")]]),
      span("s-step", "step-1", [["gen_ai.operation.name", str("react_step")]]),
      span("s-rerank", "rerank", [["gen_ai.operation.name", str("rerank")]]),
      span("s-sk", "invoke-skill", [["gen_ai.operation.name", str("invoke_skill")]]),
      span("s-sk2", "create-skill", [["gen_ai.operation.name", str("create_skill")]]),
      span("s-llm", "llm", [["gen_ai.operation.name", str("chat")]]),
    ]));
    expect(observations.map((o) => o.type)).toEqual([
      "SPAN",
      "SPAN",
      "SPAN",
      "SPAN",
      "SPAN",
      "GENERATION",
    ]);
  });

  it("execute_tool + gen_ai.skill.*：skillName 提取，skill.id/description/version 留 metadata", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-tool", "read_file", [
        ["gen_ai.operation.name", str("execute_tool")],
        ["gen_ai.tool.name", str("read_file")],
        ["gen_ai.skill.name", str("news")],
        ["gen_ai.skill.id", str("workspace:default:news")],
        ["gen_ai.skill.description", str("Read and summarize recent news.")],
        ["gen_ai.skill.version", str("1.0")],
      ]),
    ]));
    const o = observations[0];
    expect(o.type).toBe("SPAN");
    expect(o.skillName).toBe("news");
    const meta = o.metadata as Record<string, unknown>;
    expect(meta["gen_ai.skill.id"]).toBe("workspace:default:news");
    expect(meta["gen_ai.skill.description"]).toBe("Read and summarize recent news.");
    expect(meta["gen_ai.skill.version"]).toBe("1.0");
    expect(meta["gen_ai.skill.name"]).toBeUndefined(); // 已提取为 skillName
  });

  it("trace 级提升：根 invoke_agent + 子 execute_tool(skill) → trace.agentName / skillName", () => {
    const { traces } = parseOtelPayload("project-1", payload([
      span("s-agent", "DemoAgent", [
        ["gen_ai.operation.name", str("invoke_agent")],
        ["gen_ai.agent.name", str("DemoAgent")],
      ], { trace: "t-loong", parent: "" }),
      span("s-step", "step-1", [
        ["gen_ai.operation.name", str("react_step")],
      ], { trace: "t-loong", parent: "s-agent" }),
      span("s-tool", "read_file", [
        ["gen_ai.operation.name", str("execute_tool")],
        ["gen_ai.skill.name", str("news")],
      ], { trace: "t-loong", parent: "s-step" }),
    ]));
    const t = traces[0];
    expect(t.agentName).toBe("DemoAgent");
    expect(t.skillName).toBe("news");
  });

  it("Baggage 传播：子 span 的 session.id / user.id / gen_ai.agent.name → trace 级提取", () => {
    const { traces } = parseOtelPayload("project-1", payload([
      span("s-entry", "entry", [
        ["gen_ai.operation.name", str("entry")],
        ["session.id", str("sess-ls")],
        ["user.id", str("user-ls")],
      ], { trace: "t-bag" }),
      span("s-llm", "llm", [
        ["gen_ai.operation.name", str("chat")],
        ["gen_ai.agent.name", str("DemoAgent")],
      ], { trace: "t-bag", parent: "s-entry" }),
    ]));
    const t = traces[0];
    expect(t.userId).toBe("user-ls");
    expect(t.sessionId).toBe("sess-ls");
    expect(t.agentName).toBe("DemoAgent");
  });

  it("gen_ai.span.kind：LLM/EMBEDDING→GENERATION，STEP/TOOL/AGENT/ENTRY→SPAN", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "chat", [["gen_ai.span.kind", str("LLM")]]),
      span("s-emb", "embed", [["gen_ai.span.kind", str("EMBEDDING")]]),
      span("s-step", "step", [["gen_ai.span.kind", str("STEP")]]),
      span("s-tool", "tool", [["gen_ai.span.kind", str("TOOL")]]),
      span("s-agent", "agent", [["gen_ai.span.kind", str("AGENT")]]),
      span("s-entry", "entry", [["gen_ai.span.kind", str("ENTRY")]]),
    ]));
    expect(observations.map((o) => o.type)).toEqual([
      "GENERATION",
      "GENERATION",
      "SPAN",
      "SPAN",
      "SPAN",
      "SPAN",
    ]);
  });

  it("entry span 的 gen_ai.user.id / gen_ai.session.id → trace 级 userId / sessionId", () => {
    const { traces } = parseOtelPayload("project-1", payload([
      span("s-entry", "entry", [
        ["gen_ai.span.kind", str("ENTRY")],
        ["gen_ai.user.id", str("user-ls")],
        ["gen_ai.session.id", str("sess-ls")],
      ], { trace: "t-user" }),
    ]));
    const t = traces[0];
    expect(t.userId).toBe("user-ls");
    expect(t.sessionId).toBe("sess-ls");
  });

  it("gen_ai.skill.name / gen_ai.agent.name / gen_ai.usage.* 不残留 metadata", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "llm", [
        ["gen_ai.operation.name", str("chat")],
        ["gen_ai.agent.name", str("DemoAgent")],
        ["gen_ai.skill.name", str("news")],
        ["gen_ai.usage.input_tokens", int(10)],
        ["gen_ai.usage.output_tokens", int(5)],
        ["custom.key", str("keep-me")],
      ]),
    ]));
    const o = observations[0];
    expect(o.agentName).toBe("DemoAgent");
    expect(o.skillName).toBe("news");
    expect(o.inputTokens).toBe(10);
    expect(o.outputTokens).toBe(5);
    const meta = o.metadata as Record<string, unknown>;
    expect(meta["gen_ai.skill.name"]).toBeUndefined();
    expect(meta["gen_ai.agent.name"]).toBeUndefined();
    expect(meta["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(meta["custom.key"]).toBe("keep-me");
  });
});
