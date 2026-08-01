// 把捕获的 OTLP protobuf raw 文件解码为 JSON fixture（mock 测试数据）。
// 用法（在 machora 根目录）：
//   node --import tsx scripts/decode-otel-fixture.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeOtlpProtobuf } from "../packages/shared/src/otel/protobuf.ts";

const rawDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "shared",
  "src",
  "otel",
  "fixtures",
  "raw",
);
const outDir = path.dirname(rawDir);

const files = readdirSync(rawDir).filter((f) => f.endsWith(".bin"));
for (const f of files) {
  const bytes = readFileSync(path.join(rawDir, f));
  const decoded = decodeOtlpProtobuf(new Uint8Array(bytes));
  const outName = f.replace(".bin", ".json");
  writeFileSync(path.join(outDir, outName), JSON.stringify(decoded, null, 2));
  console.log(`${f} -> ${outName}`);

  // 概要：每个 span 的 traceId/name/kind/attrs 数
  for (const rs of decoded.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const attrs = Object.fromEntries(
          (s.attributes ?? []).map((a) => [
            a.key,
            a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue ?? a.value?.doubleValue ?? "<complex>",
          ]),
        );
        console.log(
          `  span ${s.name} kind=${s.kind} attrs=${Object.keys(attrs).length}`,
        );
      }
    }
  }
}
