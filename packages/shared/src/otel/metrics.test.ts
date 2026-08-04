import { describe, it, expect } from "vitest";
import { parseOtelMetricsPayload, type MetricSampleInput } from "./metrics.ts";
import { decodeOtlpMetricsProtobuf } from "./protobuf.ts";
import type { OtlpExportMetricsServiceRequest } from "./types.ts";

// ---------------------------------------------------------------------------
// JSON 通道：ExportMetricsServiceRequest JSON 形态 → MetricSampleInput[]
// ---------------------------------------------------------------------------

function jsonRequest(): OtlpExportMetricsServiceRequest {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "test-svc" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "test-scope" },
            metrics: [
              {
                name: "process.cpu.time",
                unit: "s",
                sum: {
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [{ key: "mode", value: { stringValue: "user" } }],
                      timeUnixNano: "1000000000000",
                      asDouble: 12.5,
                    },
                  ],
                },
              },
              {
                name: "http.server.request.duration",
                unit: "ms",
                histogram: {
                  dataPoints: [
                    {
                      timeUnixNano: "2000000000000",
                      count: "42",
                      sum: 6300,
                      min: 50,
                      max: 500,
                      explicitBounds: [100, 250, 500],
                      bucketCounts: ["10", "15", "12", "5"],
                    },
                  ],
                },
              },
              {
                name: "db.query.latency",
                unit: "us",
                summary: {
                  dataPoints: [
                    {
                      timeUnixNano: "3000000000000",
                      count: "7",
                      sum: 700,
                    },
                  ],
                },
              },
              {
                name: "free.memory",
                unit: "By",
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: "4000000000000",
                      asInt: "1024",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("parseOtelMetricsPayload（JSON 通道）", () => {
  const samples = parseOtelMetricsPayload(jsonRequest(), "project-1");

  it("映射 gauge / sum / histogram / summary 四种类型", () => {
    expect(samples).toHaveLength(4);
    expect(samples.map((s) => s.kind)).toEqual(["SUM", "HISTOGRAM", "HISTOGRAM", "GAUGE"]);
    expect(samples.map((s) => s.name)).toEqual([
      "process.cpu.time",
      "http.server.request.duration",
      "db.query.latency",
      "free.memory",
    ]);
  });

  it("SUM：value 取 asDouble，attributes 解码为扁平对象", () => {
    const s = samples[0]!;
    expect(s).toMatchObject({
      projectId: "project-1",
      unit: "s",
      value: 12.5,
      count: null,
      attributes: { mode: "user" },
    });
    expect(s.timestamp).toEqual(new Date("1970-01-01T00:16:40.000Z"));
  });

  it("HISTOGRAM：count/sum/min/max + buckets 宽表", () => {
    const s = samples[1]!;
    expect(s).toMatchObject({
      unit: "ms",
      value: null,
      count: 42,
      sum: 6300,
      min: 50,
      max: 500,
      buckets: [
        { boundary: 100, count: 10 },
        { boundary: 250, count: 15 },
        { boundary: 500, count: 12 },
      ],
    });
  });

  it("SUMMARY 落为 HISTOGRAM（保留 count/sum，无 buckets）", () => {
    const s = samples[2]!;
    expect(s).toMatchObject({
      kind: "HISTOGRAM",
      count: 7,
      sum: 700,
      min: null,
      max: null,
      buckets: null,
    });
  });

  it("GAUGE：asInt 字符串转数字", () => {
    const s = samples[3]!;
    expect(s).toMatchObject({ kind: "GAUGE", value: 1024 });
  });

  it("空请求返回空数组", () => {
    expect(parseOtelMetricsPayload({}, "project-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// protobuf 通道：手写 wire-format → decodeOtlpMetricsProtobuf
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

const avString = (s: string) => str(1, s);
const keyValue = (k: string, valueMsg: Uint8Array) =>
  concat(str(1, k), ld(2, valueMsg));
const repeated = (field: number, msgs: Uint8Array[]) =>
  concat(...msgs.map((m) => ld(field, m)));

// ExportMetricsServiceRequest{ resource_metrics=1 }
function buildMetricsFixture(): Uint8Array {
  // Gauge{ data_points=1 } 内的 NumberDataPoint{ time=3, as_double=4, attributes=7 }
  const gaugePoint = concat(
    fixed64(3, 4_000_000_000_000n),
    double(4, 2048),
    repeated(7, [keyValue("mode", avString("idle"))]),
  );

  // Sum{ data_points=1 } 内的 NumberDataPoint{ time=3, as_double=4 }
  const sumPoint = concat(
    fixed64(3, 1_000_000_000_000n),
    double(4, 12.5),
  );

  // Histogram{ data_points=1 } 内的 HistogramDataPoint{
  //   time=3, count=4(fixed64), sum=5(double), bucket_counts=6(fixed64),
  //   explicit_bounds=7(double), min=11(double), max=12(double) }
  const histPoint = concat(
    fixed64(3, 2_000_000_000_000n),
    fixed64(4, 42n),
    double(5, 6300),
    fixed64(6, 10n),
    fixed64(6, 15n),
    fixed64(6, 12n),
    fixed64(6, 5n),
    double(7, 100),
    double(7, 250),
    double(7, 500),
    double(11, 50),
    double(12, 500),
  );

  const scopeMetrics = concat(
    ld(1, str(1, "test-scope")), // scope{name}
    // repeated Metric：每个元素独立 tag+length（不能合并进一个 payload）
    repeated(2, [
      // Metric{ name=1, unit=3, sum=7 }
      concat(
        str(1, "process.cpu.time"),
        str(3, "s"),
        ld(7, concat(ld(1, sumPoint))),
      ),
      // Metric{ name=1, unit=3, histogram=9 }
      concat(
        str(1, "http.server.request.duration"),
        str(3, "ms"),
        ld(9, concat(ld(1, histPoint))),
      ),
      // Metric{ name=1, gauge=5 }
      concat(str(1, "free.memory"), ld(5, concat(ld(1, gaugePoint)))),
    ]),
  );

  const resourceMetrics = concat(
    ld(1, ld(1, keyValue("service.name", avString("test-svc")))),
    ld(2, scopeMetrics),
  );

  return ld(1, resourceMetrics);
}

describe("decodeOtlpMetricsProtobuf（protobuf 通道）", () => {
  it("解码手写二进制为 OTLP JSON 结构", () => {
    const decoded = decodeOtlpMetricsProtobuf(buildMetricsFixture());
    expect(decoded.resourceMetrics).toHaveLength(1);
    const sm = decoded.resourceMetrics![0]!.scopeMetrics![0]!;
    expect(sm.metrics).toHaveLength(3);
    expect(sm.metrics!.map((m) => m.name)).toEqual([
      "process.cpu.time",
      "http.server.request.duration",
      "free.memory",
    ]);
  });

  it("解码 → 解析产物与 JSON 通道一致", () => {
    const decoded = decodeOtlpMetricsProtobuf(buildMetricsFixture());
    const samples: MetricSampleInput[] = parseOtelMetricsPayload(decoded, "project-1");

    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.kind)).toEqual(["SUM", "HISTOGRAM", "GAUGE"]);
    expect(samples.map((s) => s.name)).toEqual([
      "process.cpu.time",
      "http.server.request.duration",
      "free.memory",
    ]);

    const hist = samples[1]!;
    expect(hist).toMatchObject({
      unit: "ms",
      count: 42,
      sum: 6300,
      min: 50,
      max: 500,
      buckets: [
        { boundary: 100, count: 10 },
        { boundary: 250, count: 15 },
        { boundary: 500, count: 12 },
      ],
    });
    expect(hist.timestamp).toEqual(new Date("1970-01-01T00:33:20.000Z"));

    const gauge = samples[2]!;
    expect(gauge).toMatchObject({ kind: "GAUGE", value: 2048 });
    expect(gauge.attributes).toEqual({ mode: "idle" });
  });

  it("空 payload 返回空结构", () => {
    expect(decodeOtlpMetricsProtobuf(new Uint8Array())).toEqual({});
  });

  it("畸形输入抛错", () => {
    expect(() =>
      decodeOtlpMetricsProtobuf(Uint8Array.from([0x0a, 0x05, 0x01])),
    ).toThrow();
  });
});
