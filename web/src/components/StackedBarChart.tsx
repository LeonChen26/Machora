// 堆叠柱状图（纯 div/CSS，无第三方依赖）
// 每根柱按 series 堆叠，色板按 series name 稳定映射，底部自动生成图例

const PALETTE = [
  "var(--accent)",
  "var(--purple)",
  "var(--green)",
  "var(--amber)",
  "var(--red)",
  "#38bdf8",
  "#fb7185",
  "#94a3b8",
];

export function StackedBarChart({
  data,
  height = 140,
  emptyText = "暂无数据",
}: {
  data: { label: string; series: { name: string; value: number }[] }[];
  height?: number;
  emptyText?: string;
}) {
  const names = Array.from(new Set(data.flatMap((d) => d.series.map((s) => s.name))));
  const colorOf = (name: string) => PALETTE[names.indexOf(name) % PALETTE.length];

  const max = Math.max(
    ...data.map((d) => d.series.reduce((s, x) => s + x.value, 0)),
    1,
  );

  if (data.length === 0 || max <= 1) {
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

  return (
    <div>
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
                flexDirection: "column-reverse",
                justifyContent: "flex-start",
                overflow: "hidden",
                borderRadius: 4,
              }}
            >
              {d.series.map((s, j) => (
                <div
                  key={j}
                  title={`${d.label} · ${s.name}: ${s.value}`}
                  style={{
                    width: "100%",
                    height: `${(s.value / max) * 100}%`,
                    background: colorOf(s.name),
                    opacity: 0.85,
                  }}
                />
              ))}
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
      {names.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "center",
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          {names.map((n) => (
            <span
              key={n}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text-dim)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: colorOf(n),
                  display: "inline-block",
                }}
              />
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
