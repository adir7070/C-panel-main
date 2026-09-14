import type { ReactNode } from "react";
import { Sparkline } from "./Sparkline";

type ChipColor = "blue" | "cyan" | "green" | "amber" | "red" | "violet" | "pink";

const ACCENT: Record<ChipColor, { bg: string; border: string; sparkFill: string }> = {
  blue:   { bg: "rgba(30,58,138,0.035)",  border: "#1E3A8A", sparkFill: "rgba(30,58,138,0.12)" },
  cyan:   { bg: "rgba(6,182,212,0.04)",   border: "#06B6D4", sparkFill: "rgba(6,182,212,0.12)" },
  green:  { bg: "rgba(16,185,129,0.04)",  border: "#10B981", sparkFill: "rgba(16,185,129,0.12)" },
  amber:  { bg: "rgba(245,158,11,0.04)",  border: "#F59E0B", sparkFill: "rgba(245,158,11,0.12)" },
  red:    { bg: "rgba(239,68,68,0.04)",   border: "#EF4444", sparkFill: "rgba(239,68,68,0.12)" },
  violet: { bg: "rgba(124,58,237,0.04)",  border: "#7C3AED", sparkFill: "rgba(124,58,237,0.12)" },
  pink:   { bg: "rgba(219,39,119,0.04)",  border: "#DB2777", sparkFill: "rgba(219,39,119,0.12)" },
};

interface Props {
  label: string;
  value: ReactNode;
  delta?: number;
  deltaLabel?: string;
  invertDelta?: boolean;
  spark?: number[];
  sparkColor?: string;
  chip?: ChipColor;
  icon?: ReactNode;
  meta?: string;
  onClick?: () => void;
}

export function KpiCard({
  label, value, delta, deltaLabel, invertDelta,
  spark, sparkColor, chip, icon, meta, onClick,
}: Props) {
  const Tag = onClick ? "button" : "div";
  const accent = chip ? ACCENT[chip] : ACCENT.blue;
  const isPositive = delta != null && (invertDelta ? delta < 0 : delta > 0);
  const isNegative = delta != null && (invertDelta ? delta > 0 : delta < 0);
  const sc = sparkColor ?? accent.border;

  return (
    <Tag
      onClick={onClick}
      style={{
        textAlign: "right",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
        gap: 0,
        minWidth: 0,
        background: accent.bg,
        border: "1px solid rgba(203,213,225,0.65)",
        borderTop: `3px solid ${accent.border}`,
        borderRadius: "var(--r-3)",
        padding: "var(--s-5)",
        boxShadow: "0 1px 3px rgba(11,20,48,0.05), 0 4px 16px -4px rgba(11,20,48,0.07)",
        transition: "box-shadow 150ms ease, transform 120ms ease",
      }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(11,20,48,0.08), 0 10px 28px -6px rgba(11,20,48,0.12)")}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(11,20,48,0.05), 0 4px 16px -4px rgba(11,20,48,0.07)")}
    >
      {/* Top row: icon chip + chevron */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
        {chip && icon ? (
          <div className={`chip chip-${chip}`} style={{ width: 38, height: 38, borderRadius: "var(--r-2)" }}>
            {icon}
          </div>
        ) : <span />}
        {onClick && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeLinecap="round">
            <path d="M15 18l-6-6 6-6" transform="rotate(180 12 12)" />
          </svg>
        )}
      </div>

      {/* Label */}
      <p style={{
        fontSize: "var(--t-xs)",
        fontWeight: 700,
        color: "var(--ink-3)",
        letterSpacing: "0.07em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}>{label}</p>

      {/* Big value */}
      <p style={{
        fontFamily: "var(--sans)",
        fontSize: "var(--t-2xl)",
        fontWeight: 800,
        color: "var(--ink)",
        letterSpacing: "-0.025em",
        lineHeight: 1,
        fontFeatureSettings: '"lnum" 1, "tnum" 1',
      }}>
        {value}
      </p>

      {/* Delta + spark row */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: "var(--s-4)", gap: "var(--s-3)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {delta != null && (
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "3px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              background: isPositive ? "var(--positive-bg)" : isNegative ? "var(--negative-bg)" : "var(--bg-tint)",
              color: isPositive ? "var(--positive)" : isNegative ? "var(--negative)" : "var(--ink-3)",
            }}>
              <Arrow direction={delta > 0 ? "up" : delta < 0 ? "down" : "flat"} />
              {Math.abs(delta).toFixed(0)}%
            </span>
          )}
          {(deltaLabel || meta) && (
            <span style={{ fontSize: 11, color: "var(--ink-4)", fontWeight: 500 }}>
              {deltaLabel ?? meta}
            </span>
          )}
        </div>
        {spark && spark.length > 1 && (
          <Sparkline
            values={spark}
            width={96}
            height={32}
            color={sc}
            fill={accent.sparkFill}
            showFill
          />
        )}
      </div>
    </Tag>
  );
}

function Arrow({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") return (
    <svg width="9" height="9" viewBox="0 0 9 9"><path d="M4.5 1 L8 7 L1 7 Z" fill="currentColor" /></svg>
  );
  if (direction === "down") return (
    <svg width="9" height="9" viewBox="0 0 9 9"><path d="M4.5 8 L8 2 L1 2 Z" fill="currentColor" /></svg>
  );
  return <svg width="9" height="9" viewBox="0 0 9 9"><rect x="1" y="3.5" width="7" height="2" rx="1" fill="currentColor" /></svg>;
}
