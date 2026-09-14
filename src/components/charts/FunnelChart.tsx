interface Stage {
  label: string;
  value: number;
  color?: string;
}

interface Props {
  stages: Stage[];
  height?: number;
  defaultColor?: string;
}

export function FunnelChart({ stages, height = 220, defaultColor = "var(--blue)" }: Props) {
  if (stages.length === 0) {
    return <div className="empty"><p className="empty-meta">אין נתונים להצגה.</p></div>;
  }
  const top = stages[0].value;
  const max = Math.max(1, ...stages.map(s => s.value));
  const rowH = height / stages.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {stages.map((s, i) => {
        const widthPct = (s.value / max) * 100;
        const dropPct = i === 0 ? 100 : top > 0 ? (s.value / top) * 100 : 0;
        const color = s.color ?? defaultColor;
        return (
          <div key={i} style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr 80px 60px",
            alignItems: "center",
            gap: "var(--s-4)",
            height: rowH,
          }}>
            <div style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink-2)" }}>
              {s.label}
            </div>
            <div style={{ position: "relative", height: rowH * 0.7, background: "var(--bg-tint)", borderRadius: 6 }}>
              <div style={{
                position: "absolute",
                top: 0, bottom: 0,
                right: 0,
                width: `${widthPct}%`,
                background: color,
                borderRadius: 6,
                transition: "width 320ms ease",
              }} />
            </div>
            <div className="figure-num tabular" style={{ fontWeight: 800, fontSize: "var(--t-md)", textAlign: "left" }}>
              {(s.value ?? 0).toLocaleString("he-IL")}
            </div>
            <div className="figure-num tabular" style={{
              fontSize: "var(--t-xs)",
              fontWeight: 700,
              color: i === 0 ? "var(--ink-3)" : "var(--blue)",
              textAlign: "left",
            }}>
              {dropPct.toFixed(0)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}
