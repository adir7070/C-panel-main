import type { ReactNode } from "react";

interface Props {
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

export function Field({ label, hint, error, required, children }: Props) {
  return (
    <div className="field">
      {label && (
        <label className="field-label">
          {label}
          {required && <span style={{ color: "var(--negative)", marginInlineStart: 4 }}>·</span>}
        </label>
      )}
      {children}
      {error ? <span className="field-error">{error}</span>
        : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
