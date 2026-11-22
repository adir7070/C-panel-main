import type { ReactNode } from "react";
import {
  LEAD_STATUSES, LEAD_STATUS_LABEL, LEAD_STATUS_COLOR, formatLeadDate, waLink,
  type LeadAnswer, type LeadNote, type LeadStatus, type LeadStatusChange,
} from "../../api/leads";

/* Building blocks shared by the leads table (LeadsPage), the lead screen
   (LeadDetailPage) and the "מקור הליד" card on the client page. */

export function PhoneLinks({ phone }: { phone: string }) {
  if (!phone) return <span className="t-meta">—</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <a href={`tel:${phone}`} dir="ltr" className="num" style={{ fontSize: 12, color: "var(--ink)", textDecoration: "none" }}>{phone}</a>
      <a
        href={waLink(phone)}
        target="_blank"
        rel="noreferrer"
        title="פתח WhatsApp"
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 22, height: 22, borderRadius: 99, background: "#25D366", color: "#fff",
          fontSize: 11, fontWeight: 800, textDecoration: "none",
        }}
      >W</a>
    </span>
  );
}

export function StatusSelect({ value, onChange, disabled }: { value: LeadStatus; onChange: (s: LeadStatus) => void; disabled?: boolean }) {
  const color = LEAD_STATUS_COLOR[value];
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value as LeadStatus)}
      style={{
        padding: "4px 8px", borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: "pointer",
        border: `1.5px solid ${color}`, color, background: `${color}12`,
      }}
    >
      {LEAD_STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
    </select>
  );
}

/** Row of status buttons — the current one filled. */
export function StatusButtons({ value, disabled, onPick }: { value: LeadStatus; disabled?: boolean; onPick: (s: LeadStatus) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {LEAD_STATUSES.map(s => {
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => !active && onPick(s)}
            style={{
              padding: "6px 12px", borderRadius: 99, cursor: active ? "default" : "pointer",
              border: `1.5px solid ${LEAD_STATUS_COLOR[s]}`,
              background: active ? LEAD_STATUS_COLOR[s] : "transparent",
              color: active ? "#fff" : LEAD_STATUS_COLOR[s],
              fontSize: 12, fontWeight: 700,
            }}
          >
            {LEAD_STATUS_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}

export function StatusBadge({ status }: { status: LeadStatus }) {
  const color = LEAD_STATUS_COLOR[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px", borderRadius: 99,
      border: `1.5px solid ${color}`, color, background: `${color}12`, fontSize: 12, fontWeight: 700,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />
      {LEAD_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p className="t-eyebrow" style={{ marginBottom: 2 }}>{label}</p>
      <div style={{ color: "var(--ink)", fontSize: 13, overflowWrap: "anywhere" }}>{children}</div>
    </div>
  );
}

/** Titled card used for every block on the lead screen. */
export function LeadCard({ title, count, action, children, accent }: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  accent?: string;
}) {
  return (
    <section
      className="card"
      style={{ padding: "var(--s-4) var(--s-5)", display: "grid", gap: "var(--s-3)", alignContent: "start", minWidth: 0, ...(accent ? { borderTop: `3px solid ${accent}` } : {}) }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{title}</h3>
        {count !== undefined && <span className="t-meta num" style={{ fontSize: 12 }}>· {count}</span>}
        {action && <div style={{ marginInlineStart: "auto" }}>{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** The intake questionnaire — question above, answer below. */
export function LeadAnswersList({ answers, compact = false }: { answers: LeadAnswer[]; compact?: boolean }) {
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid" }}>
      {answers.map((a, i) => (
        <li
          key={i}
          style={{
            padding: compact ? "8px 0" : "10px 0",
            borderTop: i === 0 ? "none" : "1px solid var(--rule)",
            display: "grid", gap: 3,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>{a.question}</span>
          <span style={{ fontSize: compact ? 13 : 14, color: "var(--ink)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{a.answer}</span>
        </li>
      ))}
    </ol>
  );
}

/** Notes, newest first. */
export function LeadNotesList({ notes, limit }: { notes: LeadNote[]; limit?: number }) {
  const ordered = [...notes].reverse();
  const shown = limit ? ordered.slice(0, limit) : ordered;
  if (shown.length === 0) return <p className="t-meta" style={{ margin: 0 }}>אין הערות עדיין.</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {shown.map(n => (
        <div key={n.id} style={{ padding: "var(--s-3)", background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <p className="t-meta" style={{ fontSize: 11, margin: "0 0 4px" }}>
            <strong style={{ color: "var(--ink)" }}>{n.byName}</strong> · {formatLeadDate(n.at)}
          </p>
          <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0, overflowWrap: "anywhere" }}>{n.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Status changes, newest first. */
export function LeadHistoryList({ history, limit }: { history: LeadStatusChange[]; limit?: number }) {
  const ordered = [...history].reverse();
  const shown = limit ? ordered.slice(0, limit) : ordered;
  if (shown.length === 0) return <p className="t-meta" style={{ margin: 0 }}>הסטטוס לא שונה מאז שהליד נכנס.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
      {shown.map((h, i) => (
        <li key={i} className="t-meta" style={{ fontSize: 12 }}>
          <span className="num">{formatLeadDate(h.at)}</span> · {h.byName || "מערכת"}:{" "}
          {LEAD_STATUS_LABEL[h.from] ?? h.from} ←{" "}
          <strong style={{ color: LEAD_STATUS_COLOR[h.to] }}>{LEAD_STATUS_LABEL[h.to] ?? h.to}</strong>
        </li>
      ))}
    </ul>
  );
}
