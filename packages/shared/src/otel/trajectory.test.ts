// 轨迹视图角色分类单测：覆盖 span.kind 六值 / operation 枚举 / 启发式 / 兜底。
// 数据形态与 loongsuite.test.ts / openinference.test.ts 保持一致（落库字段视角）。

import { describe, it, expect } from "vitest";
import { classifyTrajectoryKind, type TrajectoryKindInput } from "./trajectory.ts";

const base: TrajectoryKindInput = {
  type: "SPAN",
  metadata: null,
  model: null,
  agentName: null,
  workflowName: null,
  skillName: null,
  hasParent: true,
};

const inp = (patch: Partial<TrajectoryKindInput>): TrajectoryKindInput => ({
  ...base,
  ...patch,
});

describe("classifyTrajectoryKind", () => {
  it("EVENT → event", () => {
    expect(classifyTrajectoryKind(inp({ type: "EVENT" }))).toBe("event");
  });

  it("LoongSuite gen_ai.span.kind 六值", () => {
    const m = (kind: string) => inp({ metadata: { "gen_ai.span.kind": kind } });
    expect(classifyTrajectoryKind(m("ENTRY"))).toBe("entry");
    expect(classifyTrajectoryKind(m("AGENT"))).toBe("agent");
    expect(classifyTrajectoryKind(m("STEP"))).toBe("think");
    expect(classifyTrajectoryKind(m("TOOL"))).toBe("tool");
    expect(classifyTrajectoryKind(m("LLM"))).toBe("llm");
    expect(classifyTrajectoryKind(m("EMBEDDING"))).toBe("embedding");
  });

  it("gen_ai.operation.name 操作枚举", () => {
    const op = (name: string) => inp({ metadata: { "gen_ai.operation.name": name } });
    expect(classifyTrajectoryKind(op("entry"))).toBe("agent");
    expect(classifyTrajectoryKind(op("invoke_agent"))).toBe("agent");
    expect(classifyTrajectoryKind(op("react_step"))).toBe("think");
    expect(classifyTrajectoryKind(op("plan"))).toBe("think");
    expect(classifyTrajectoryKind(op("invoke_workflow"))).toBe("workflow");
    expect(classifyTrajectoryKind(op("retrieval"))).toBe("retrieval");
    expect(classifyTrajectoryKind(op("rerank"))).toBe("retrieval");
    expect(classifyTrajectoryKind(op("search_memory"))).toBe("memory");
    expect(classifyTrajectoryKind(op("invoke_skill"))).toBe("skill");
    expect(classifyTrajectoryKind(op("chat"))).toBe("llm");
    expect(classifyTrajectoryKind(op("embeddings"))).toBe("embedding");
  });

  it("专用列启发式：skill/workflow/agent/tool name/model 含 embed", () => {
    expect(classifyTrajectoryKind(inp({ skillName: "search_product" }))).toBe("skill");
    expect(classifyTrajectoryKind(inp({ workflowName: "w-1" }))).toBe("workflow");
    expect(classifyTrajectoryKind(inp({ agentName: "a-1" }))).toBe("agent");
    expect(
      classifyTrajectoryKind(inp({ metadata: { "gen_ai.tool.name": "web_search" } })),
    ).toBe("tool");
    expect(classifyTrajectoryKind(inp({ type: "SPAN", model: "text-embedding-v3" }))).toBe(
      "embedding",
    );
  });

  it("span.kind 优先于 operation 与启发式", () => {
    // TOOL span 挂 skill 属性：span.kind=TOOL 优先于 skillName
    expect(
      classifyTrajectoryKind(
        inp({
          metadata: { "gen_ai.span.kind": "TOOL", "gen_ai.tool.name": "exec" },
          skillName: "search_product",
        }),
      ),
    ).toBe("tool");
    // STEP 优先于 workflowName
    expect(
      classifyTrajectoryKind(inp({ metadata: { "gen_ai.span.kind": "STEP" }, workflowName: "w" })),
    ).toBe("think");
  });

  it("落库 type 为 span.kind 多值时直接映射（新数据，无需反推）", () => {
    expect(classifyTrajectoryKind(inp({ type: "ENTRY" }))).toBe("entry");
    expect(classifyTrajectoryKind(inp({ type: "AGENT" }))).toBe("agent");
    expect(classifyTrajectoryKind(inp({ type: "STEP" }))).toBe("think");
    expect(classifyTrajectoryKind(inp({ type: "LLM" }))).toBe("llm");
    expect(classifyTrajectoryKind(inp({ type: "TOOL" }))).toBe("tool");
    expect(classifyTrajectoryKind(inp({ type: "EMBEDDING" }))).toBe("embedding");
    expect(classifyTrajectoryKind(inp({ type: "CHAIN" }))).toBe("workflow");
    expect(classifyTrajectoryKind(inp({ type: "RETRIEVER" }))).toBe("retrieval");
    expect(classifyTrajectoryKind(inp({ type: "RERANKER" }))).toBe("retrieval");
  });

  it("新数据 type 优先于 metadata 反推（type=TOOL 与 metadata STEP 冲突时以落库 type 为准）", () => {
    expect(
      classifyTrajectoryKind(inp({ type: "TOOL", metadata: { "gen_ai.span.kind": "STEP" } })),
    ).toBe("tool");
  });

  it("兜底：无父 SPAN → entry；其余 → other", () => {
    expect(classifyTrajectoryKind(inp({ hasParent: false }))).toBe("entry");
    expect(classifyTrajectoryKind(inp({}))).toBe("other");
  });
});
