interface Bar {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  data: Bar[];
  height?: number;
  defaultColor?: string;
  showValues?: boolean;
  formatValue?: (n: number) => string;
}

export function BarChart({
  data,
  height = 220,
  defaultColor = "var(--blue)",
  showValues = true,
  formatValue = (n) => String(n),
}: Props) {
  if (data.length === 0) {
    return <div className="empty"><p className="empty-meta">אין נתונים להצגה.</p></div>;
  }

  const max = Math.max(1, ...data.map(d => d.value));
  const barW = 100 / data.length;
  const innerBarW = barW * 0.55;
  const labelArea = 28;
  const valueArea = showValues ? 22 : 0;

  return (
    <div style={{ width: "100%" }}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} style={{ display: "block" }}>
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map(t => {
          const y = valueArea + (height - valueArea - labelArea) * (1 - t);
          return (
            <line key={t} x1="0" y1={y} x2="100" y2={y}
              stroke="var(--rule)" strokeWidth="0.3" strokeDasharray="0.5 0.7" vectorEffect="non-scaling-stroke" />
          );
        })}
        {/* baseline */}
        <line x1="0" y1={height - labelArea} x2="100" y2={height - labelArea}
          stroke="var(--rule-strong)" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />

        {data.map((d, i) => {
          const xCenter = barW * i + barW / 2;
          const xLeft = xCenter - innerBarW / 2;
          const h = ((d.value / max) * (height - valueArea - labelArea));
          const y = (height - labelArea) - h;
          const color = d.color ?? defaultColor;
          return (
            <g key={i}>
              <rect
                x={xLeft}
                y={y}
                width={innerBarW}
                height={h}
                fill={color}
                rx={1.2}
              />
              {showValues && (
                <text
                  x={xCenter}
                  y={y - 4}
                  textAnchor="middle"
                  style={{ fontSize: 9, fill: "var(--ink-2)", fontWeight: 700 }}
                >
                  {formatValue(d.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* labels (HTML so RTL Hebrew renders cleanly) */}
      <div style={{
        display: "grid",
        gridTemplateColumns: `repeat(${data.length}, 1fr)`,
        marginTop: 4,
      }}>
        {data.map((d, i) => (
          <div
            key={i}
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              textAlign: "center",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: "0 4px",
            }}
            title={d.label}
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
