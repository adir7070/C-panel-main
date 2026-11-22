import type { Quote } from "../../api/quotes";
import { formatIls, formatQuoteDate } from "../../api/quotes";
import { Button } from "../ui/Button";

/** One quote in the client's קטלוג אישי. Signing and charging are the next
 *  stage — for now a quote is shown, edited or deleted. */
export function QuoteCard({ quote, busy, onView, onEdit, onDelete }: {
  quote: Quote;
  busy?: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = quote.totals;
  const setupCount = quote.lines.filter(l => l.billing !== "monthly").length;
  const monthlyCount = quote.lines.length - setupCount;
  const names = quote.lines.map(l => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name));

  return (
    <div
      className="card"
      style={{ padding: "var(--s-4) var(--s-5)", borderInlineStart: "3px solid #0C2347", display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>הצעת מחיר {quote.quoteNo}</span>
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
          <Button size="sm" onClick={onView} disabled={busy}>הצג הצעה</Button>
          {!quote.purchased && <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>ערוך</Button>}
          {!quote.purchased && <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>מחק</Button>}
        </div>
      </div>
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
