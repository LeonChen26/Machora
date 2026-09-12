// OTLP HTTP 请求体解码：Content-Encoding(gzip/deflate/identity) + Content-Type(json/protobuf)
// 供 /api/public/otel/v1/traces 与 /metrics 两个端点复用。

import { type OtlpExportMetricsServiceRequest, type OtlpExportTraceServiceRequest } from "./types.ts";
import { decodeOtlpMetricsProtobuf, decodeOtlpProtobuf } from "./protobuf.ts";

export type OtelContentEncoding = "gzip" | "deflate" | "identity" | "br";
export type OtelContentType = "json" | "protobuf";

interface ParsedHeaders {
  encoding: OtelContentEncoding;
  type: OtelContentType;
}

function parseContentEncoding(header: string | null): OtelContentEncoding {
  const enc = (header ?? "").toLowerCase().trim();
  if (enc.includes("gzip")) return "gzip";
  if (enc.includes("deflate")) return "deflate";
  if (enc.includes("br")) return "br";
  return "identity";
}

function parseContentType(header: string | null): OtelContentType {
  const ct = (header ?? "").toLowerCase();
  if (ct.includes("protobuf") || ct.includes("x-protobuf")) return "protobuf";
  return "json";
}

function parseHeaders(req: { headers: Headers }): ParsedHeaders {
  return {
    encoding: parseContentEncoding(req.headers.get("content-encoding")),
    type: parseContentType(req.headers.get("content-type")),
  };
}

/**
 * 按需解压 body。服务端/Node 环境下动态加载 node:zlib；
 * 若服务端不支持 br 而遇 br 编码，zlib.brotliDecompress 会抛出错误。
 */
async function decompress(
  encoding: OtelContentEncoding,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  if (encoding === "identity") return bytes;

  const zlib = await import("node:zlib");
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (encoding) {
    case "gzip":
      return new Promise((resolve, reject) => {
        zlib.gunzip(buf, (err, out) => {
          if (err) reject(err);
          else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
        });
      });
    case "deflate":
      return new Promise((resolve, reject) => {
        // OTLP 规范中 deflate 指 RFC 1951 raw deflate，但不少 exporter 会发送 zlib
        // wrapper (RFC 1950)。先按 raw deflate 解，失败再回退 inflate（自动识别 wrapper）。
        const tryRaw = (next: () => void) => {
          zlib.inflateRaw(buf, (err, out) => {
            if (err) next();
            else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          });
        };
        tryRaw(() => {
          zlib.inflate(buf, (err, out) => {
            if (err) reject(err);
            else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          });
        });
      });
    case "br":
      return new Promise((resolve, reject) => {
        zlib.brotliDecompress(buf, (err, out) => {
          if (err) reject(err);
          else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
        });
      });
    default:
      return bytes;
  }
}

/** 通用异常：编码不支持或解压失败 */
export class OtelDecodeError extends Error {
  constructor(
    message: string,
    public readonly status: "bad-encoding" | "bad-protobuf" | "bad-json",
  ) {
    super(message);
    this.name = "OtelDecodeError";
  }
}

/**
 * 读取并解码 OTLP HTTP 请求体。
 * - 支持 Content-Encoding: gzip / deflate / br / identity
 * - 支持 Content-Type: application/json / application/x-protobuf
 * - 返回原始对象（JSON）或解码后的 OTLP 结构（protobuf）
 */
export async function decodeOtelRequestBody(req: { headers: Headers; arrayBuffer(): Promise<ArrayBuffer> }): Promise<unknown> {
  const { encoding, type } = parseHeaders(req);
  const raw = new Uint8Array(await req.arrayBuffer());

  let bytes: Uint8Array;
  try {
    bytes = await decompress(encoding, raw);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new OtelDecodeError(
      `Failed to decompress ${encoding} body: ${err.message}`,
      "bad-encoding",
    );
  }

  if (type === "protobuf") {
    try {
      return decodeOtlpProtobuf(bytes);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      throw new OtelDecodeError(`Invalid protobuf payload: ${err.message}`, "bad-protobuf");
    }
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new OtelDecodeError(`Invalid JSON body: ${err.message}`, "bad-json");
  }
}

/**
 * traces 端点专用：保证返回 ExportTraceServiceRequest 结构。
 */
export async function decodeOtelTraceRequest(
  req: { headers: Headers; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<OtlpExportTraceServiceRequest> {
  return (await decodeOtelRequestBody(req)) as OtlpExportTraceServiceRequest;
}

/**
 * metrics 端点专用：保证返回 ExportMetricsServiceRequest 结构。
 */
export async function decodeOtelMetricsRequest(
  req: { headers: Headers; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<OtlpExportMetricsServiceRequest> {
  return (await decodeOtelRequestBody(req)) as OtlpExportMetricsServiceRequest;
}
