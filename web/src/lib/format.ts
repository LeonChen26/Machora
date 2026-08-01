// 轻量时间格式化，避免引入 dayjs/date-fns 依赖

export function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;

  const sec = Math.round(abs / 1000);
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`;

  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;

  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;

  const day = Math.round(hr / 24);
  if (day < 30) return future ? `in ${day}d` : `${day}d ago`;

  return formatDateTime(d);
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

export function durationMs(
  start: Date | string,
  end: Date | string | null | undefined,
): number | null {
  const s = typeof start === "string" ? new Date(start) : start;
  if (!end) return null;
  const e = typeof end === "string" ? new Date(end) : end;
  return e.getTime() - s.getTime();
}

export function shortId(id: string, len = 8): string {
  return id.length <= len ? id : `${id.slice(0, len)}…`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(cost: number | null | undefined): string {
  if (cost == null || Number.isNaN(cost)) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.000001) return "<$0.000001";
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

export function prettyJson(value: unknown): string {
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
