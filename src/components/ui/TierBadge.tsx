import { getTier } from "../../data/tiers";

interface BadgeProps {
  tier: string | null | undefined;
  size?: "sm" | "md" | "lg";
  showHint?: boolean;
}

/** Read-only tier badge — used in lists and cards. */
export function TierBadge({ tier, size = "md", showHint }: BadgeProps) {
  const t = getTier(tier);
  if (t.id === "REGULAR" && !showHint) return null;

  const padX = size === "sm" ? 7 : size === "lg" ? 14 : 10;
  const padY = size === "sm" ? 2 : size === "lg" ? 5 : 3;
  const fs   = size === "sm" ? 10 : size === "lg" ? 14 : 11;

  return (
    <span
      title={t.hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: `${padY}px ${padX}px`,
        background: t.bg,
        color: t.color,
        border: t.bg === "transparent" ? `1px solid ${t.border}` : "none",
        borderRadius: 999,
        fontSize: fs,
        fontWeight: 800,
        letterSpacing: "0.04em",
        boxShadow: t.bg === "transparent" ? "none" : "0 1px 4px rgba(0,0,0,0.08)",
        whiteSpace: "nowrap",
      }}
    >
      {t.emoji && <span style={{ fontSize: fs + 2 }}>{t.emoji}</span>}
      {t.label}
    </span>
  );
}
