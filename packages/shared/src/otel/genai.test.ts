// OTel GenAI 语义补齐测试：agent/workflow/plan/memory 显式枚举、
// gen_ai.agent.name / gen_ai.workflow.name 提取为专用列、error.type → level=ERROR

import { describe, it, expect } from "vitest";
import { parseOtelPayload } from "./processor.ts";
import type { OtlpExportTraceServiceRequest } from "./types.ts";

const str = (v: string) => ({ stringValue: v });

function span(
  spanId: string,
  name: string,
  attrs: Record<string, string>,
  opts: { parent?: string; trace?: string; status?: number } = {},
): Record<string, unknown> {
  return {
    traceId: opts.trace ?? "trace-1",
    spanId,
    parentSpanId: opts.parent ?? "",
    name,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: str(value),
    })),
    status: opts.status ? { code: opts.status } : { code: 0 },
  };
}

const payload = (spans: Record<string, unknown>[]): OtlpExportTraceServiceRequest => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: str("test-svc") }] },
      scopeSpans: [{ scope: { name: "test" }, spans: spans as never }],
    },
  ],
});

describe("OTel GenAI 语义补齐", () => {
  it("gen_ai.agent.name / workflow.name 提取到 observation 专用列，且不残留 metadata", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-agent", "agent-run", {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "my-agent",
        "gen_ai.workflow.name": "wf-1",
        "custom.key": "kept",
      }),
    ]));

    const obs = observations[0];
    expect(obs.type).toBe("AGENT"); // operation=invoke_agent → span.kind=AGENT 直接落库
    expect(obs.agentName).toBe("my-agent");
    expect(obs.workflowName).toBe("wf-1");
    // 已提取专用列，不再进 metadata
    const meta = obs.metadata as Record<string, unknown>;
    expect(meta["gen_ai.agent.name"]).toBeUndefined();
    expect(meta["gen_ai.workflow.name"]).toBeUndefined();
    expect(meta["custom.key"]).toBe("kept");
  });

  it("trace 级提升 agentName / workflowName（取根 span 或整组首个非空）", () => {
    const { traces } = parseOtelPayload("project-1", payload([
      span("s-root", "root", {}, { parent: undefined as never, trace: "t2" }),
      span("s-agent", "agent-run", {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "my-agent",
      }, { parent: "s-root", trace: "t2" }),
    ]));

    expect(traces[0].agentName).toBe("my-agent");
    expect(traces[0].workflowName).toBeNull();
  });

  it("agent/workflow/plan/memory operation → span.kind 直接落库（memory → SPAN 通用节点）", () => {
    const cases: Array<[string, string]> = [
      ["invoke_agent", "agent-run"],
      ["invoke_workflow", "wf-run"],
      ["plan", "plan-step"],
      ["search_memory", "mem-search"],
      ["create_memory", "mem-create"],
    ];
    const { observations } = parseOtelPayload("project-1", payload(
      cases.map(([op, name]) =>
        span(name, name, { "gen_ai.operation.name": op, "gen_ai.agent.name": op }),
      ),
    ));
    expect(observations.map((o) => o.type)).toEqual([
      "AGENT",
      "CHAIN",
      "STEP",
      "SPAN",
      "SPAN",
    ]);
  });

  it("chat → LLM", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-llm", "chat", { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o" }),
    ]));
    expect(observations[0].type).toBe("LLM");
  });

  it("error.type 存在（无显式 level / status unset）→ level=ERROR", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-err", "tool", { "error.type": "RuntimeError" }),
    ]));
    expect(observations[0].level).toBe("ERROR");
  });

  it("显式 langfuse.observation.level 优先于 error.type；status=2 仍 ERROR", () => {
    const { observations } = parseOtelPayload("project-1", payload([
      span("s-ok", "a", { "langfuse.observation.level": "DEFAULT", "error.type": "X" }),
      span("s-st", "b", {}, { status: 2 }),
    ]));
    expect(observations[0].level).toBe("DEFAULT");
    expect(observations[1].level).toBe("ERROR");
  });
});
