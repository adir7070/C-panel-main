import { useCallback, useEffect, useState } from "react";
import {
  getClientPackage,
  getProjectDetail,
  updatePackageStatus,
  type ClientPackage,
  type EditRequest,
  type PackageStatus,
  type ProductItem,
  type ProjectDetail,
} from "../../api/client";
import { forceClientStatus, type AdminPackageStatus } from "../../api/admin";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

interface Props { phone: string   /** Bumped by ClientDetailPage when a purchase lands — refetch in place. */
  refreshKey?: number;
}

/* Display labels + bar colors — mirror the spec table 1:1. */
const STATUS_META: Record<PackageStatus, { label: string; color: string }> = {
  waiting_brief:               { label: "ממתין להשלמת האיפיון",  color: "#667085" },
  sent_to_creation:            { label: "נשלח ליצירה",             color: "#0000B2" },
  waiting_manager_approval:    { label: "ממתין לאישור מנהל התיק", color: "#0000B2" },
  sent_to_client:              { label: "נשלח לאישור הלקוח",       color: "#0000B2" },
  client_returned_corrections: { label: "הלקוח החזיר תיקונים",    color: "#C62828" },
  in_correction:               { label: "בתיקון",                   color: "#C62828" },
  corrections_done:            { label: "הושלמו תיקונים",          color: "#0000B2" },
  corrections_completed:       { label: "הושלמו תיקונים",          color: "#0000B2" },
  client_approved:             { label: "לקוח אישר",                color: "#2E7D32" },
  completed:                   { label: "הסתיים טיפול",             color: "#667085" },
};

/* Manager-driven transitions only. Auto transitions (e.g. AI finished →
   waiting_manager_approval) happen server-side and aren't surfaced here.
   The waiting_brief → sent_to_creation transition is now auto-bumped on
   the first AI generate (see services/package-lifecycle.service.js), so
   no manual button is needed for that step anymore. */
const MANAGER_TRANSITIONS: Record<PackageStatus, { label: string; next: PackageStatus }[]> = {
  waiting_brief:               [],
  sent_to_creation:            [],
  waiting_manager_approval:    [{ label: "אשר ושלח ללקוח",   next: "sent_to_client"  }],
  sent_to_client:              [],
  client_returned_corrections: [{ label: "התחל תיקון",        next: "in_correction"   }],
  in_correction:               [{ label: "תיקונים הושלמו",    next: "corrections_done" }],
  corrections_done:            [{ label: "שלח שוב ללקוח",     next: "sent_to_client"  }],
  corrections_completed:       [{ label: "שלח שוב ללקוח",     next: "sent_to_client"  }],
  client_approved:             [{ label: "סמן כהושלם",        next: "completed"        }],
  completed:                   [],
};

function buildPkgId(pkg: ClientPackage): string {
  /* Mirror server: `pkg_${id || "custom"}_${purchasedAt with [:.] → '-'}` */
  const safeDate = (pkg.purchasedAt || "").replace(/[:.]/g, "-");
  return `pkg_${pkg.id || "custom"}_${safeDate}`;
}

export function PackageStatusBanner({ phone, refreshKey = 0 }: Props) {
  const [pkg,    setPkg]    = useState<ClientPackage | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const toast = useToast();
  const { agent } = useAuth();
  const isAdmin = agent?.role === "admin";

  const reload = useCallback(async () => {
    setError(null);
    try {
      const p = await getClientPackage(phone);
      setPkg(p);
      if (p) {
        const d = await getProjectDetail(phone, buildPkgId(p)).catch(() => null);
        setDetail(d);
      } else {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    }
  }, [phone]);

  useEffect(() => { reload(); }, [reload]);

  /* Purchase for this client: refetch without hiding the banner on a
     transient failure. */
  useEffect(() => {
    if (!refreshKey) return;
    let cancelled = false;
    getClientPackage(phone)
      .then(async p => {
        const d = p ? await getProjectDetail(phone, buildPkgId(p)).catch(() => null) : null;
        if (!cancelled) { setPkg(p); setDetail(d); setError(null); }
      })
      .catch(() => { /* keep the current banner; the next purchase event retries */ });
    return () => { cancelled = true; };
  }, [refreshKey, phone]);

  if (error) return null;
  if (!pkg)  return null;  /* No active package — banner hidden */

  const status = pkg.status || "waiting_brief";
  const meta   = STATUS_META[status];
  const transitions = MANAGER_TRANSITIONS[status];

  async function setStatus(next: PackageStatus, label: string) {
    if (busy || !pkg) return;
    setBusy(true);
    try {
      await updatePackageStatus(phone, buildPkgId(pkg), next);
      setPkg(prev => prev ? { ...prev, status: next } : prev);
      toast.ok(`סטטוס עודכן: ${label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "עדכון סטטוס נכשל");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Compact status STRIP — ~56px, slot under sticky page header.
          The full products breakdown lives in a collapsible region below. */}
      <div
        role="region"
        aria-label="סטטוס חבילה"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          padding: "10px var(--s-5)",
          background: "var(--paper)",
          borderBottom: "1px solid var(--rule)",
          /* Thin colored accent line on the leading edge — RTL-safe via inset. */
          boxShadow: `inset 3px 0 0 0 ${meta.color}`,
          flexWrap: "wrap",
          minHeight: 56,
        }}
      >
        {/* Status dot + label pill */}
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "5px 12px", borderRadius: 99,
          background: meta.color + "15",
          color: meta.color,
          fontSize: "var(--t-sm)", fontWeight: 700,
          whiteSpace: "nowrap",
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 99, background: meta.color,
            boxShadow: `0 0 0 3px ${meta.color}25`,
          }} />
          {meta.label}
        </span>

        {/* Package name — truncates if too long */}
        <span style={{
          fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          flex: "0 1 auto", minWidth: 0, maxWidth: 280,
        }}>
          {pkg.name}
        </span>

        {/* Inline transition button(s) */}
        {transitions.map(t => (
          <Button
            key={t.next}
            size="sm"
            onClick={() => setStatus(t.next, t.label)}
            disabled={busy}
          >
            {busy ? "מעדכן…" : t.label}
          </Button>
        ))}

        {/* Spacer pushes secondary actions to the inline-end edge */}
        <span style={{ flex: 1 }} />

        {/* Toggle products summary */}
        {detail && (
          <button
            type="button"
            onClick={() => setShowDetails(v => !v)}
            aria-expanded={showDetails}
            aria-controls="package-products-summary"
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid var(--rule-strong)",
              background: showDetails ? "var(--bg-tint)" : "transparent",
              color: "var(--ink-2)",
              fontSize: "var(--t-xs)",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "background 150ms var(--ease-out)",
            }}
          >
            {showDetails ? "סגור פירוט" : "פירוט מוצרים"}
          </button>
        )}

        {/* Admin-only force-status escape hatch — kept compact */}
        {isAdmin && (
          <button
            onClick={() => setForceOpen(true)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px dashed var(--negative)",
              background: "transparent",
              color: "var(--negative)",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
            title="כפיית סטטוס בעוקפת whitelist — רק לאדמין"
          >
            כפיית סטטוס
          </button>
        )}
      </div>

      {/* Collapsible products summary — render only when expanded so the
          strip stays a clean 56px on first paint. */}
      {showDetails && detail && (
        <div
          id="package-products-summary"
          style={{
            padding: "var(--s-4) var(--s-5)",
            background: "var(--paper)",
            borderBottom: "1px solid var(--rule)",
          }}
        >
          <ProductsSummary detail={detail} />
        </div>
      )}

      {forceOpen && pkg && (
        <ForceStatusModal
          phone={phone}
          currentStatus={pkg.status || "waiting_brief"}
          onClose={() => setForceOpen(false)}
          onComplete={(newStatus) => {
            setPkg(prev => prev ? { ...prev, status: newStatus } : prev);
            setForceOpen(false);
          }}
        />
      )}
    </>
  );
}

type SummaryRow = {
  label:     string;
  items:     ProjectDetail["ads_sponsored"];
  openLabel: string;
  /* For LP / video / logo — single-item types, just open the first URL.
     For ads / social / carousels — open a gallery modal with all images. */
  singleItem?: boolean;
};

function ProductsSummary({ detail }: { detail: ProjectDetail }) {
  const [galleryRow, setGalleryRow] = useState<SummaryRow | null>(null);

  const rows: SummaryRow[] = [
    { label: "ממומן",      items: detail.ads_sponsored, openLabel: "צפה בתמונות" },
    { label: "סושיאל",     items: detail.ads_social,    openLabel: "צפה בתמונות" },
    { label: "קרוסלות",    items: detail.carousels,     openLabel: "צפה בתמונות" },
    { label: "דף נחיתה",   items: detail.landing_page,  openLabel: "פתח דף",     singleItem: true },
    { label: "וידאו",       items: detail.video,         openLabel: "צפה בסרטון", singleItem: true },
    { label: "לוגו",        items: detail.logo,          openLabel: "צפה בלוגו",  singleItem: true },
  ].filter(r => r.items.length > 0);

  if (rows.length === 0) {
    return (
      <p className="t-meta" style={{
        paddingTop: "var(--s-3)", borderTop: "1px dashed var(--rule)",
      }}>
        אין תוצרים להצגה עדיין.
      </p>
    );
  }

  return (
    <>
      <div style={{
        paddingTop: "var(--s-3)",
        borderTop:  "1px dashed var(--rule)",
        display:    "grid", gap: "var(--s-2)",
      }}>
        {rows.map(r => {
          const rejected = r.items.filter(i => i.status === "rejected").length;
          const approved = r.items.filter(i => i.status === "approved").length;
          const aggLabel =
            rejected > 0                                ? "● נדחה"   :
            approved === r.items.length && approved > 0 ? "✓ מאושר"  :
                                                          "● ממתין";
          const aggColor =
            rejected > 0                                ? "var(--negative)" :
            approved === r.items.length && approved > 0 ? "var(--positive)" :
                                                          "var(--warning)";
          const firstUrl = r.items.find(i => i.imageUrl)?.imageUrl || null;
          const hasAnyUrl = !!firstUrl;

          return (
            <div key={r.label} style={{
              display: "grid",
              gridTemplateColumns: "1fr auto auto auto",
              alignItems: "center",
              gap: "var(--s-3)",
              padding: "8px 0",
            }}>
              <span style={{ fontWeight: 600, color: "var(--ink)" }}>{r.label}</span>
              <span className="t-meta" dir="ltr">{r.items.length}</span>
              <span style={{ fontSize: "var(--t-sm)", color: aggColor, fontWeight: 700 }}>{aggLabel}</span>
              {hasAnyUrl ? (
                r.singleItem ? (
                  <a href={firstUrl!} target="_blank" rel="noreferrer" style={{
                    fontSize: "var(--t-sm)", color: "var(--blue)", textDecoration: "underline",
                  }}>
                    🔗 {r.openLabel}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => setGalleryRow(r)}
                    style={{
                      background: "transparent", border: "none", cursor: "pointer", padding: 0,
                      fontSize: "var(--t-sm)", color: "var(--blue)", textDecoration: "underline",
                    }}
                  >
                    🔗 {r.openLabel} ({r.items.length})
                  </button>
                )
              ) : <span />}
            </div>
          );
        })}
      </div>

      {galleryRow && (
        <ImageGalleryModal
          row={galleryRow}
          onClose={() => setGalleryRow(null)}
        />
      )}
    </>
  );
}

function ImageGalleryModal({ row, onClose }: { row: SummaryRow; onClose: () => void }) {
  /* Two badge levels mirroring the spec:
     - status: server-derived from session.clientApprovalStatus
     - clientStatus: per-item from client app (overrides if present) */
  const STATUS_BADGE: Record<string, { bg: string; color: string; label: string }> = {
    pending:  { bg: "#9699A615", color: "#5C5F66", label: "⬜ ממתין לתגובת לקוח" },
    approved: { bg: "#2E7D3215", color: "#2E7D32", label: "✅ אושר על ידי הלקוח" },
    rejected: { bg: "#E5393515", color: "#E53935", label: "❌ נדחה על ידי הלקוח" },
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(11,20,48,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "var(--s-5)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--paper)", borderRadius: 12, maxWidth: 1100, maxHeight: "90vh",
          width: "100%", display: "flex", flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "var(--s-4) var(--s-5)", borderBottom: "1px solid var(--rule)",
        }}>
          <div>
            <p className="t-eyebrow">גלריה</p>
            <h3 className="t-section" style={{ marginTop: 4 }}>
              {row.label} · {row.items.length} תוצרים
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent", border: "none", fontSize: 22,
              color: "var(--ink-3)", cursor: "pointer", padding: "4px 8px",
            }}
            aria-label="סגור"
          >×</button>
        </div>

        <div style={{
          padding: "var(--s-5)", overflowY: "auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: "var(--s-4)",
        }}>
          {row.items.map(it => <ItemCard key={it.id} item={it} statusBadgeMap={STATUS_BADGE} />)}
        </div>
      </div>
    </div>
  );
}

/* Per-item card with status badge + edit-request history accordion.
   Spec: CPANEL-EDIT-TRACKING-SPEC.md sec 3. */
function ItemCard({
  item,
  statusBadgeMap,
}: {
  item: ProductItem;
  statusBadgeMap: Record<string, { bg: string; color: string; label: string }>;
}) {
  const [expanded, setExpanded] = useState(false);

  /* clientStatus from spec wins; fallback to legacy status. */
  const effectiveStatus = item.clientStatus || item.status || "pending";
  const badge = statusBadgeMap[effectiveStatus] || statusBadgeMap.pending;
  const editCount = item.editCount || 0;
  const editRequests = item.editRequests || [];

  return (
    <div style={{
      border: "1px solid var(--rule)", borderRadius: 8, overflow: "hidden",
      background: "var(--bg-tint)",
      display: "flex", flexDirection: "column",
    }}>
      <a
        href={item.imageUrl || "#"}
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none", color: "inherit", display: "block" }}
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{
            width: "100%", aspectRatio: "1/1",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ink-3)", fontSize: 12,
          }}>אין תמונה</div>
        )}
      </a>

      <div style={{ padding: "8px 10px", display: "grid", gap: 6 }}>
        {item.headline && (
          <p style={{
            fontSize: 12, fontWeight: 600, color: "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{item.headline}</p>
        )}

        <span style={{
          display: "inline-block", padding: "2px 8px", borderRadius: 99,
          background: badge.bg, color: badge.color,
          fontSize: 11, fontWeight: 700, alignSelf: "start",
        }}>{badge.label}</span>

        {editCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              padding: 0, textAlign: "start",
              fontSize: 11, color: "var(--blue)", fontWeight: 700,
            }}
          >
            ✎ {editCount} בקש{editCount === 1 ? "ה" : "ות"} עריכה {expanded ? "▴" : "▾"}
          </button>
        )}

        {expanded && editRequests.length > 0 && (
          <EditHistoryList requests={editRequests} />
        )}
      </div>
    </div>
  );
}

function EditHistoryList({ requests }: { requests: EditRequest[] }) {
  return (
    <div style={{
      paddingTop: 6, borderTop: "1px dashed var(--rule)",
      display: "grid", gap: 8,
    }}>
      {requests.slice().reverse().map((r, idx) => {
        const date = formatEditDate(r.requestedAt);
        const ins = r.instructions || {};
        const parsed = safeParseJson(r.geminiResult);
        return (
          <div key={idx} style={{
            background: "var(--paper)", borderRadius: 6, padding: "6px 8px",
            fontSize: 11, color: "var(--ink-2)",
          }}>
            <div style={{ fontWeight: 700, color: "var(--ink-3)", marginBottom: 4 }}>📅 {date}</div>
            {ins.title    && <div>כותרת: <span style={{ color: "var(--ink)" }}>"{ins.title}"</span></div>}
            {ins.subtitle && <div>תת כותרת: <span style={{ color: "var(--ink)" }}>"{ins.subtitle}"</span></div>}
            {ins.cta      && <div>CTA: <span style={{ color: "var(--ink)" }}>"{ins.cta}"</span></div>}
            {ins.image    && <div>תמונה: <span style={{ color: "var(--ink)" }}>"{ins.image}"</span></div>}
            {parsed && (
              <div style={{ marginTop: 4, padding: 4, background: "var(--bg-tint)", borderRadius: 4 }}>
                <span style={{ color: "var(--ink-3)" }}>↳ Gemini:</span>{" "}
                {parsed.headline && <span>"{parsed.headline}"</span>}
                {parsed.cta      && <span> · CTA "{parsed.cta}"</span>}
              </div>
            )}
            {r.newImageUrl && (
              <a href={r.newImageUrl} target="_blank" rel="noreferrer" style={{
                display: "inline-block", marginTop: 4,
                color: "var(--blue)", textDecoration: "underline", fontSize: 10,
              }}>↳ תמונה חדשה</a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatEditDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function safeParseJson(text: string | null | undefined): { headline?: string; subtitle?: string; cta?: string; imageNote?: string } | null {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

/* Admin-only force-status override. Bypasses the manager whitelist and
   requires a typed reason. Audit-logged on the server side. */
function ForceStatusModal({
  phone, currentStatus, onClose, onComplete,
}: {
  phone: string;
  currentStatus: string;
  onClose: () => void;
  onComplete: (newStatus: AdminPackageStatus) => void;
}) {
  const ADMIN_STATUSES: AdminPackageStatus[] = [
    "waiting_brief",
    "sent_to_creation",
    "waiting_manager_approval",
    "sent_to_client",
    "client_returned_corrections",
    "in_correction",
    "corrections_completed",
    "corrections_done",
    "client_approved",
    "completed",
  ];
  const STATUS_LABELS: Record<AdminPackageStatus, string> = {
    waiting_brief:               "ממתין להשלמת האיפיון",
    sent_to_creation:            "נשלח ליצירה",
    waiting_manager_approval:    "ממתין לאישור מנהל התיק",
    sent_to_client:              "נשלח לאישור הלקוח",
    client_returned_corrections: "הלקוח החזיר תיקונים",
    in_correction:               "בתיקון",
    corrections_completed:       "הושלמו תיקונים (חדש)",
    corrections_done:            "הושלמו תיקונים (קיים)",
    client_approved:             "לקוח אישר",
    completed:                   "הסתיים טיפול",
  };

  const [next, setNext]     = useState<AdminPackageStatus>(currentStatus as AdminPackageStatus);
  const [reason, setReason] = useState("");
  const [busy, setBusy]     = useState(false);
  const toast = useToast();

  async function submit() {
    if (!reason.trim()) { toast.error("חובה למלא סיבה — תיכתב ל-audit log"); return; }
    if (next === currentStatus) { toast.error("בחר סטטוס שונה מהנוכחי"); return; }
    const ok = window.confirm(
      `כפיית סטטוס: "${STATUS_LABELS[currentStatus as AdminPackageStatus] || currentStatus}" → "${STATUS_LABELS[next]}"?\n\n` +
      `הפעולה תיכתב ל-audit log עם הסיבה.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await forceClientStatus(phone, next, reason.trim());
      toast.ok(`סטטוס שונה ל-${STATUS_LABELS[next]}`);
      onComplete(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "כפיית סטטוס נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="🚨 כפיית סטטוס (אדמין בלבד)">
      <div style={{ display: "grid", gap: 14, padding: "var(--s-5)", minWidth: 480, maxWidth: 600 }}>
        <div style={{
          padding: "10px 12px",
          background: "#FEF3C7",
          border: "1px solid #FBBF24",
          borderRadius: 6,
          fontSize: 12,
          color: "#92400E",
        }}>
          ⚠️ פעולה זו עוקפת את ה-whitelist של מעברים תקפים. השתמש רק במצבי חירום או תיקון תקלות.
        </div>

        <div style={{ fontSize: 13 }}>
          <span className="t-meta">סטטוס נוכחי: </span>
          <strong>{currentStatus}</strong>
        </div>

        <div>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>סטטוס חדש</label>
          <select
            value={next}
            onChange={e => setNext(e.target.value as AdminPackageStatus)}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: "1px solid var(--rule)", background: "var(--paper)",
              fontSize: 13, color: "var(--ink)",
            }}
          >
            {ADMIN_STATUSES.map(s => (
              <option key={s} value={s} disabled={s === currentStatus}>
                {STATUS_LABELS[s]} {s === currentStatus ? "(נוכחי)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>
            סיבה (חובה — נכתבת ל-audit log)
          </label>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="למה אתה כופה את הסטטוס? (תקלה, שינוי ידני בעקבות תקלה בתשלום, וכו')"
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: "1px solid var(--rule)", background: "var(--paper)",
              fontSize: 13, color: "var(--ink)",
              resize: "vertical", fontFamily: "inherit",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
          <Button onClick={onClose} variant="ghost">ביטול</Button>
          <Button
            onClick={submit}
            disabled={busy || !reason.trim() || next === currentStatus}
            variant="danger"
          >
            {busy ? "מעדכן…" : "🚨 כפה סטטוס"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
