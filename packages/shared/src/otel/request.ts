// OTLP HTTP 请求体解码：Content-Encoding(gzip/deflate/identity) + Content-Type(json/protobuf)
// 供 /api/public/otel/v1/traces 与 /metrics 两个端点复用。

import { type OtlpExportMetricsServiceRequest, type OtlpExportTraceServiceRequest } from "./types.ts";
import { decodeOtlpMetricsProtobuf, decodeOtlpProtobuf } from "./protobuf.ts";

export type OtelContentEncoding = "gzip" | "deflate" | "identity" | "br";
export type OtelContentType = "json" | "protobuf";

/**
 * 请求体体积上限。端点无鉴权且单进程承载，必须自带安全阀：
 * - 压缩体上限：拦截超大原始 body 直接占满内存；
 * - 解压体上限：拦截 zip bomb（小压缩体解出海量数据）。
 * 解压时通过 zlib 的 maxOutputLength 在解压过程中即中止，避免先分配再判断。
 */
const MAX_COMPRESSED_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BODY_BYTES = 32 * 1024 * 1024;

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
  const opts = { maxOutputLength: MAX_DECOMPRESSED_BODY_BYTES };

  switch (encoding) {
    case "gzip":
      return new Promise((resolve, reject) => {
        zlib.gunzip(buf, opts, (err, out) => {
          if (err) reject(err);
          else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
        });
      });
    case "deflate":
      return new Promise((resolve, reject) => {
        // OTLP 规范中 deflate 指 RFC 1951 raw deflate，但不少 exporter 会发送 zlib
        // wrapper (RFC 1950)。先按 raw deflate 解，失败再回退 inflate（自动识别 wrapper）。
        const tryRaw = (next: () => void) => {
          zlib.inflateRaw(buf, opts, (err, out) => {
            if (err) next();
            else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          });
        };
        tryRaw(() => {
          zlib.inflate(buf, opts, (err, out) => {
            if (err) reject(err);
            else resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
          });
        });
      });
    case "br":
      return new Promise((resolve, reject) => {
        zlib.brotliDecompress(buf, opts, (err, out) => {
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
    public readonly status: "bad-encoding" | "bad-protobuf" | "bad-json" | "too-large",
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

  if (raw.byteLength > MAX_COMPRESSED_BODY_BYTES) {
    throw new OtelDecodeError(
      `Request body too large: ${raw.byteLength} bytes (max ${MAX_COMPRESSED_BODY_BYTES})`,
      "too-large",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await decompress(encoding, raw);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    // maxOutputLength 触顶时 zlib 报 ERR_BUFFER_TOO_LARGE，归入 too-large 而非解码失败
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new OtelDecodeError(
        `Decompressed body too large (max ${MAX_DECOMPRESSED_BODY_BYTES} bytes)`,
        "too-large",
      );
    }
    throw new OtelDecodeError(
      `Failed to decompress ${encoding} body: ${err.message}`,
      "bad-encoding",
    );
  }

  // 兜底：identity 或个别 zlib 版本未按 maxOutputLength 报错时仍拦截
  if (bytes.byteLength > MAX_DECOMPRESSED_BODY_BYTES) {
    throw new OtelDecodeError(
      `Decompressed body too large: ${bytes.byteLength} bytes (max ${MAX_DECOMPRESSED_BODY_BYTES})`,
      "too-large",
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
