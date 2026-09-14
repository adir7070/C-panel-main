import { EmptyState } from "./EmptyState";

/**
 * Calm "this feature is switched off" panel.
 *
 * The server answers `503 { error: "fb_unavailable" }` for every Meta-backed
 * route while the integration is disabled (see middlewares/fb-gate in the
 * backend). That is a deliberate state, not a failure — so it gets its own
 * muted panel instead of the red error card, and no "try again" button,
 * because retrying cannot help.
 */
export function FeatureUnavailable({
  title = "לא זמין כרגע",
  meta,
}: {
  title?: string;
  meta?: string;
}) {
  return (
    <div
      className="card"
      style={{
        background: "var(--bg-tint)",
        border: "1px dashed var(--rule-strong)",
        padding: "var(--s-6)",
      }}
    >
      <EmptyState
        padded={false}
        icon={
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: 12,
              background: "var(--paper)",
              border: "1px solid var(--rule)",
              color: "var(--ink-3)",
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M5.6 5.6l12.8 12.8" />
            </svg>
          </span>
        }
        title={title}
        meta={meta ?? "חיבור פייסבוק כבוי כרגע. ברגע שהטוקנים של הלקוחות יאוחסנו מחדש, המסך יתחיל לעבוד אוטומטית."}
      />
    </div>
  );
}
