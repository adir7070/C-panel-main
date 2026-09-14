/**
 * Client tier system — manager-assigned ranking that drives prioritization
 * across the cpanel (client list sort, digest, commissions view, etc.).
 *
 * Tiers ordered from highest priority (GOLD) to lowest (REGULAR).
 */

export type ClientTier =
  | "GOLD"
  | "VIP"
  | "PRO"
  | "PLUS"
  | "SILVER"
  | "REGULAR";

export interface TierConfig {
  id: ClientTier;
  /** Hebrew display label (kept Latin too — managers know these terms). */
  label: string;
  /** Hebrew descriptor used in tooltips. */
  hint: string;
  /** Higher = higher priority (used for sorting). */
  priority: number;
  /** Solid foreground color. */
  color: string;
  /** Background — usually a gradient for top tiers, solid for low. */
  bg: string;
  /** Border color for outline-only chips. */
  border: string;
  /** Emoji used inline next to the label. */
  emoji: string;
}

/* Order matters — used for picker and sort fallback. */
export const TIER_LIST: TierConfig[] = [
  {
    id: "GOLD", label: "GOLD",
    hint: "לקוח VIP בכיר — עדיפות עליונה",
    priority: 100,
    color: "#7C2D12", bg: "linear-gradient(135deg, #FCD34D 0%, #F59E0B 100%)", border: "#F59E0B",
    emoji: "👑",
  },
  {
    id: "VIP", label: "VIP",
    hint: "מקבל יחס מועדף",
    priority: 90,
    color: "#FFFFFF", bg: "linear-gradient(135deg, #A78BFA 0%, #7C3AED 100%)", border: "#7C3AED",
    emoji: "💎",
  },
  {
    id: "PRO", label: "PRO",
    hint: "לקוח קבוע ופעיל",
    priority: 80,
    color: "#FFFFFF", bg: "linear-gradient(135deg, #60A5FA 0%, #2563EB 100%)", border: "#2563EB",
    emoji: "⚡",
  },
  {
    id: "PLUS", label: "PLUS",
    hint: "לקוח מתפתח",
    priority: 70,
    color: "#0C4A6E", bg: "linear-gradient(135deg, #67E8F9 0%, #06B6D4 100%)", border: "#06B6D4",
    emoji: "✨",
  },
  {
    id: "SILVER", label: "SILVER",
    hint: "לקוח נאמן",
    priority: 60,
    color: "#1F2937", bg: "linear-gradient(135deg, #E5E7EB 0%, #9CA3AF 100%)", border: "#9CA3AF",
    emoji: "🥈",
  },
  {
    id: "REGULAR", label: "REGULAR",
    hint: "לקוח רגיל — ברירת מחדל",
    priority: 0,
    color: "#6B7280", bg: "transparent", border: "#D1D5DB",
    emoji: "",
  },
];

const TIER_BY_ID: Record<ClientTier, TierConfig> = TIER_LIST.reduce(
  (acc, t) => ({ ...acc, [t.id]: t }),
  {} as Record<ClientTier, TierConfig>,
);

export function getTier(t: string | null | undefined): TierConfig {
  if (!t) return TIER_BY_ID.REGULAR;
  return TIER_BY_ID[t as ClientTier] ?? TIER_BY_ID.REGULAR;
}

export function tierPriority(t: string | null | undefined): number {
  return getTier(t).priority;
}

/** Sort comparator: highest tier first, then alphabetical fallback. */
export function compareByTier<T extends { tier?: string | null; name?: string | null }>(a: T, b: T): number {
  const pa = tierPriority(a.tier);
  const pb = tierPriority(b.tier);
  if (pa !== pb) return pb - pa;
  return (a.name || "").localeCompare(b.name || "", "he");
}
