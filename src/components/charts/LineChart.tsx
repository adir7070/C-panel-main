export interface LinePoint {
  label: string;
  value: number;
}

export interface LineSeries {
  name: string;
  color: string;
  points: LinePoint[];
  fill?: string;
}

interface Props {
  series: LineSeries[];
  height?: number;
  showLegend?: boolean;
  formatValue?: (n: number) => string;
}

export function LineChart({
  series,
  height = 220,
  showLegend = true,
  formatValue = (n) => String(n),
}: Props) {
  if (series.length === 0 || series.every(s => s.points.length === 0)) {
    return <div className="empty"><p className="empty-meta">אין נתונים להצגה.</p></div>;
  }

  const allValues = series.flatMap(s => s.points.map(p => p.value));
  const max = Math.max(1, ...allValues);
  const min = Math.min(0, ...allValues);
  const range = Math.max(1, max - min);
  const labels = series[0].points.map(p => p.label);
  const W = 1000;
  const H = height;
  const padX = 30;
  const padTop = 16;
  const padBottom = 32;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBottom;
  const stepX = labels.length > 1 ? innerW / (labels.length - 1) : 0;

  function yOf(v: number) {
    return padTop + innerH - ((v - min) / range) * innerH;
  }

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
        {/* y gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = padTop + innerH * (1 - t);
          return (
            <g key={i}>
              <line x1={padX} y1={y} x2={W - padX} y2={y}
                stroke="var(--rule)" strokeWidth="1" strokeDasharray={i === 0 ? "" : "2 4"} />
              <text x={padX - 6} y={y + 3} textAnchor="end" style={{ fontSize: 10, fill: "var(--ink-3)", fontWeight: 600 }}>
                {formatValue(min + range * t)}
              </text>
            </g>
          );
        })}

        {/* x labels */}
        {labels.map((lbl, i) => {
          const showLabel = labels.length <= 8 || i === 0 || i === labels.length - 1 || i === Math.floor(labels.length / 2);
          if (!showLabel) return null;
          const x = padX + stepX * i;
          return (
            <text key={`lbl-${i}`} x={x} y={H - 10}
              textAnchor="middle"
              style={{ fontSize: 10, fill: "var(--ink-3)", fontWeight: 500, letterSpacing: "0.04em" }}>
              {lbl}
            </text>
          );
        })}

        {/* series fills (in order, behind lines) */}
        {series.map((s, si) => {
          if (s.points.length === 0) return null;
          const points = s.points.map((p, i) => ({ x: padX + stepX * i, y: yOf(p.value) }));
          const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          if (!s.fill) return null;
          const last = points[points.length - 1];
          const fillPath = `${linePath} L${last.x.toFixed(1)},${(padTop + innerH).toFixed(1)} L${points[0].x.toFixed(1)},${(padTop + innerH).toFixed(1)} Z`;
          return <path key={`fill-${si}`} d={fillPath} fill={s.fill} opacity={0.55} />;
        })}

        {/* series lines */}
        {series.map((s, si) => {
          if (s.points.length === 0) return null;
          const points = s.points.map((p, i) => ({ x: padX + stepX * i, y: yOf(p.value), value: p.value }));
          const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          return (
            <g key={`line-${si}`}>
              <path d={linePath} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {points.map((p, pi) => (
                <circle key={pi} cx={p.x} cy={p.y} r="3" fill="#fff" stroke={s.color} strokeWidth="1.5" />
              ))}
            </g>
          );
        })}
      </svg>

      {showLegend && series.length > 0 && (
        <div style={{ display: "flex", gap: "var(--s-5)", marginTop: 10, flexWrap: "wrap" }}>
          {series.map((s, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>
              <span style={{ width: 12, height: 2, background: s.color, display: "inline-block" }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
