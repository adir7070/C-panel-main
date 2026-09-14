interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  variant?: "text" | "title" | "card" | "circle" | "rect";
  style?: React.CSSProperties;
  className?: string;
}

export function Skeleton({ width, height, variant = "rect", style, className = "" }: SkeletonProps) {
  const cls = `skeleton skeleton-${variant} ${className}`.trim();
  return (
    <span
      className={cls}
      style={{
        width: width ?? (variant === "circle" ? 40 : "100%"),
        height: height ?? (variant === "title" ? 22 : variant === "text" ? 12 : variant === "card" ? 80 : variant === "circle" ? 40 : 16),
        ...style,
      }}
    />
  );
}

export function SkeletonStack({ rows = 3, gap = 8 }: { rows?: number; gap?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="text" width={i === rows - 1 ? "60%" : "100%"} />
      ))}
    </div>
  );
}

export function SkeletonKpiTile() {
  return (
    <div className="kpi-tile">
      <Skeleton variant="text" width={80} />
      <Skeleton variant="title" width={140} style={{ marginTop: 8 }} />
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Skeleton variant="text" width={50} />
        <Skeleton variant="text" width={70} />
      </div>
    </div>
  );
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, padding: "12px 0" }}>
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} variant="text" />
      ))}
    </div>
  );
}
