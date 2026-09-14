interface Props {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
  showFill?: boolean;
}

export function Sparkline({
  values,
  width = 120,
  height = 36,
  color = "var(--blue)",
  fill = "rgba(30, 58, 138, 0.10)",
  showFill = true,
}: Props) {
  if (values.length === 0) {
    return <svg width={width} height={height} aria-hidden />;
  }

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const padY = 2;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = padY + (height - padY * 2) - ((v - min) / range) * (height - padY * 2);
    return { x, y };
  });

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const fillPath = `${path} L${last.x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {showFill && <path d={fillPath} fill={fill} />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {last && (
        <circle cx={last.x} cy={last.y} r="2.5" fill="#fff" stroke={color} strokeWidth="1.5" />
      )}
    </svg>
  );
}
