import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
}

export function Stat({ label, value, meta }: Props) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value figure-num">{value}</span>
      {meta && <span className="stat-meta">{meta}</span>}
    </div>
  );
}
