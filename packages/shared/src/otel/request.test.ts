import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { promisify } from "node:util";
import {
  decodeOtelRequestBody,
  decodeOtelTraceRequest,
  decodeOtelMetricsRequest,
  OtelDecodeError,
} from "./request.ts";

const gzip = promisify(zlib.gzip);
const deflate = promisify(zlib.deflate);
const deflateRaw = promisify(zlib.deflateRaw);

// 最小手工 wire-format 编码器，用于构造 ExportTraceServiceRequest
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

/** 构造一条最小 trace protobuf 原始字节 */
function makeTraceBytes(): Uint8Array {
  const traceId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const spanId = Uint8Array.from({ length: 8 }, (_, i) => 0x11 + i);
  const span = concat(
    ld(1, traceId),
    ld(2, spanId),
    str(5, "test-span"),
    fixed64(7, 1_000_000_000n),
    fixed64(8, 1_000_000_100n),
  );
  const scopeSpans = concat(ld(1, str(1, "test-scope")), ld(2, span));
  const resourceSpans = concat(ld(1, ld(1, ld(1, str(1, "test-svc")))), ld(2, scopeSpans));
  return ld(1, resourceSpans);
}

function makeRequest(opts: {
  body: Uint8Array;
  contentType?: string;
  contentEncoding?: string;
}): Request {
  const headers = new Headers();
  headers.set("content-type", opts.contentType ?? "application/x-protobuf");
  if (opts.contentEncoding) headers.set("content-encoding", opts.contentEncoding);
  return new Request("http://localhost/api/public/otel/v1/traces", {
    method: "POST",
    headers,
    body: Buffer.from(opts.body),
  });
}

describe("decodeOtelRequestBody", () => {
  it("解码未压缩 protobuf", async () => {
    const bytes = makeTraceBytes();
    const req = makeRequest({ body: bytes });
    const body = await decodeOtelRequestBody(req);
    expect((body as any).resourceSpans[0].scopeSpans[0].spans[0].name).toBe("test-span");
  });

  it("解码 gzip 压缩 protobuf", async () => {
    const bytes = makeTraceBytes();
    const compressed = await gzip(Buffer.from(bytes));
    const req = makeRequest({
      body: new Uint8Array(compressed),
      contentEncoding: "gzip",
    });
    const body = await decodeOtelTraceRequest(req);
    expect(body.resourceSpans![0].scopeSpans![0].spans![0].name).toBe("test-span");
  });

  it("解码 deflate(zlib wrapper) protobuf", async () => {
    const bytes = makeTraceBytes();
    const compressed = await deflate(Buffer.from(bytes));
    const req = makeRequest({
      body: new Uint8Array(compressed),
      contentEncoding: "deflate",
    });
    const body = await decodeOtelTraceRequest(req);
    expect(body.resourceSpans![0].scopeSpans![0].spans![0].name).toBe("test-span");
  });

  it("解码 raw deflate protobuf", async () => {
    const bytes = makeTraceBytes();
    const compressed = await deflateRaw(Buffer.from(bytes));
    const req = makeRequest({
      body: new Uint8Array(compressed),
      contentEncoding: "deflate",
    });
    const body = await decodeOtelTraceRequest(req);
    expect(body.resourceSpans![0].scopeSpans![0].spans![0].name).toBe("test-span");
  });

  it("解码 gzip 压缩 json", async () => {
    const json = JSON.stringify({ resourceSpans: [] });
    const compressed = await gzip(Buffer.from(json));
    const req = makeRequest({
      body: new Uint8Array(compressed),
      contentType: "application/json",
      contentEncoding: "gzip",
    });
    const body = await decodeOtelRequestBody(req);
    expect(body).toEqual({ resourceSpans: [] });
  });

  it("压缩格式错误返回 bad-encoding", async () => {
    const bytes = makeTraceBytes();
    const req = makeRequest({
      body: bytes,
      contentEncoding: "gzip",
    });
    await expect(decodeOtelRequestBody(req)).rejects.toMatchObject({
      status: "bad-encoding",
    });
  });

  it("protobuf 损坏返回 bad-protobuf", async () => {
    const req = makeRequest({ body: new Uint8Array([0xff, 0xff]) });
    await expect(decodeOtelRequestBody(req)).rejects.toMatchObject({
      status: "bad-protobuf",
    });
  });

  it("json 损坏返回 bad-json", async () => {
    const req = makeRequest({
      body: new TextEncoder().encode("not-json"),
      contentType: "application/json",
    });
    await expect(decodeOtelRequestBody(req)).rejects.toMatchObject({
      status: "bad-json",
    });
  });
});

describe("decodeOtelMetricsRequest", () => {
  it("解码 gzip 压缩 metrics json", async () => {
    const json = JSON.stringify({ resourceMetrics: [] });
    const compressed = await gzip(Buffer.from(json));
    const req = makeRequest({
      body: new Uint8Array(compressed),
      contentType: "application/json",
      contentEncoding: "gzip",
    });
    const body = await decodeOtelMetricsRequest(req);
    expect(body.resourceMetrics).toEqual([]);
  });
});
