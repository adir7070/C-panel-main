import type { ReactNode } from "react";

interface Props {
  /** Optional icon / illustration node, displayed above the title. */
  icon?:  ReactNode;
  title:  string;
  meta?:  ReactNode;
  /** Primary action — usually a Button. */
  action?: ReactNode;
  /** Secondary action — usually a ghost link / "learn more". */
  secondaryAction?: ReactNode;
  /** Pad the empty card. Default true. Pass false when the parent already
   *  provides padding (e.g. inside a card body). */
  padded?: boolean;
}

/**
 * Friendly empty / locked / "nothing here yet" state. Composition:
 *
 *   ┌──────────────────────────────────────┐
 *   │            [icon (optional)]         │
 *   │            Title (single line)       │
 *   │            Meta text (1-2 lines)     │
 *   │       [primary]   [secondary]        │
 *   └──────────────────────────────────────┘
 *
 * Per the UI/UX skill rules:
 * - Provides actionable next step instead of dead-end "no data"
 * - Single primary CTA visible above the fold
 * - Icon is a soft visual anchor, not the message itself
 */
export function EmptyState({ icon, title, meta, action, secondaryAction, padded = true }: Props) {
  return (
    <div
      className="empty"
      style={padded ? undefined : { padding: 0, background: "transparent", border: 0 }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 56,
            height: 56,
            margin: "0 auto var(--s-3)",
            borderRadius: "var(--r-3)",
            background: "var(--blue-soft)",
            color: "var(--blue-deep)",
          }}
        >
          {icon}
        </div>
      )}
      <p className="empty-title">{title}</p>
      {meta && (
        typeof meta === "string"
          ? <p className="empty-meta">{meta}</p>
          : <div className="empty-meta">{meta}</div>
      )}
      {(action || secondaryAction) && (
        <div style={{
          marginTop: "var(--s-5)",
          display: "flex",
          gap: "var(--s-3)",
          justifyContent: "center",
          flexWrap: "wrap",
        }}>
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
