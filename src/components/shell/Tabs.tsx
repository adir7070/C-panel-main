import { useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

interface Tab {
  id: string;
  label: string;
  hint?: string;
}

interface Props {
  tabs:    Tab[];
  active:  string;
  onChange: (id: string) => void;
  /** When true, the strip stays glued to the top of the scroll container.
   *  Pass `top` (in px) to offset under other sticky layers (e.g. header). */
  sticky?: boolean;
  top?:    number;
  /** Per-tab optional id used to share `layoutId` for the sliding underline.
   *  Override only if multiple tab strips can render at once on one page. */
  layoutId?: string;
}

/**
 * Horizontal tab strip with a smoothly-sliding active underline (framer-motion
 * `layoutId`). RTL-aware via `dir="rtl"` on the strip — flex flows right-to-
 * left automatically. Keyboard accessible: Arrow keys move between tabs,
 * Home/End jump to ends, Enter / Space activate.
 *
 * Per the UI/UX skill rules:
 * - Tab order matches visual order (RTL flex)
 * - aria-selected on active tab, role="tablist" on container
 * - Visible focus ring (CSS :focus-visible)
 * - prefers-reduced-motion respected — underline snaps without animation
 */
export function Tabs({ tabs, active, onChange, sticky = false, top = 0, layoutId = "tab-underline" }: Props) {
  const reduce = useReducedMotion();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  /* Keep the active tab in view when it changes — important on narrow
     viewports where the strip horizontally scrolls. */
  useEffect(() => {
    const el = refs.current[active];
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [active, reduce]);

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const idx = tabs.findIndex(t => t.id === active);
    if (idx < 0) return;
    let next = idx;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      /* RTL: ArrowRight goes back (towards start of list), ArrowLeft forward. */
      const dir = e.key === "ArrowRight" ? -1 : 1;
      next = (idx + dir + tabs.length) % tabs.length;
    } else if (e.key === "Home") { e.preventDefault(); next = 0; }
    else if (e.key === "End")    { e.preventDefault(); next = tabs.length - 1; }
    else return;
    onChange(tabs[next].id);
  }

  return (
    <div
      role="tablist"
      onKeyDown={onKey}
      className="tabs"
      style={{
        position: sticky ? "sticky" : "static",
        top,
        zIndex: 20,
        background: "var(--paper)",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            ref={el => { refs.current[t.id] = el; }}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => onChange(t.id)}
            className={"tab" + (isActive ? " active" : "")}
            style={{
              position: "relative",
              padding: "12px 18px",
              fontSize: "var(--t-sm)",
              fontWeight: isActive ? 700 : 500,
              color: isActive ? "var(--blue-deep)" : "var(--ink-2)",
              background: "transparent",
              border: 0,
              borderBottom: 0,           /* override the legacy 2px border */
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "color 150ms var(--ease-out)",
            }}
          >
            {t.label}
            {isActive && (
              <motion.div
                layoutId={layoutId}
                transition={reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 380, damping: 32 }}
                style={{
                  position: "absolute",
                  insetInline: 12,
                  bottom: -1,
                  height: 2,
                  background: "var(--blue-deep)",
                  borderRadius: 99,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
