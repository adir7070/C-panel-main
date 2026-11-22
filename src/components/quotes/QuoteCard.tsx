import type { Quote } from "../../api/quotes";
import { formatIls, formatQuoteDate } from "../../api/quotes";
import { Button } from "../ui/Button";

function formatStamp(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** One quote in the client's קטלוג אישי: copy the signing link, view the
 *  quote (or the signed copy), edit / delete while it isn't signed. */
export function QuoteCard({ quote, busy, onView, onViewSigned, onCopyLink, onEdit, onDelete }: {
  quote: Quote;
  busy?: boolean;
  onView: () => void;
  onViewSigned: () => void;
  onCopyLink: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = quote.totals;
  const setupCount = quote.lines.filter(l => l.billing !== "monthly").length;
  const monthlyCount = quote.lines.length - setupCount;
  const names = quote.lines.map(l => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name));
  const signed = quote.signed;
  const locked = !!signed || quote.purchased;

  return (
    <div
      className="card"
      style={{ padding: "var(--s-4) var(--s-5)", borderInlineStart: `3px solid ${signed ? "#15803D" : "#0C2347"}`, display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>הצעת מחיר {quote.quoteNo}</span>
            {signed && <span className="badge badge-positive">✓ נחתם</span>}
            {quote.purchased && <span className="badge badge-positive">נרכשה</span>}
            <span className="t-meta" style={{ fontSize: 12 }}>
              {formatQuoteDate(quote.quoteDate)} · {setupCount} שירותי הקמה · {monthlyCount} חודשיים · התחייבות {quote.commitMonths} חודשים
              {t.discountPct > 0 ? ` · הנחה ${t.discountPct}%` : ""}
              {quote.agentName ? ` · ${quote.agentName}` : ""}
            </span>
          </div>
          <p className="t-meta" style={{ fontSize: 12, margin: "4px 0 0", overflowWrap: "anywhere" }}>
            {names.slice(0, 8).join(" · ")}{names.length > 8 ? ` ועוד ${names.length - 8}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {signed ? (
            <Button size="sm" onClick={onViewSigned} disabled={busy} style={{ background: "#15803D", borderColor: "#15803D" }}>הצג הסכם חתום</Button>
          ) : (
            <Button size="sm" onClick={onCopyLink} disabled={busy}>🔗 העתק קישור לחתימה</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onView} disabled={busy}>הצג הצעה</Button>
          {!locked && <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>ערוך</Button>}
          {!locked && <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>מחק</Button>}
        </div>
      </div>

      {(signed || quote.signLinkAt) && (
        <div style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, padding: "6px 10px", borderRadius: "var(--r-2)",
          background: signed ? "#DCF5E6" : "var(--bg)", color: signed ? "#14532D" : "var(--ink-2)",
        }}>
          {signed ? (
            <span>
              נחתם ב-{formatStamp(signed.at)} על ידי <strong>{signed.name}</strong>{signed.role ? `, ${signed.role}` : ""} · העותק החתום שמור במערכת
            </span>
          ) : (
            <>
              <span>קישור לחתימה נוצר {formatStamp(quote.signLinkAt)}</span>
              <span>·</span>
              <span>{quote.viewCount ? `הקישור נפתח ${quote.viewCount === 1 ? "פעם אחת" : `${quote.viewCount} פעמים`}, לאחרונה ${formatStamp(quote.lastViewedAt)}` : "הקישור עוד לא נפתח"}</span>
            </>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <Amount label="לתשלום בחתימה" value={formatIls(t.setup.total)} sub='הקמה, כולל מע"מ' accent />
        <Amount label="תשלום חודשי" value={formatIls(t.monthly.total)} sub={`כולל מע"מ · ${quote.commitMonths} חודשים לפחות`} />
        <Amount label="סה״כ לתקופת ההתחייבות" value={formatIls(t.commitTotal)} sub={`הקמה + ${quote.commitMonths} תשלומים`} />
      </div>
    </div>
  );
}

function Amount({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? "#0C2347" : "var(--bg)", color: accent ? "#fff" : "var(--ink)", borderRadius: "var(--r-3)", padding: "8px 12px" }}>
      <div style={{ fontSize: 11, color: accent ? "#C5D6E4" : "var(--ink-3)" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent ? "#F2B63C" : "var(--ink)", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: accent ? "#9FB6CB" : "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}
