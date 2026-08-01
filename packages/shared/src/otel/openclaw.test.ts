// OpenClaw 真实 OTel trace fixture 的映射测试
//
// fixture 来源：2026-08-01 捕获的一次真实 agent 复杂任务
// （deepseek-v4-flash，含 exec / skill / MCP 工具调用）。
// - raw/openclaw-{1,2}.bin：OpenClaw diagnostics-otel 导出时捕获的原始
//   OTLP protobuf 请求体（同一 trace 分两批导出，各为独立的
//   ExportTraceServiceRequest 消息）
// - openclaw-{1,2}.json：对应批次经 decodeOtlpProtobuf 解码后的 JSON
// - openclaw-full.json：两批按 protobuf 消息拼接规则合并后的完整结构
//   （兼作其他测试的 mock 数据源）
//
// 断言覆盖：protobuf / JSON 双通道一致性、trace/observation 层级、
// openclaw.model.call → GENERATION（模型 + token usage）、
// exec / tool.execution → SPAN（metadata 保留 openclaw.* 与 resource）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeOtlpProtobuf } from "./protobuf.ts";
import { parseOtelPayload } from "./processor.ts";
import type { OtlpExportTraceServiceRequest } from "./types.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const loadJson = (name: string): OtlpExportTraceServiceRequest =>
  JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
const loadBin = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`raw/${name}`, FIXTURES)));

// 两批消息按 protobuf 重复字段拼接规则合并（field 1 resource_spans 多次出现）
const mergedBin = (): Uint8Array =>
  new Uint8Array([...loadBin("openclaw-1.bin"), ...loadBin("openclaw-2.bin")]);

const parseFixture = () =>
  parseOtelPayload("project-1", loadJson("openclaw-full.json"));

describe("OpenClaw 真实 trace fixture（2026-08-01 捕获，deepseek-v4-flash）", () => {
  it("protobuf 通道解码结果与 JSON fixture 一致（每批 + 拼接合并）", () => {
    expect(decodeOtlpProtobuf(loadBin("openclaw-1.bin"))).toEqual(
      loadJson("openclaw-1.json"),
    );
    expect(decodeOtlpProtobuf(loadBin("openclaw-2.bin"))).toEqual(
      loadJson("openclaw-2.json"),
    );
    expect(decodeOtlpProtobuf(mergedBin())).toEqual(
      loadJson("openclaw-full.json"),
    );
  });

  it("protobuf 通道与 JSON 通道经 parseOtelPayload 解析结果一致", () => {
    const viaJson = parseOtelPayload(
      "project-1",
      loadJson("openclaw-full.json"),
    );
    const viaProto = parseOtelPayload("project-1", decodeOtlpProtobuf(mergedBin()));
    expect(viaProto).toEqual(viaJson);
  });

  it("合并 fixture 产生 3 条 trace / 10 observations，主 trace 根为 harness.run", () => {
    const { traces, observations } = parseFixture();
    expect(traces).toHaveLength(3);
    expect(observations).toHaveLength(10);

    const main = traces.find((t) => t.id === "b460363f68582dc19193ee9b881f20e3")!;
    expect(main).toMatchObject({
      id: "b460363f68582dc19193ee9b881f20e3",
      projectId: "project-1",
      name: "openclaw.harness.run",
      environment: "default",
      userId: null,
      sessionId: null,
    });
    expect(main.timestamp.toISOString()).toBe("2026-08-01T14:33:42.487Z");

    // 层级：harness.run(97671caf) <- run(c70e85bd) <- model.call / context.assembled
    //       harness.run <- exec；run <- tool.execution
    const byId = new Map(observations.map((o) => [o.id, o]));
    expect(byId.get("97671caf3cfd408c")).toMatchObject({
      type: "SPAN",
      name: "openclaw.harness.run",
      parentObservationId: null,
    });
    expect(byId.get("c70e85bdbe53b3e2")).toMatchObject({
      type: "SPAN",
      name: "openclaw.run",
      parentObservationId: "97671caf3cfd408c",
    });
    expect(byId.get("1915bab94bdc587c")!.parentObservationId).toBe(
      "c70e85bdbe53b3e2",
    );
    expect(byId.get("d686e90191de315e")!.parentObservationId).toBe(
      "c70e85bdbe53b3e2",
    );
    expect(byId.get("297d36c46cbd46e4")!.parentObservationId).toBe(
      "97671caf3cfd408c",
    );
    expect(byId.get("e38161167cfe5a7c")!.parentObservationId).toBe(
      "c70e85bdbe53b3e2",
    );
  });

  it("openclaw.model.call 映射为 GENERATION，带模型与 token usage", () => {
    const { observations } = parseFixture();
    const mc = observations.find((o) => o.id === "1915bab94bdc587c")!;
    expect(mc).toMatchObject({
      type: "GENERATION",
      name: "openclaw.model.call",
      model: "deepseek-v4-flash",
      level: "DEFAULT",
      inputTokens: 24736,
      outputTokens: 111,
      totalTokens: 24847,
    });
    // gen_ai.usage.input/output_tokens 已提取为专用字段，不进 metadata；
    // 其余 openclaw.model_call.* 与 cache_read 保留
    expect(mc.metadata).toMatchObject({
      "openclaw.provider": "deepseek",
      "openclaw.model": "deepseek-v4-flash",
      "openclaw.model_call.usage.input_tokens": 160,
      "gen_ai.usage.cache_read.input_tokens": 24576,
      resource: { "service.name": "openclaw" },
    });
    expect(mc.metadata).not.toHaveProperty("gen_ai.usage.input_tokens");
    expect(mc.metadata).not.toHaveProperty("gen_ai.request.model");
  });

  it("exec 与 tool.execution 映射为 SPAN，metadata 保留 openclaw.* 与 resource", () => {
    const { observations } = parseFixture();
    const byId = new Map(observations.map((o) => [o.id, o]));

    const exec = byId.get("297d36c46cbd46e4")!;
    expect(exec).toMatchObject({
      type: "SPAN",
      name: "openclaw.exec",
      model: null,
    });
    expect(exec.metadata).toMatchObject({
      "openclaw.exec.target": "host",
      "openclaw.exec.mode": "child",
      "openclaw.exec.exit_code": 0,
      "openclaw.outcome": "completed",
      resource: { "process.executable.name": "openclaw-gateway" },
    });

    const toolExec = byId.get("e38161167cfe5a7c")!;
    // gen_ai.tool.name 被提取为 observation.name（TOOL 语义落在 SPAN）
    expect(toolExec).toMatchObject({
      type: "SPAN",
      name: "exec",
    });
    expect(toolExec.metadata).toMatchObject({
      "openclaw.toolName": "exec",
      "openclaw.tool.source": "core",
    });
    expect(toolExec.metadata).not.toHaveProperty("gen_ai.tool.name");
    expect(toolExec.metadata).not.toHaveProperty("gen_ai.tool.call.id");
    expect(toolExec.metadata).not.toHaveProperty("gen_ai.operation.name");
  });

  it("liveness.warning 与 model.usage 作为独立 trace 正确映射", () => {
    const { traces, observations } = parseFixture();
    expect(traces.map((t) => t.id).sort()).toEqual([
      "56227a41d949e1afa4867c57893139e9",
      "651acd99b43d36eabc84b8db0b0e3207",
      "b460363f68582dc19193ee9b881f20e3",
    ]);

    const liveness = observations.find(
      (o) => o.name === "openclaw.liveness.warning",
    )!;
    expect(liveness).toMatchObject({
      type: "SPAN",
      parentObservationId: null,
    });
    expect(liveness.metadata).toMatchObject({
      "openclaw.liveness.reason": "event_loop_delay",
    });

    // model.usage 含 gen_ai.request.model + gen_ai.usage.* → GENERATION
    const usage = observations.find((o) => o.name === "openclaw.model.usage")!;
    expect(usage).toMatchObject({
      type: "GENERATION",
      model: "deepseek-v4-flash",
      inputTokens: 73804,
      outputTokens: 314,
      totalTokens: 74118,
    });
    expect(usage.metadata).toMatchObject({
      "openclaw.agent": "main",
      "openclaw.tokens.total": 24847,
    });
  });
});
