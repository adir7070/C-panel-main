import type { Quote, QuoteBilling } from "../../api/quotes";
import { billingNeedsCard, formatIls, formatQuoteDate, PAYMENT_METHOD_LABEL } from "../../api/quotes";
import { Button } from "../ui/Button";

function formatStamp(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function formatDay(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** One quote in the client's קטלוג אישי: copy the signing link, view the
 *  quote (or the signed copy), edit / delete while it isn't signed. Once
 *  signed: charge it here, or copy the client's link (the same /sign link,
 *  which now offers the payment). Once paid: the monthly billing, which
 *  only admins can stop or resume. */
export function QuoteCard({
  quote, busy, charging, canManageBilling,
  onView, onViewSigned, onCopyLink, onEdit, onDelete,
  onCharge, onCopyPayLink, onStopBilling, onResumeBilling,
}: {
  quote: Quote;
  busy?: boolean;
  charging?: boolean;
  canManageBilling?: boolean;
  onView: () => void;
  onViewSigned: () => void;
  onCopyLink: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCharge: () => void;
  onCopyPayLink: () => void;
  onStopBilling: () => void;
  onResumeBilling: () => void;
}) {
  const t = quote.totals;
  const setupCount = quote.lines.filter(l => l.billing !== "monthly").length;
  const monthlyCount = quote.lines.length - setupCount;
  const hasMonthly = t.monthly.count > 0 && t.monthly.total > 0;
  const names = quote.lines.map(l => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name));
  const signed = quote.signed;
  const locked = !!signed || quote.purchased;
  const payment = quote.payment;
  const suspended = payment?.status === "suspended";
  const paid = quote.purchased && payment?.status === "paid";
  const billing = quote.billing;
  const needsCard = billingNeedsCard(billing);
  const due = !!signed && !quote.purchased && !suspended;
  const firstAmount = t.setup.total + (hasMonthly ? t.monthly.total : 0);

  return (
    <div
      className="card"
      style={{ padding: "var(--s-4) var(--s-5)", borderInlineStart: `3px solid ${needsCard ? "#DC2626" : signed ? "#15803D" : "#0C2347"}`, display: "grid", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>הצעת מחיר {quote.quoteNo}</span>
            {signed && <span className="badge badge-positive">✓ נחתם</span>}
            {paid && <span className="badge badge-positive">✓ שולם</span>}
            {suspended && <span className="badge">ביט בבדיקה</span>}
            {due && <span className="badge" style={{ background: "#FFF3CF", color: "#8A5A00" }}>ממתין לתשלום</span>}
            {quote.purchased && !payment && <span className="badge badge-positive">נרכשה</span>}
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
          {due && <Button size="sm" onClick={onCharge} disabled={busy || charging} loading={charging}>💳 חייב עכשיו</Button>}
          {due && <Button size="sm" variant="ghost" onClick={onCopyPayLink} disabled={busy}>🔗 קישור לתשלום</Button>}
          {needsCard && billing?.status !== "stopped" && (
            <>
              <Button size="sm" onClick={onCopyPayLink} disabled={busy} style={{ background: "#DC2626", borderColor: "#DC2626" }}>🔗 קישור לעדכון כרטיס</Button>
              <Button size="sm" variant="ghost" onClick={onCharge} disabled={busy || charging} loading={charging}>💳 עדכן כרטיס וחייב</Button>
            </>
          )}
          {signed ? (
            <Button size="sm" variant={due ? "ghost" : undefined} onClick={onViewSigned} disabled={busy}
              style={due ? undefined : { background: "#15803D", borderColor: "#15803D" }}>הצג הסכם חתום</Button>
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

      {due && (
        <Strip tone="warn">
          ממתין לתשלום של <strong>{formatIls(firstAmount)}</strong> {hasMonthly ? "(הקמה + חודש ראשון, בכרטיס אשראי — משם חיוב חודשי אוטומטי)" : "(כרטיס, ביט, Apple Pay או Google Pay)"}.
          {" "}"קישור לתשלום" הוא אותו קישור של החתימה — אחרי החתימה הוא מציג ללקוח את התשלום.
        </Strip>
      )}
      {suspended && (
        <Strip tone="warn">
          התקבל תשלום בביט ב-{formatStamp(payment?.at)} שקרדקום מחזיקה כעסקה מושהית. בדקו בקרדקום לפני שמחייבים שוב.
        </Strip>
      )}
      {paid && (
        <Strip tone="ok">
          שולם <strong>{formatIls(payment?.amount ?? firstAmount)}</strong> ב-{formatStamp(payment?.paidAt)}
          {" · "}{PAYMENT_METHOD_LABEL[payment!.method] ?? payment!.method}{payment?.last4 ? ` …${payment.last4}` : ""}
          {payment?.documentNumber ? ` · חשבונית ${payment.documentNumber}` : ""}
          {payment?.via === "client" ? " · שולם על ידי הלקוח מהקישור" : payment?.via === "manager" ? " · חויב מהפאנל" : ""}
        </Strip>
      )}
      {(quote.duplicatePayments?.length ?? 0) > 0 && (
        <Strip tone="bad">⚠️ ההצעה שולמה {1 + quote.duplicatePayments!.length} פעמים — יש לזכות את התשלום הכפול בקרדקום.</Strip>
      )}
      {billing && <BillingStrip billing={billing} canManage={!!canManageBilling} busy={busy} onStop={onStopBilling} onResume={onResumeBilling} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <Amount label="לתשלום בחתימה" value={formatIls(firstAmount)} sub={hasMonthly ? 'הקמה + חודש ראשון, כולל מע"מ' : 'הקמה, כולל מע"מ'} accent />
        <Amount label="תשלום חודשי" value={formatIls(t.monthly.total)} sub={`כולל מע"מ · ${quote.commitMonths} חודשים לפחות`} />
        <Amount label="סה״כ לתקופת ההתחייבות" value={formatIls(t.commitTotal)} sub={`הקמה + ${quote.commitMonths} תשלומים`} />
      </div>
    </div>
  );
}

function BillingStrip({ billing: b, canManage, busy, onStop, onResume }: {
  billing: QuoteBilling; canManage: boolean; busy?: boolean; onStop: () => void; onResume: () => void;
}) {
  const card = b.last4 ? ` · כרטיס …${b.last4}` : "";
  const months = `חויבו ${b.chargesDone} ${b.chargesDone === 1 ? "חודש" : "חודשים"}${b.commitMonths ? ` (התחייבות: ${b.commitMonths})` : ""}`;
  let tone: StripTone = "info";
  let text: React.ReactNode;
  if (b.status === "stopped") {
    text = <>החיוב החודשי נעצר ב-{formatStamp(b.stoppedAt)}{b.stoppedByName ? ` על ידי ${b.stoppedByName}` : ""} · {months}</>;
  } else if (b.status === "past_due") {
    tone = "bad";
    text = <>החיוב החודשי נעצר אחרי {b.maxTries} ניסיונות שנכשלו: <strong>{b.lastError}</strong>. שלחו ללקוח קישור לעדכון כרטיס.</>;
  } else if (b.status === "needs_card") {
    tone = "bad";
    text = <>אין כרטיס שמור לחיוב החודשי — שלחו ללקוח קישור לעדכון כרטיס.</>;
  } else if (b.failedAttempts > 0) {
    tone = "bad";
    text = <>החיוב החודשי נכשל ({b.failedAttempts}/{b.maxTries}): <strong>{b.lastError}</strong>. ניסיון נוסף ב-{formatStamp(b.nextAttemptAt)}{card}.</>;
  } else {
    text = <>חיוב חודשי <strong>{formatIls(b.amount)}</strong> · {months} · החיוב הבא ב-{formatDay(b.nextChargeAt)}{card}</>;
  }
  return (
    <Strip tone={tone}>
      <span style={{ flex: 1 }}>
        {text}
        {!b.live && b.status === "active" && <span style={{ opacity: .75 }}> · מצב בדיקה: החיובים החודשיים עוד לא הופעלו בשרת</span>}
        {b.duplicateCharges > 0 && <strong> · ⚠️ חודש חויב פעמיים — לזכות בקרדקום</strong>}
      </span>
      {canManage && (b.status === "active" || b.status === "past_due" || b.status === "needs_card") && (
        <Button size="sm" variant="ghost" onClick={onStop} disabled={busy}>עצור חיוב חודשי</Button>
      )}
      {canManage && (b.status === "stopped" || b.status === "past_due") && (
        <Button size="sm" variant="ghost" onClick={onResume} disabled={busy}>חדש חיוב חודשי</Button>
      )}
    </Strip>
  );
}

type StripTone = "ok" | "warn" | "bad" | "info";
const STRIP: Record<StripTone, { bg: string; color: string }> = {
  ok: { bg: "#DCF5E6", color: "#14532D" },
  warn: { bg: "#FFF3CF", color: "#8A5A00" },
  bad: { bg: "#FEF2F2", color: "#991B1B" },
  info: { bg: "var(--bg)", color: "var(--ink-2)" },
};

function Strip({ tone, children }: { tone: StripTone; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12, padding: "6px 10px",
      borderRadius: "var(--r-2)", background: STRIP[tone].bg, color: STRIP[tone].color,
    }}>
      {children}
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
