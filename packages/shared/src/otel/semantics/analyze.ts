// 统一语义接入层 —— 分析器
// analyzeSpan(attrs, statusCode) → AnalyzedSpan：
//   1. 按优先级合并各来源 adapter 的语义字段（先到先得）
//   2. 显式类型覆盖：machora.observation.type > langfuse.observation.type
//      （接受 span.kind 多值；langfuse.observation.type=GENERATION 映射为 LLM）
//   3. 其余由归一化 kind 直接决定 observation 类型（type 与 span.kind 一致：
//      LLM→LLM、EMBEDDING→EMBEDDING、EVENT→EVENT、其余角色原样落库，UNKNOWN/null→SPAN）
//   4. level：adapter 提取值（machora.level / langfuse level）→ statusCode → error.type → DEFAULT

import { ATTR } from "../attributes.ts";
import { MACHORA_ATTR, MACHORA_SPAN_KINDS } from "./machora.ts";
import { SEMANTICS_ADAPTERS, emptySemanticSpan } from "./adapters.ts";
import type { AnalyzedSpan, MachoraObservationType } from "./types.ts";
import { mergeSemantic, asString } from "./util.ts";

const LEVEL_ALIASES: Record<string, string> = {
  DEBUG: "DEBUG",
  TRACE: "DEBUG",
  VERBOSE: "DEBUG",
  DEFAULT: "DEFAULT",
  INFO: "DEFAULT",
  LOG: "DEFAULT",
  NOTICE: "DEFAULT",
  OK: "DEFAULT",
  SUCCESS: "DEFAULT",
  WARNING: "WARNING",
  WARN: "WARNING",
  ERROR: "ERROR",
  FATAL: "ERROR",
  CRITICAL: "ERROR",
};

/** 显式类型覆盖值 → 落库 type；未知值返回 null */
function normalizeType(v: string): MachoraObservationType | null {
  const t = v.trim().toUpperCase();
  // langfuse.observation.type 生成类 → LLM（无更细角色信息）
  if (t === "GENERATION") return "LLM";
  if (t === "SPAN") return "SPAN";
  if (t === "EVENT") return "EVENT";
  // span.kind 多值直接透传
  if ((MACHORA_SPAN_KINDS as readonly string[]).includes(t)) {
    return t as MachoraObservationType;
  }
  return null;
}

/** kind → 落库 type：与 span.kind 一致（UNKNOWN/null → SPAN 通用节点） */
export function kindToType(kind: AnalyzedSpan["kind"] | null): MachoraObservationType {
  if (kind === null || kind === "UNKNOWN") return "SPAN";
  return kind;
}

export function normalizeLevel(v: string | null): string | null {
  if (!v) return null;
  return LEVEL_ALIASES[v.trim().toUpperCase()] ?? null;
}

/** 分析单个 span：合并语义 + 判定 observation 类型 / level */
export function analyzeSpan(
  attrs: Record<string, unknown>,
  statusCode: number,
): AnalyzedSpan {
  const semantic = emptySemanticSpan();
  for (const adapter of SEMANTICS_ADAPTERS) {
    mergeSemantic(semantic, adapter.extract(attrs));
  }

  let type = kindToType(semantic.kind);
  const machoraType = asString(attrs[MACHORA_ATTR.OBS_TYPE]);
  if (machoraType) type = normalizeType(machoraType) ?? type;
  else {
    const langfuseType = asString(attrs[ATTR.OBS_TYPE]);
    if (langfuseType) type = normalizeType(langfuseType) ?? type;
  }

  let level = normalizeLevel(semantic.level);
  if (!level) {
    if (statusCode === 2) level = "ERROR";
    else if (attrs[ATTR.GEN_AI_ERROR_TYPE] !== undefined) level = "ERROR";
    else level = "DEFAULT";
  }

  // totalTokens：显式 total > input+output 推算（与旧行为一致）
  if (
    semantic.totalTokens === null &&
    (semantic.inputTokens !== null || semantic.outputTokens !== null)
  ) {
    semantic.totalTokens = (semantic.inputTokens ?? 0) + (semantic.outputTokens ?? 0);
  }

  return { ...semantic, type, level };
}
