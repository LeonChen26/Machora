// 迷你趋势折线（纯 SVG，无依赖）：表格行内 / 指标面板展示每日走势。
// 服务端渲染组件，无需客户端状态。
// fit=true 时铺满容器宽度（viewBox 归一化 + non-scaling-stroke，线宽恒定）；
// 此时不画末端圆点（非等比缩放会把圆压成椭圆）。fit=false 用固定像素尺寸。
export function Sparkline({
  data,
  width = 84,
  height = 22,
  color = "var(--accent)",
  title,
  fit = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  title?: string;
  fit?: boolean;
}) {
  if (data.length === 0) return <span className="mute2">—</span>;

  const pad = 2.5;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? innerW / (data.length - 1) : 0;

  const pts = data.map((v, i) => {
    const x = pad + i * step;
    const y = pad + innerH - (v / max) * innerH;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const area = `${pad},${(height - pad).toFixed(1)} ${line} ${(pad + (data.length - 1) * step).toFixed(1)},${(height - pad).toFixed(1)}`;

  return (
    <svg
      {...(fit
        ? {
            viewBox: `0 0 ${width} ${height}`,
            preserveAspectRatio: "none",
            style: { width: "100%", height, display: "block" as const },
          }
        : {
            width,
            height,
            style: { display: "block" as const },
          })}
      role="img"
      aria-label={title ?? "每日趋势"}
    >
      {title ? <title>{title}</title> : null}
      {data.length > 1 && (
        <>
          <polygon points={area} fill={color} opacity={0.12} />
          <polyline
            points={line}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            vectorEffect={fit ? "non-scaling-stroke" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
      {!fit && <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="2" fill={color} />}
    </svg>
  );
}
