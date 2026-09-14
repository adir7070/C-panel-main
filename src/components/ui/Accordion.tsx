import { useState, type ReactNode } from "react";

interface Props {
  eyebrow?: string;
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  badge?: ReactNode;
  children: ReactNode;
}

export function Accordion({ eyebrow, title, meta, defaultOpen = false, open: ctrlOpen, onToggle, badge, children }: Props) {
  const [internal, setInternal] = useState(defaultOpen);
  const open = ctrlOpen ?? internal;
  const toggle = () => {
    const next = !open;
    if (ctrlOpen === undefined) setInternal(next);
    onToggle?.(next);
  };

  return (
    <section
      className="section"
      style={{
        marginTop: 0,
        padding: 0,
        overflow: "hidden",
        borderRadius: "var(--r-3)",
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          padding: "var(--s-5) var(--s-6)",
          background: open ? "var(--surface)" : "var(--paper)",
          border: "none",
          borderBottom: open ? "1px solid var(--rule)" : "none",
          cursor: "pointer",
          textAlign: "right",
          font: "inherit",
          color: "inherit",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          {eyebrow && <span className="t-eyebrow">{eyebrow}</span>}
          <span className="t-section" style={{ fontSize: 18, lineHeight: 1.2 }}>{title}</span>
          {meta && <span className="t-meta" style={{ fontSize: 12 }}>{meta}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          {badge}
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28, height: 28,
              borderRadius: "50%",
              background: open ? "var(--blue)" : "var(--bg-tint)",
              color: open ? "#fff" : "var(--ink-2)",
              fontSize: 14,
              fontWeight: 800,
              transition: "transform .2s",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
            }}
          >
            ▾
          </span>
        </div>
      </button>
      {open && (
        <div style={{ padding: "var(--s-6)" }}>
          {children}
        </div>
      )}
    </section>
  );
}
