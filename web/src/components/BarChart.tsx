// 轻量柱状图（纯 div/CSS，无第三方依赖）
// 服务端组件可用；数据量小时足够直观，后续可换 Recharts

export function BarChart({
  data,
  height = 140,
  color = "var(--accent)",
  emptyText = "暂无数据",
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  emptyText?: string;
}) {
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return (
      <div
        style={{
          height,
          display: "grid",
          placeItems: "center",
          color: "var(--text-mute)",
          fontSize: 13,
        }}
      >
        {emptyText}
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 6,
        height,
        paddingTop: 8,
      }}
    >
      {data.map((d, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 4,
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              width: "100%",
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            <div
              className="barchart-bar"
              data-val={d.value}
              title={`${d.label}: ${d.value}`}
              style={{
                width: "100%",
                height: `${(d.value / max) * 100}%`,
                minHeight: d.value > 0 ? 3 : 1,
                background: color,
                borderRadius: "4px 4px 0 0",
                opacity: d.value > 0 ? 1 : 0.15,
                transition: "height 0.2s, opacity 0.15s ease, filter 0.15s ease",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-mute)",
              whiteSpace: "nowrap",
            }}
          >
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}
