#!/usr/bin/env node
// 捕获 OpenClaw → machora 的 OTLP 原始请求，用于生成测试 fixture。
//
// 用法：node scripts/capture-otel.mjs
//   监听 CAPTURE_PORT（默认 3105），把收到的请求体原样保存为
//   packages/shared/src/otel/fixtures/raw/raw-<n>-<ts>.bin，
//   并转发到 MACHORA_URL（默认 http://localhost:3100），返回真实响应。
//
// 配合 openclaw.local.json5 中 diagnostics.otel.endpoint 临时指向本代理：
//   "endpoint": "http://localhost:3105/api/public/otel"
// 任务结束后 Ctrl+C 停止，并把 endpoint 改回 http://localhost:3100。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CAPTURE_PORT ?? 3105);
const TARGET = process.env.MACHORA_URL ?? "http://localhost:3100";
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "shared",
  "src",
  "otel",
  "fixtures",
  "raw",
);

fs.mkdirSync(OUT_DIR, { recursive: true });

let seq = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  seq += 1;
  const name = `raw-${String(seq).padStart(2, "0")}-${Date.now()}.bin`;
  fs.writeFileSync(path.join(OUT_DIR, name), body);
  console.log(`[capture] ${req.method} ${req.url} (${body.length} bytes) -> ${name}`);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers["transfer-encoding"];
  delete headers.connection;
  try {
    const r = await fetch(TARGET + req.url, {
      method: req.method,
      headers,
      body,
      duplex: "half",
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(buf);
    console.log(`[capture] forwarded -> ${r.status}`);
  } catch (e) {
    console.error(`[capture] forward failed: ${e.message}`);
    if (e.cause) console.error(`[capture] cause:`, e.cause);
    res.writeHead(502);
    res.end("forward failed");
  }
});

server.listen(PORT, () => {
  console.log(`[capture] listening :${PORT} -> ${TARGET}`);
  console.log(`[capture] raw bodies saved to ${OUT_DIR}`);
});

process.on("SIGINT", () => {
  console.log("\n[capture] stopped");
  process.exit(0);
});
