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
    repeated(9, [ // attributes：每个 KeyValue 独立 tag
      keyValue("gen_ai.request.model", avString("gpt-4o")),
      keyValue("gen_ai.usage.input_tokens", avInt(42)),
      keyValue("custom", avKvList(keyValue("nested", avDouble(1.5)))),
      keyValue("enabled", avBool(true)),
      keyValue("ids", avArray(avInt(1), avString("two"))),
      keyValue("blob", avBytes(new Uint8Array([0xde, 0xad]))),
    ]),
    ld(13, concat(str(2, "boom"), vint(3, 2))), // status{message, code=ERROR}
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
