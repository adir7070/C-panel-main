import { useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Badge } from "../../components/ui/Badge";
import { listAdminClients, deleteAdminClient, type AdminClientRow } from "../../api/admin";
import { useToast } from "../../context/ToastContext";
import { usePurchaseSync } from "../../hooks/usePurchaseSync";

const PACKAGE_STATUS_LABELS: Record<string, string> = {
  waiting_brief:               "ממתין לאיפיון",
  sent_to_creation:            "נשלח ליצירה",
  waiting_manager_approval:    "ממתין לאישור מנהל",
  sent_to_client:              "נשלח ללקוח",
  client_returned_corrections: "החזיר תיקונים",
  in_correction:               "בתיקון",
  corrections_done:            "תיקונים הושלמו",
  client_approved:             "לקוח אישר",
  completed:                   "הסתיים",
};

const PACKAGE_STATUS_COLOR: Record<string, string> = {
  waiting_brief:               "#5C5F66",
  sent_to_creation:            "#1E88E5",
  waiting_manager_approval:    "#FB8C00",
  sent_to_client:              "#0000B2",
  client_returned_corrections: "#E53935",
  in_correction:               "#D84315",
  corrections_done:            "#7B1FA2",
  client_approved:             "#2E7D32",
  completed:                   "#1B5E20",
};

function formatIls(n: number): string {
  return new Intl.NumberFormat("he-IL", {
    style: "currency", currency: "ILS", maximumFractionDigits: 0,
  }).format(n || 0);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return "היום";
  if (diffDays === 1) return "אתמול";
  if (diffDays < 7)   return `לפני ${diffDays} ימים`;
  if (diffDays < 30)  return `לפני ${Math.floor(diffDays / 7)} שבועות`;
  return d.toLocaleDateString("he-IL");
}

export function AdminClientsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [rows,    setRows]    = useState<AdminClientRow[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  /* Delete-client modal — null = closed. Holds the row being deleted so the
     modal can show its name/phone and the typed-confirmation field can be
     compared against the live row data. */
  const [deleteTarget, setDeleteTarget] = useState<AdminClientRow | null>(null);

  /* Filters */
  const [search,        setSearch]        = useState("");
  const [debouncedQ,    setDebouncedQ]    = useState("");
  const [statusFilter,  setStatusFilter]  = useState<string>("");
  const [tierFilter,    setTierFilter]    = useState<string>("");
  const [managerFilter, setManagerFilter] = useState<string>("");

  /* Reload the list whenever the debounced search value changes (search is
     server-side). Without a query we just load the default page (cheap). */
  /* Debounce the typed text into a SEPARATE state. Below 2 chars the effective
     query is "" (default list). Because we debounce into its own state, typing
     a single letter leaves the effective query unchanged ("") → the fetch
     effect below never re-runs → NO loading flash on one keystroke. */
  useEffect(() => {
    const raw = search.trim();
    const effective = raw.length >= 2 ? raw : "";
    const handle = window.setTimeout(() => setDebouncedQ(effective), effective ? 600 : 300);
    return () => window.clearTimeout(handle);
  }, [search]);

  /* A purchase anywhere refreshes the table in place (no spinner) so the
     package / status / revenue columns follow the charge. */
  const silentRefresh = useRef(false);
  const loadedRef = useRef(false); // silent only once a table has loaded
  const [syncTick, setSyncTick] = useState(0);
  usePurchaseSync(() => { silentRefresh.current = true; setSyncTick(t => t + 1); });

  /* Fetch when the effective (debounced) query changes or a purchase lands. */
  useEffect(() => {
    let cancelled = false;
    const silent = silentRefresh.current && loadedRef.current;
    silentRefresh.current = false;
    if (!silent) { setLoading(true); setError(null); }
    listAdminClients({ limit: 500, search: debouncedQ || undefined })
      .then(r => { if (!cancelled) { loadedRef.current = true; setRows(r.clients); setTotal(r.total); setError(null); } })
      // a failed background refresh keeps the table that is already showing
      .catch(err => { if (!cancelled && !silent) setError(err instanceof Error ? err.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQ, syncTick]);

  const visible = useMemo(() => {
    /* Search is server-side. Locally we only apply the dropdown filters. */
    return rows.filter(r => {
      if (statusFilter  && r.packageStatus !== statusFilter)  return false;
      if (tierFilter    && r.tier          !== tierFilter)    return false;
      if (managerFilter && r.managerName !== managerFilter)   return false;
      return true;
    });
  }, [rows, statusFilter, tierFilter, managerFilter]);

  /* Distinct values for filter dropdowns. */
  const managerOptions = useMemo(() => [...new Set(rows.map(r => r.managerName).filter(n => n && n !== "—"))].sort(), [rows]);
  const tierOptions    = useMemo(() => [...new Set(rows.map(r => r.tier).filter(Boolean))].sort(), [rows]);
  const statusOptions  = useMemo(() => [...new Set(rows.map(r => r.packageStatus).filter((s): s is string => !!s))].sort(), [rows]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="כל הלקוחות"
          meta={`${visible.length} מתוך ${total}`}
        />
      }
    >
      {loading && <Spinner label="טוען לקוחות" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !error && (
        <>
          {/* Filter bar */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr repeat(3, minmax(140px, auto))",
              gap: 8, alignItems: "center",
            }}>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="חיפוש: שם / טלפון / מנהל / חבילה…"
                style={{
                  padding: "8px 12px", borderRadius: 8,
                  border: "1px solid var(--rule)", background: "var(--paper)",
                  fontSize: 13,
                }}
              />
              <FilterSelect value={managerFilter} onChange={setManagerFilter} placeholder="כל המנהלים" options={managerOptions} />
              <FilterSelect value={statusFilter}  onChange={setStatusFilter}  placeholder="כל הסטטוסים" options={statusOptions.map(s => ({ value: s, label: PACKAGE_STATUS_LABELS[s] || s }))} />
              <FilterSelect value={tierFilter}    onChange={setTierFilter}    placeholder="כל הרמות"    options={tierOptions} />
            </div>
            {(search || managerFilter || statusFilter || tierFilter) && (
              <button
                onClick={() => { setSearch(""); setManagerFilter(""); setStatusFilter(""); setTierFilter(""); }}
                style={{
                  marginTop: 6, background: "transparent", border: "none",
                  color: "var(--blue)", textDecoration: "underline",
                  fontSize: 11, cursor: "pointer", padding: 0,
                }}
              >נקה פילטרים</button>
            )}
          </section>

          {/* Table */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div className="card" style={{ padding: 0, borderTop: "3px solid #E53935", overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: "var(--bg-tint)" }}>
                    <Th>שם</Th>
                    <Th>טלפון</Th>
                    <Th>מנהל</Th>
                    <Th>חבילה</Th>
                    <Th>סטטוס</Th>
                    <Th align="left">הוצאה</Th>
                    <Th align="left">עסקאות</Th>
                    <Th>פעילות</Th>
                    <Th>רמה</Th>
                    <Th>כרטיס</Th>
                    <Th>מחיקה</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => {
                    const statusColor = r.packageStatus ? PACKAGE_STATUS_COLOR[r.packageStatus] : null;
                    const statusLabel = r.packageStatus ? PACKAGE_STATUS_LABELS[r.packageStatus] || r.packageStatus : null;
                    return (
                      <tr
                        key={r.phone}
                        onClick={() => navigate(`/clients/${encodeURIComponent(r.phone)}`)}
                        style={{
                          borderTop: "1px solid var(--rule)",
                          cursor: "pointer", transition: "background 80ms",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tint)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <Td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {r.logoUrl && (
                              <img src={r.logoUrl} alt="" style={{ width: 24, height: 24, borderRadius: 4, objectFit: "cover" }} />
                            )}
                            <span style={{ fontWeight: 600, color: "var(--ink)" }}>{r.name}</span>
                          </div>
                        </Td>
                        <Td><span dir="ltr" className="num" style={{ fontSize: 11, color: "var(--ink-2)" }}>{r.phone}</span></Td>
                        <Td><span style={{ fontSize: 12 }}>{r.managerName}</span></Td>
                        <Td>
                          {r.packageName
                            ? <span style={{ fontSize: 12, color: "var(--ink)" }}>{r.packageName}</span>
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td>
                          {statusLabel && statusColor
                            ? (
                              <span style={{
                                display: "inline-flex", alignItems: "center", gap: 6,
                                padding: "3px 10px", borderRadius: 99,
                                background: statusColor + "1a",
                                color: statusColor,
                                fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
                              }}>
                                <span style={{ width: 6, height: 6, borderRadius: 99, background: statusColor }} />
                                {statusLabel}
                              </span>
                            )
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td align="left">
                          {r.revenue > 0
                            ? <span className="num" dir="ltr" style={{ fontWeight: 700, color: "var(--ink)" }}>{formatIls(r.revenue)}</span>
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td align="left">
                          {r.deals > 0
                            ? <span className="num" dir="ltr">{r.deals}</span>
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td><span style={{ fontSize: 11, color: "var(--ink-3)" }}>{relativeTime(r.lastDealAt || r.lastChatAt)}</span></Td>
                        <Td><span style={{ fontSize: 11, color: "var(--ink-2)" }}>{r.tier}</span></Td>
                        <Td>
                          {r.hasPaymentToken
                            ? <Badge variant="positive">שמור</Badge>
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td>
                          <button
                            onClick={e => { e.stopPropagation(); setDeleteTarget(r); }}
                            title="מחיקת לקוח"
                            style={{
                              background: "transparent",
                              border: "1px solid #E53935",
                              color: "#E53935",
                              borderRadius: 6,
                              padding: "4px 10px",
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >מחיקה</button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visible.length === 0 && (
                <div style={{ padding: 40, textAlign: "center", color: "var(--ink-3)" }}>
                  אין תוצאות להצגה
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {deleteTarget && (
        <DeleteClientModal
          row={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setRows(prev => prev.filter(r => r.phone !== deleteTarget.phone));
            setTotal(t => Math.max(0, t - 1));
            setDeleteTarget(null);
            toast.ok("הלקוח נמחק");
          }}
          onError={msg => toast.error(msg)}
        />
      )}
    </Layout>
  );
}

/* ── Delete-client modal ───────────────────────────────────────────────
   Two-step safety:
     1. Admin types a reason (required, audit-logged).
     2. Admin types the client's exact name OR phone — we only enable
        the destructive button once the typed value matches.
   The server re-validates the name/phone match, so even if someone
   bypasses the disabled state, the server still rejects mismatches. */
function DeleteClientModal({
  row, onClose, onDeleted, onError,
}: {
  row: AdminClientRow;
  onClose:  () => void;
  onDeleted: () => void;
  onError:   (msg: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);

  const expectedName = (row.name || "").trim();
  const matches = confirmName.trim() === expectedName || confirmName.trim() === row.phone;
  const canDelete = matches && reason.trim().length >= 3 && !busy;

  async function doDelete() {
    if (!canDelete) return;
    setBusy(true);
    try {
      await deleteAdminClient(row.phone, reason.trim(), confirmName.trim());
      onDeleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : "שגיאה במחיקה");
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--paper)", borderRadius: 12, maxWidth: 520, width: "100%",
          padding: 24, borderTop: "4px solid #E53935",
          boxShadow: "0 12px 48px rgba(0,0,0,0.25)",
        }}
      >
        <h3 style={{ margin: "0 0 8px", color: "#E53935", fontSize: 18, fontWeight: 800 }}>
          מחיקת לקוח — פעולה לא הפיכה
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
          תמחק לחלוטין: כל הלקוח, האיפיון, סשנים של AI ads ו-LP, פייפליין, משימות,
          הודעות והקשרי WhatsApp.<br />
          <strong>נשמר</strong>: ספר תשלומים, תנועות מטבעות, חשבוניות (לצרכי הנהלת חשבונות).<br />
          תיעוד הפעולה והעתק מלא של מסמך הלקוח נשמרים ביומן הביקורת.
        </p>

        <div style={{
          background: "var(--bg-tint)", padding: 12, borderRadius: 8,
          marginBottom: 16, fontSize: 12,
        }}>
          <div><strong>שם:</strong> {row.name}</div>
          <div><strong>טלפון:</strong> <span dir="ltr">{row.phone}</span></div>
          <div><strong>מנהל:</strong> {row.managerName}</div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            סיבה למחיקה (חובה — נשמר ביומן הביקורת)
          </label>
          <input
            type="text" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="לדוגמה: לקוח ביקש להסיר את כל המידע (GDPR)"
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: "1px solid var(--rule)", fontSize: 13, background: "var(--paper)",
            }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
            הקלד את <span style={{ color: "#E53935" }}>שם הלקוח המדויק</span> או את הטלפון לאישור
          </label>
          <input
            type="text" value={confirmName} onChange={e => setConfirmName(e.target.value)}
            placeholder={expectedName || row.phone}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: matches ? "2px solid #2E7D32" : "1px solid var(--rule)",
              fontSize: 13, background: "var(--paper)",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}>
          <button
            onClick={doDelete} disabled={!canDelete}
            style={{
              background: canDelete ? "#E53935" : "#aaa",
              color: "#fff", border: "none", borderRadius: 6,
              padding: "8px 18px", fontSize: 13, fontWeight: 700,
              cursor: canDelete ? "pointer" : "not-allowed",
            }}
          >{busy ? "מוחק..." : "מחק לקוח"}</button>
          <button
            onClick={onClose} disabled={busy}
            style={{
              background: "transparent", color: "var(--ink-2)",
              border: "1px solid var(--rule)", borderRadius: 6,
              padding: "8px 18px", fontSize: 13, fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >ביטול</button>
        </div>
      </div>
    </div>
  );
}

interface Option { value: string; label: string }
function FilterSelect({
  value, onChange, placeholder, options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: (string | Option)[];
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: "8px 12px", borderRadius: 8,
        border: "1px solid var(--rule)", background: "var(--paper)",
        fontSize: 12, cursor: "pointer",
      }}
    >
      <option value="">{placeholder}</option>
      {options.map(o => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{
    padding: "10px 12px", textAlign: align ?? "right",
    fontSize: 11, fontWeight: 700, color: "var(--ink-2)",
    textTransform: "uppercase", letterSpacing: "0.05em",
    whiteSpace: "nowrap",
  }}>{children}</th>;
}

function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "10px 12px", textAlign: align ?? "right", verticalAlign: "middle" }}>{children}</td>;
}
