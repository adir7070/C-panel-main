interface Slice {
  label: string;
  value: number;
  color: string;
}

interface Props {
  data: Slice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string | number;
}

export function DonutChart({
  data,
  size = 180,
  thickness = 22,
  centerLabel,
  centerValue,
}: Props) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const radius = size / 2 - thickness / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const segments = data.map(d => {
    const fraction = total > 0 ? d.value / total : 0;
    const length = circumference * fraction;
    const seg = { ...d, fraction, length, dashoffset: offset };
    offset += length;
    return seg;
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-5)" }}>
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Track */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke="var(--rule)"
            strokeWidth={thickness}
          />
          {segments.map((s, i) => (
            <circle
              key={i}
              cx={cx} cy={cy} r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${s.length} ${circumference - s.length}`}
              strokeDashoffset={-s.dashoffset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: "stroke-dasharray 280ms ease" }}
            />
          ))}
        </svg>
        {(centerLabel || centerValue != null) && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
          }}>
            {centerValue != null && (
              <span style={{
                fontFamily: "var(--sans)",
                fontSize: "var(--t-2xl)",
                fontWeight: 800,
                color: "var(--ink)",
                lineHeight: 1,
                letterSpacing: "-0.02em",
              }}>{centerValue}</span>
            )}
            {centerLabel && (
              <span style={{
                fontSize: "var(--t-xs)",
                fontWeight: 600,
                color: "var(--ink-3)",
                marginTop: 4,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}>{centerLabel}</span>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "var(--s-2)", flex: 1, minWidth: 0 }}>
        {data.map((d, i) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <li key={i} style={{ display: "grid", gridTemplateColumns: "10px 1fr auto auto", alignItems: "center", gap: "var(--s-3)" }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: d.color, display: "inline-block" }} />
              <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
              <span className="figure-num tabular" style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>{d.value}</span>
              <span className="figure-num tabular" style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", minWidth: 32, textAlign: "left" }}>{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
