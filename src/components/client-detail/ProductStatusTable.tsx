import { useCallback, useEffect, useState } from "react";
import {
  getProductStatuses,
  sendProductToClient,
  type ProductStatus,
  type ProductStatusEntry,
  type ProductType,
} from "../../api/client";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";

/* The full product matrix this panel can render. Only rows whose
   underlying quota in the active package is > 0 actually show up — see
   the filter in the component below. Listing them inline keeps the
   mapping between product type → quota fields in one place. */
interface PackageItemsLike {
  paidAds?:         number;
  organicAds?:      number;
  lps?:             number;
  campaignTraffic?: number;
  campaignLeads?:   number;
}

interface Props {
  phone: string;
  clientName?: string;
  /** Quotas from the active ClientPackage — drives which rows render.
   *  Optional: when omitted, all rows render (legacy callers / global views). */
  items?: PackageItemsLike;
}

interface Row {
  type:  ProductType;
  icon:  string;
  label: string;
  /** True when this row's product is actually included in the active
   *  package — used to filter the matrix down to what the manager
   *  actually has to deliver. */
  hasQuota: (items: PackageItemsLike) => boolean;
}

const ROWS: Row[] = [
  {
    type: "ads",  icon: "📣", label: "מודעות ממומנות",
    hasQuota: i => (i.paidAds ?? 0) > 0 || (i.campaignTraffic ?? 0) > 0 || (i.campaignLeads ?? 0) > 0,
  },
  {
    type: "organic", icon: "📱", label: "פוסטים אורגניים",
    hasQuota: i => (i.organicAds ?? 0) > 0,
  },
  {
    type: "lp",   icon: "🌐", label: "דף נחיתה",
    hasQuota: i => (i.lps ?? 0) > 0,
  },
];

const STATUS_META: Record<ProductStatus, { label: string; color: string; bg: string; pulse?: boolean }> = {
  pending_characterization:    { label: "מוכן לייצור — לחץ \"ייצר\" בחבילה הפעילה", color: "#5C5F66", bg: "#9699A615" },
  sent_for_creation:           { label: "נשלח ליצירה",             color: "#1E88E5", bg: "#1E88E515", pulse: true },
  pending_manager_approval:    { label: "ממתין לאישור מנהל התיק", color: "#FB8C00", bg: "#FB8C0015" },
  sent_to_client:              { label: "נשלח לאישור הלקוח",       color: "#0000B2", bg: "#0000B215" },
  client_returned_corrections: { label: "הלקוח החזיר תיקונים",    color: "#E53935", bg: "#E5393515" },
  in_correction:               { label: "בתיקון",                   color: "#D84315", bg: "#D8431515" },
  corrections_completed:       { label: "הושלמו תיקונים",           color: "#7B1FA2", bg: "#7B1FA215" },
  client_approved:             { label: "לקוח אישר ✓",              color: "#2E7D32", bg: "#2E7D3215" },
  completed:                   { label: "הסתיים טיפול ✓",           color: "#1B5E20", bg: "#1B5E2015" },
};

export function ProductStatusTable({ phone, clientName, items }: Props) {
  /* Filter the row matrix to products that are actually in this client's
     package. When `items` is undefined we render all rows (legacy / admin
     view that isn't bound to a specific package). Quota=0 rows would just
     confuse the manager — they'd sit on "pending_characterization"
     forever because no pipeline will ever fire for them. */
  const visibleRows = items ? ROWS.filter(r => r.hasQuota(items)) : ROWS;
  const [statuses, setStatuses] = useState<{ ads: ProductStatusEntry; organic: ProductStatusEntry; lp: ProductStatusEntry } | null>(null);
  const [busy, setBusy] = useState<ProductType | null>(null);
  const toast = useToast();

  const reload = useCallback(async () => {
    try {
      const r = await getProductStatuses(phone);
      setStatuses(r);
    } catch { /* silent — non-critical */ }
  }, [phone]);

  /* Refresh strategy:
     - on mount + when phone changes
     - poll every 10s (catches AI pipeline transitions live)
     - on tab focus (catches changes that happened while another tab was open)
   */
  useEffect(() => {
    reload();
    const interval = window.setInterval(reload, 10_000);
    const onFocus  = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  async function handleSend(type: ProductType) {
    const labels: Record<ProductType, string> = { ads: "המודעות הממומנות", organic: "הפוסטים האורגניים", lp: "דף הנחיתה" };
    const ok = window.confirm(`לשלוח את ${labels[type]} ל${clientName || "לקוח"} לאישור?`);
    if (!ok) return;
    setBusy(type);
    try {
      const r = await sendProductToClient(phone, type);
      toast.ok(r.pushSent ? "נשלח ללקוח + התראה נשלחה" : "נשלח ללקוח (בלי התראת push)");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שליחה נכשלה");
    } finally {
      setBusy(null);
    }
  }

  if (!statuses) return null;
  /* All visible products filtered out (e.g. legacy package with no
     paidAds/organicAds/lps fields). Don't render an empty card. */
  if (visibleRows.length === 0) return null;

  return (
    <section className="section" style={{ marginTop: 0 }}>
      <div className="card" style={{
        padding: "var(--s-4) var(--s-5)",
        borderTop: "3px solid var(--blue)",
        display: "grid", gap: "var(--s-3)",
      }}>
        <div>
          <p className="t-eyebrow">סטטוס מוצרים</p>
          <h3 className="t-section" style={{ marginTop: 4 }}>מצב כל מוצר בתהליך</h3>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          {visibleRows.map(row => {
            const entry = statuses[row.type];
            const meta  = STATUS_META[entry.productStatus];
            /* Approval progress override — when pending_manager_approval
               but every per-item managerApprovedAt is set, swap the
               badge text + color to "✓ אושר על ידי מנהל" so the manager
               sees their approval clicks reflected at the status level.
               Falls back to the raw STATUS_META label when no approval
               info is available (lp sessions, legacy sessions). */
            const ap = entry.approval;
            const allApproved = ap && ap.total > 0 && ap.approved === ap.total;
            const someApproved = ap && ap.total > 0 && ap.approved > 0 && ap.approved < ap.total;
            const displayLabel =
              entry.productStatus === "pending_manager_approval" && allApproved
                ? "אושר על ידי מנהל ✓ — מוכן לשליחה"
                : entry.productStatus === "pending_manager_approval" && someApproved
                  ? `${meta.label} (${ap!.approved}/${ap!.total})`
                  : meta.label;
            const displayColor = allApproved && entry.productStatus === "pending_manager_approval"
              ? "#2E7D32"   /* green — matches client_approved */
              : meta.color;
            const displayBg = allApproved && entry.productStatus === "pending_manager_approval"
              ? "#2E7D3215"
              : meta.bg;
            const canSend = entry.productStatus === "pending_manager_approval";

            return (
              <div key={row.type} style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto",
                alignItems: "center",
                gap: "var(--s-3)",
                padding: "10px 12px",
                background: "var(--bg-tint)",
                border: "1px solid var(--rule)",
                borderRadius: 8,
              }}>
                <span style={{ fontSize: 20 }}>{row.icon}</span>

                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{row.label}</div>
                  {!entry.sessionExists && (
                    <div className="t-meta" style={{ fontSize: 11 }}>טרם נוצרו תוצרים</div>
                  )}
                </div>

                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 12px", borderRadius: 99,
                  background: displayBg,
                  border: `1px solid ${displayColor}40`,
                  color: displayColor,
                  fontSize: 12, fontWeight: 700,
                  whiteSpace: "nowrap",
                }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: 99, background: displayColor,
                    animation: meta.pulse ? "taskBlink 1.4s ease-in-out infinite" : undefined,
                  }} />
                  {displayLabel}
                </span>

                <div style={{ minWidth: 120, textAlign: "left" }}>
                  {canSend ? (
                    <Button
                      onClick={() => handleSend(row.type)}
                      disabled={busy === row.type}
                      size="sm"
                    >
                      {busy === row.type ? "שולח…" : "שלח ללקוח ▶"}
                    </Button>
                  ) : (
                    <span />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
