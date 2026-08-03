// 全站统一：level → badge 颜色类
// ERROR=red / WARNING=amber / DEBUG=blue / 其余（DEFAULT 等）默认徽章灰
export function levelBadge(level: string | null | undefined): string {
  if (level === "ERROR") return "red";
  if (level === "WARNING") return "amber";
  if (level === "DEBUG") return "blue";
  return "";
}
