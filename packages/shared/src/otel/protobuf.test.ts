import { describe, it, expect } from "vitest";
import { decodeOtlpProtobuf } from "./protobuf.ts";
import { parseOtelPayload } from "./processor.ts";

// ---------------------------------------------------------------------------
// 手工 wire-format 编码器：按官方 protobuf 规范（varint / fixed64 / double /
// length-delimited）逐字节构造二进制，用于验证内嵌 schema 与官方一致
// ---------------------------------------------------------------------------

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 128) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function key(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function ld(field: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([...key(field, 2), ...varint(payload.length), ...payload]);
}

function str(field: number, s: string): Uint8Array {
  return ld(field, new TextEncoder().encode(s));
}

function vint(field: number, value: number): Uint8Array {
  return Uint8Array.from([...key(field, 0), ...varint(value)]);
}

function fixed64(field: number, value: bigint): Uint8Array {
  const out = new Uint8Array(9);
  out[0] = (field << 3) | 1;
  let v = value;
  for (let i = 1; i <= 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function double(field: number, value: number): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Uint8Array.from([(field << 3) | 1, ...buf]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// AnyValue 单值编码（字段号见 opentelemetry.proto.common.v1.AnyValue）
const avString = (s: string) => str(1, s);
const avBool = (b: boolean) => vint(2, b ? 1 : 0);
const avInt = (n: number) => vint(3, n);
const avDouble = (n: number) => double(4, n);
const avBytes = (b: Uint8Array) => ld(5, b);
const avArray = (...vals: Uint8Array[]) => ld(6, concat(...vals.map((v) => ld(1, v))));
const avKvList = (...kvs: Uint8Array[]) => ld(7, concat(...kvs.map((kv) => ld(1, kv))));

// KeyValue{ key=1, value=2 }
const keyValue = (k: string, valueMsg: Uint8Array) =>
  concat(str(1, k), ld(2, valueMsg));

// repeated 消息字段：每个元素必须是独立的一条 tag+length（不能合并进一个 payload）
const repeated = (field: number, msgs: Uint8Array[]) =>
  concat(...msgs.map((m) => ld(field, m)));

// 构造一条含 resource / scope / span（含各类 AnyValue）的 ExportTraceServiceRequest
function buildFixture(): Uint8Array {
  const traceId = Uint8Array.from({ length: 16 }, (_, i) => i + 1); // 01..10
  const spanId = Uint8Array.from({ length: 8 }, (_, i) => 0x11 + i); // 11..18

  const span = concat(
    ld(1, traceId), // trace_id
    ld(2, spanId), // span_id
    str(5, "root"), // name
    vint(6, 2), // kind = SPAN_KIND_SERVER
    fixed64(7, 1_000_000_000_000n), // start_time_unix_nano
    fixed64(8, 2_000_000_000_000n), // end_time_unix_nano
    // 注意：Machora 旧实现 / 老 OpenClaw fixture 用错写的字段号 attributes=9
    // 新 OTel 官方 SDK 是 attributes=10；protobuf schema 里同时声明了
    // attributes=9 和 otel_attributes=10，两套都会解到 JS 侧 attributes。
    repeated(9, [
      keyValue("gen_ai.request.model", avString("gpt-4o")),
      keyValue("gen_ai.usage.input_tokens", avInt(42)),
      keyValue("custom", avKvList(keyValue("nested", avDouble(1.5)))),
      keyValue("enabled", avBool(true)),
      keyValue("ids", avArray(avInt(1), avString("two"))),
      keyValue("blob", avBytes(new Uint8Array([0xde, 0xad]))),
    ]),
    ld(13, concat(str(2, "boom"), vint(3, 2))), // 旧 schema status=13；新 schema otel_status=14
  );

  const scopeSpans = concat(
    ld(1, str(1, "test-scope")), // scope: InstrumentationScope{name}
    ld(2, span),
  );

  const resourceSpans = concat(
    ld(1, ld(1, keyValue("service.name", avString("test-svc")))), // resource{attributes}
    ld(2, scopeSpans),
  );

  return ld(1, resourceSpans); // ExportTraceServiceRequest.resource_spans
}

describe("decodeOtlpProtobuf", () => {
  it("解码手写二进制（对齐官方 wire 规范）为 OTLP JSON 结构", () => {
    const decoded = decodeOtlpProtobuf(buildFixture());

    expect(decoded).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "test-svc" } }],
          },
          scopeSpans: [
            {
              scope: { name: "test-scope" },
              spans: [
                {
                  traceId: "0102030405060708090a0b0c0d0e0f10",
                  spanId: "1112131415161718",
                  name: "root",
                  kind: 2,
                  startTimeUnixNano: "1000000000000",
                  endTimeUnixNano: "2000000000000",
                  attributes: [
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } },
                    {
                      key: "custom",
                      value: {
                        kvlistValue: {
                          values: [{ key: "nested", value: { doubleValue: 1.5 } }],
                        },
                      },
                    },
                    { key: "enabled", value: { boolValue: true } },
                    {
                      key: "ids",
                      value: {
                        arrayValue: {
                          values: [{ intValue: "1" }, { stringValue: "two" }],
                        },
                      },
                    },
                    { key: "blob", value: { bytesValue: "3q0=" } },
                  ],
                  status: { message: "boom", code: 2 },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("空 payload 返回空结构", () => {
    expect(decodeOtlpProtobuf(new Uint8Array())).toEqual({});
  });

  it("畸形输入抛错（截断的 length-delimited）", () => {
    expect(() => decodeOtlpProtobuf(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow();
  });

  it("string 字段含非法 UTF-8 字节不崩溃，替换成 U+FFFD", () => {
    const traceId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const spanId = Uint8Array.from({ length: 8 }, (_, i) => 0x11 + i);

    // "he" + 非法 UTF-8 字节 [0xff, 0xfe] + "llo"
    const badNameRaw = new Uint8Array([0x68, 0x65, 0xff, 0xfe, 0x6c, 0x6c, 0x6f]);
    // Span.name = field 5, wire type 2 (length-delimited)
    const nameBytes = ld(5, badNameRaw);

    // AnyValue.stringValue=1 → KeyValue{ key=1, value=2 }
    const badStringRaw = new Uint8Array([0xc3, 0x28]); // 无效两字节序列
    const badAttr = keyValue("weird.data", ld(1, badStringRaw)); // =avString，但传 raw bytes 包装

    const span = concat(
      ld(1, traceId),
      ld(2, spanId),
      nameBytes,
      vint(6, 1),
      fixed64(7, 1_000_000_000_000n),
      fixed64(8, 2_000_000_000_000n),
      repeated(9, [badAttr]), // 旧 attributes=9
    );
    const scopeSpans = concat(ld(1, str(1, "scope-x")), ld(2, span));
    const resourceSpans = concat(
      ld(1, ld(1, keyValue("service.name", avString("test-svc")))),
      ld(2, scopeSpans),
    );
    const payload = ld(1, resourceSpans);

    const decoded = decodeOtlpProtobuf(payload);
    const span0 = decoded.resourceSpans![0].scopeSpans![0].spans![0];

    // 不崩溃 + 非法字节被替换成至少一个 replacement char
    expect(span0.name).toContain("he");
    expect(span0.name).toContain("llo");
    expect(span0.name).toContain("\ufffd");
    expect(span0.attributes!.some((a) => a.key === "weird.data")).toBeTruthy();
    const weird = span0.attributes!.find((a) => a.key === "weird.data")!;
    expect((weird.value?.stringValue as string).includes("\ufffd")).toBeTruthy();
  });
});

describe("protobuf → parseOtelPayload 集成", () => {
  it("解码结果与 JSON 通道一致地映射为 trace / observation", () => {
    const decoded = decodeOtlpProtobuf(buildFixture());
    const { traces, observations } = parseOtelPayload("project-1", decoded);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      id: "0102030405060708090a0b0c0d0e0f10",
      projectId: "project-1",
      name: "root",
      environment: "default",
      timestamp: new Date("1970-01-01T00:16:40.000Z"),
    });

    expect(observations).toHaveLength(1);
    const o = observations[0];
    expect(o).toMatchObject({
      id: "1112131415161718",
      traceId: "0102030405060708090a0b0c0d0e0f10",
      projectId: "project-1",
      type: "GENERATION", // 含模型信息 → GENERATION
      name: "root",
      model: "gpt-4o",
      level: "ERROR", // status.code=2 → ERROR
      inputTokens: 42,
      outputTokens: null,
      totalTokens: 42,
    });
    expect(o.startTime).toEqual(new Date("1970-01-01T00:16:40.000Z"));
    expect(o.endTime).toEqual(new Date("1970-01-01T00:33:20.000Z"));

    // 未被提取/去噪的属性进入 metadata，resource 属性挂到 resource 下
    expect(o.metadata).toMatchObject({
      custom: { nested: 1.5 },
      enabled: true,
      ids: [1, "two"],
      blob: "3q0=",
      resource: { "service.name": "test-svc" },
    });
  });
});

// ---------------------------------------------------------------------------
// span events → EVENT observation（流式输出 / 异常记录）
// ---------------------------------------------------------------------------

function buildEventSpanFixture(): Uint8Array {
  const traceId = Uint8Array.from({ length: 16 }, (_, i) => i + 1); // 01..10
  const spanId = Uint8Array.from({ length: 8 }, (_, i) => 0x11 + i); // 11..18

  const span = concat(
    ld(1, traceId),
    ld(2, spanId),
    str(5, "gen-span"),
    vint(6, 1), // SPAN_KIND_INTERNAL
    fixed64(7, 1_000_000_000_000n),
    fixed64(8, 2_000_000_000_000n),
    repeated(9, [keyValue("gen_ai.request.model", avString("gpt-4o"))]), // 旧 attributes=9
    repeated(11, [
      // 旧 events=11；新规范 events=12
      concat(
        fixed64(1, 1_100_000_000n),
        str(2, "gen_ai.choice"),
        repeated(3, [
          keyValue("index", avInt(0)),
          keyValue("delta", avString("hel")),
        ]),
      ),
      concat(
        fixed64(1, 1_200_000_000n),
        str(2, "exception"),
        repeated(3, [keyValue("message", avString("boom"))]),
      ),
    ]),
  );

  const scopeSpans = concat(ld(1, str(1, "test-scope")), ld(2, span));
  const resourceSpans = concat(
    ld(1, ld(1, keyValue("service.name", avString("test-svc")))),
    ld(2, scopeSpans),
  );
  return ld(1, resourceSpans);
}

describe("span events → EVENT observation", () => {
  it("每个 event 生成一个挂在父 span 下的 EVENT observation", () => {
    const decoded = decodeOtlpProtobuf(buildEventSpanFixture());
    const { traces, observations } = parseOtelPayload("project-1", decoded);

    expect(traces).toHaveLength(1);
    expect(observations).toHaveLength(3); // 1 SPAN + 2 EVENT

    const span = observations.find((o) => o.id === "1112131415161718")!;
    expect(span).toMatchObject({
      type: "GENERATION",
      parentObservationId: null,
    });

    const choice = observations.find((o) => o.name === "gen_ai.choice")!;
    expect(choice).toMatchObject({
      id: "1112131415161718:e0",
      traceId: "0102030405060708090a0b0c0d0e0f10",
      projectId: "project-1",
      type: "EVENT",
      name: "gen_ai.choice",
      parentObservationId: "1112131415161718",
      level: "DEFAULT",
      model: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(choice.startTime).toEqual(new Date("1970-01-01T00:00:01.100Z"));
    expect(choice.endTime).toEqual(choice.startTime);
    expect(choice.metadata).toEqual({ index: 0, delta: "hel" });

    // exception 事件 → ERROR 级别
    const exc = observations.find((o) => o.name === "exception")!;
    expect(exc).toMatchObject({
      id: "1112131415161718:e1",
      type: "EVENT",
      level: "ERROR",
      parentObservationId: "1112131415161718",
    });
    expect(exc.metadata).toEqual({ message: "boom" });
  });
});
