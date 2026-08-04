// 多系列折线图（纯 SVG，无第三方依赖）
// x = 时间桶索引，y = 值；每条 series 一条折线；底部图例按系列名稳定取色
// viewBox 归一化 + non-scaling-stroke：随容器拉伸不变形、线宽恒定

const PALETTE = [
  "var(--accent)",
  "var(--purple)",
  "var(--green)",
  "var(--amber)",
  "var(--red)",
  "var(--sky)",
  "var(--rose)",
  "var(--slate)",
];

export function LineChart({
  data,
  height = 150,
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

  // 每系列折线坐标（viewBox 0 0 100 40，留边距）
  const W = 100;
  const H = 40;
  const PAD = 2;
  const n = data.length;
  const x = (i: number) =>
    n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  const lines = names.map((nm) => ({
    nm,
    points: data
      .map((d, i) => {
        const s = d.series.find((x) => x.name === nm);
        return s ? `${x(i).toFixed(2)},${y(s.value).toFixed(2)}` : null;
      })
      .filter((p): p is string => p != null)
      .join(" "),
  }));

  // x 轴刻度：最多 6 个
  const ticks = Array.from(
    new Set(
      data.map((_, i) =>
        Math.round((i / Math.max(n - 1, 1)) * 5),
      ),
    ),
  ).sort((a, b) => a - b);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
      >
        {lines.map((l) => (
          <polyline
            key={l.nm}
            points={l.points}
            fill="none"
            stroke={colorOf(l.nm)}
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
            opacity={0.9}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--text-mute)",
          marginTop: 2,
          whiteSpace: "nowrap",
        }}
      >
        {ticks.map((i) => (
          <span key={i}>{data[i]?.label ?? ""}</span>
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
          {names.map((nm) => (
            <span
              key={nm}
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
                  width: 10,
                  height: 2,
                  borderRadius: 1,
                  background: colorOf(nm),
                  display: "inline-block",
                }}
              />
              {nm}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
