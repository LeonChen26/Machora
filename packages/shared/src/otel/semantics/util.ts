// 语义接入层 —— 工具函数（数值 / 数组 / JSON 解码）

export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * OpenInference / Machora 的 input/output.value 是字符串（mime 多为 application/json），
 * 尝试解码为对象；langfuse.observation.input 等已是结构化值则原样返回。
 */
export function decodeJsonValue(v: unknown, mime?: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed === "") return v;
  const mimeStr = typeof mime === "string" ? mime.toLowerCase() : "";
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (mimeStr.includes("json") || looksJson) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}

/** 按优先级合并：先合并者（非 null 字段）保持，后合并者不覆盖已存在的值 */
export function mergeSemantic<T extends object>(base: T, part: Partial<T>): T {
  for (const [k, v] of Object.entries(part)) {
    if (v !== null && v !== undefined) {
      (base as Record<string, unknown>)[k] = v;
    }
  }
  return base;
}
