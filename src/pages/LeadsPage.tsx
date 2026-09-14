import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listLeads, getLeadStats, updateLead, addLeadNote, activateLead, deleteLead, importLeads,
  LEAD_STATUSES, LEAD_STATUS_LABEL, LEAD_STATUS_COLOR, formatLeadDate, waLink,
  type Lead, type LeadStatus,
} from "../api/leads";
import { getAccountManagers, type AccountManager } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { usePurchaseSync } from "../hooks/usePurchaseSync";
import { useToast } from "../context/ToastContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Modal } from "../components/ui/Modal";
import { Field } from "../components/ui/Field";
import { Input, Textarea } from "../components/ui/Input";

/**
 * LeadsPage — the agency's own incoming-leads pipeline (prospective
 * clients), served by the local leads API in server/leads.js.
 *   • intake lands via POST /api/leads/intake (see admin "לידים לחלוקה")
 *   • managers see the leads assigned to them; admins see everything
 *   • each lead: status (6 states), notes, "make active client"
 */
export function LeadsPage() {
  const { agent } = useAuth();
  const toast = useToast();
  const isAdmin = agent?.role === "admin";

  /* Filters */
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "">("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [assigned, setAssigned] = useState<string>("all");
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const fetcher = useCallback(async () => {
    const [list, stats] = await Promise.all([
      listLeads({ status: statusFilter, search, assigned: isAdmin ? assigned : undefined, limit: 500 }),
      getLeadStats(),
    ]);
    return { ...list, stats };
  }, [statusFilter, search, assigned, isAdmin]);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);
  // a paid client's lead flips to "לקוח פעיל" server-side — show it
  usePurchaseSync(() => reload());

  const managersFetcher = useCallback(() => isAdmin ? getAccountManagers() : Promise.resolve([] as AccountManager[]), [isAdmin]);
  const { data: managersData } = useApi(managersFetcher, [managersFetcher]);
  const managers = useMemo(() => managersData ?? [], [managersData]);

  /* Selected lead (detail modal). We keep the row that was clicked as a
     snapshot and prefer the fresh copy whenever it is still in the list —
     so the modal shows live data but doesn't slam shut when a status
     change pushes the lead out of the current filter. */
  const [openSnapshot, setOpenSnapshot] = useState<Lead | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const leads = useMemo(() => data?.leads ?? [], [data]);

  /* Optimistic status patch so the dropdown feels instant. Each entry
     remembers the status it replaced; the patch is applied ONLY while the
     server row still shows that old value. The moment the server catches
     up — or anyone changes the lead to something else — the patch stops
     applying on its own, so it can never mask a real server-side change. */
  const [localPatch, setLocalPatch] = useState<Record<string, { status: LeadStatus; prev: LeadStatus }>>({});
  const view = useCallback((l: Lead): Lead => {
    const p = localPatch[l.id];
    return p && l.status === p.prev ? { ...l, status: p.status } : l;
  }, [localPatch]);

  const openLead = useMemo(() => {
    if (!openSnapshot) return null;
    const fresh = leads.find(l => l.id === openSnapshot.id);
    return fresh ? view(fresh) : openSnapshot;
  }, [openSnapshot, leads, view]);

  async function changeStatus(lead: Lead, status: LeadStatus) {
    if (status === lead.status) return;
    setLocalPatch(p => ({ ...p, [lead.id]: { status, prev: lead.status } }));
    try {
      await updateLead(lead.id, { status });
      toast.ok(`סטטוס עודכן: ${LEAD_STATUS_LABEL[status]}`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בעדכון סטטוס");
    } finally {
      setLocalPatch(p => { const n = { ...p }; delete n[lead.id]; return n; });
    }
  }

  const stats = data?.stats;

  return (
    <Layout
      header={
        <Header
          eyebrow="לידים"
          title="ניהול לידים"
          meta={data ? `${data.total} לידים${stats?.unassigned ? ` · ${stats.unassigned} ממתינים לחלוקה` : ""}` : "טוען…"}
          trailing={
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={reload}>רענן</Button>
              <Button size="sm" onClick={() => setNewOpen(true)}>+ ליד ידני</Button>
            </div>
          }
        />
      }
    >
      {/* ── Status strip ── */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <StatusPill
            label="הכל"
            count={stats?.total ?? 0}
            color="var(--ink-2)"
            active={statusFilter === ""}
            onClick={() => setStatusFilter("")}
          />
          {LEAD_STATUSES.map(s => (
            <StatusPill
              key={s}
              label={LEAD_STATUS_LABEL[s]}
              count={stats?.byStatus?.[s] ?? 0}
              color={LEAD_STATUS_COLOR[s]}
              active={statusFilter === s}
              onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
            />
          ))}
        </div>
      </section>

      {/* ── Filter bar ── */}
      <section className="section" style={{ marginTop: "var(--s-4)" }}>
        <div className="card" style={{ padding: "var(--s-3) var(--s-4)", display: "grid", gridTemplateColumns: isAdmin ? "1fr 220px" : "1fr", gap: 8 }}>
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="חיפוש: שם / טלפון / עסק / תחום / הודעה…"
          />
          {isAdmin && (
            <select value={assigned} onChange={e => setAssigned(e.target.value)} className="input">
              <option value="all">כל המנהלים</option>
              <option value="unassigned">לא משויך</option>
              <option value="me">שלי</option>
              {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>
      </section>

      {/* ── Table ── */}
      <section className="section" style={{ marginTop: "var(--s-4)" }}>
        {loading && !data ? (
          <Spinner label="טוען לידים" />
        ) : error ? (
          <EmptyState title="שגיאה בטעינת לידים" meta={error} action={<Button onClick={reload}>נסה שוב</Button>} />
        ) : leads.length === 0 ? (
          <EmptyState
            title="אין לידים להצגה"
            meta={
              statusFilter || search
                ? "אין לידים שתואמים לסינון הנוכחי."
                : isAdmin
                  ? "לידים חדשים ייכנסו דרך POST /api/leads/intake (ראה 'לידים לחלוקה'), או הוסף ליד ידני."
                  : "עדיין לא שויכו אליך לידים. מנהל המערכת מחלק לידים במסך 'לידים לחלוקה'."
            }
            action={<Button onClick={() => setNewOpen(true)}>+ ליד ידני</Button>}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden", borderTop: "3px solid var(--blue)" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 980 }}>
                <thead>
                  <tr style={{ background: "var(--bg-tint)" }}>
                    <Th>שם</Th>
                    <Th>טלפון</Th>
                    <Th>עסק / תחום</Th>
                    <Th>מקור</Th>
                    <Th>סטטוס</Th>
                    {isAdmin && <Th>משויך ל</Th>}
                    <Th>הערות</Th>
                    <Th>נוצר</Th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map(raw => {
                    const l = view(raw);
                    return (
                      <tr
                        key={l.id}
                        onClick={() => setOpenSnapshot(l)}
                        style={{ borderTop: "1px solid var(--rule)", cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tint)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <Td>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: 99, background: LEAD_STATUS_COLOR[l.status], flexShrink: 0 }} />
                            <span style={{ fontWeight: 700, color: "var(--ink)" }}>{l.name || "—"}</span>
                            {l.duplicateOf && <Badge variant="warning">כפול</Badge>}
                          </div>
                        </Td>
                        <Td onClick={e => e.stopPropagation()}>
                          <PhoneLinks phone={l.phone} />
                        </Td>
                        <Td>
                          <div style={{ display: "grid" }}>
                            <span>{l.business || <span className="t-meta">—</span>}</span>
                            {l.field && <span className="t-meta" style={{ fontSize: 11 }}>{l.field}</span>}
                          </div>
                        </Td>
                        <Td><Badge>{l.source || "—"}</Badge></Td>
                        <Td onClick={e => e.stopPropagation()}>
                          <StatusSelect value={l.status} onChange={s => changeStatus(raw, s)} />
                        </Td>
                        {isAdmin && (
                          <Td>{l.assignedToName || <span className="t-meta">לא משויך</span>}</Td>
                        )}
                        <Td>
                          {l.notes?.length
                            ? <Badge>{l.notes.length}</Badge>
                            : <span className="t-meta">—</span>}
                        </Td>
                        <Td><span className="t-meta" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{formatLeadDate(l.createdAt)}</span></Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* ── Detail modal ── */}
      <Modal
        open={!!openLead}
        onClose={() => setOpenSnapshot(null)}
        size="lg"
        eyebrow={openLead ? LEAD_STATUS_LABEL[openLead.status] : undefined}
        title={openLead?.name || "ליד"}
      >
        {openLead && (
          <LeadDetail
            lead={openLead}
            isAdmin={isAdmin}
            managers={managers}
            onChanged={reload}
            onDeleted={() => { setOpenSnapshot(null); reload(); }}
          />
        )}
      </Modal>

      {/* ── Manual lead ── */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} eyebrow="ליד ידני" title="הוספת ליד">
        {newOpen && (
          <NewLeadForm
            isAdmin={isAdmin}
            managers={managers}
            onDone={() => { setNewOpen(false); reload(); }}
          />
        )}
      </Modal>
    </Layout>
  );
}

/* ── Detail panel ────────────────────────────────────────────────────── */

function LeadDetail({ lead, isAdmin, managers, onChanged, onDeleted }: {
  lead: Lead;
  isAdmin: boolean;
  managers: AccountManager[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  async function run(key: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(key);
    try {
      await fn();
      toast.ok(okMsg);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-5)", padding: "var(--s-2) 0" }}>
      {/* Contact block */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--s-3)" }}>
        <KV label="טלפון"><PhoneLinks phone={lead.phone} /></KV>
        <KV label="אימייל">{lead.email ? <a href={`mailto:${lead.email}`} dir="ltr">{lead.email}</a> : "—"}</KV>
        <KV label="עסק">{lead.business || "—"}</KV>
        <KV label="תחום">{lead.field || "—"}</KV>
        <KV label="מקור">{lead.source || "—"}{lead.campaign ? ` · ${lead.campaign}` : ""}</KV>
        <KV label="נוצר">{formatLeadDate(lead.createdAt)}</KV>
        {isAdmin && <KV label="משויך ל">{lead.assignedToName || "לא משויך"}</KV>}
        {lead.activatedAt && <KV label="הפך ללקוח פעיל">{formatLeadDate(lead.activatedAt)}</KV>}
      </div>

      {lead.message && (
        <div className="card" style={{ background: "var(--bg-tint)", padding: "var(--s-3) var(--s-4)" }}>
          <p className="t-eyebrow" style={{ marginBottom: 4 }}>הודעה מהליד</p>
          <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{lead.message}</p>
        </div>
      )}

      {/* Status */}
      <div>
        <p className="t-eyebrow" style={{ marginBottom: 8 }}>סטטוס</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {LEAD_STATUSES.map(s => {
            const active = lead.status === s;
            return (
              <button
                key={s}
                type="button"
                disabled={!!busy}
                onClick={() => !active && run(`status:${s}`, () => updateLead(lead.id, { status: s }), `סטטוס עודכן: ${LEAD_STATUS_LABEL[s]}`)}
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
      </div>

      {/* Primary actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {lead.status !== "active_client" && (
          <Button
            loading={busy === "activate"}
            disabled={!!busy}
            onClick={() => run("activate", () => activateLead(lead.id), "הליד הפך ללקוח פעיל")}
            style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
          >
            ✓ הפוך ללקוח פעיל
          </Button>
        )}
        {isAdmin && (
          <select
            className="input"
            style={{ maxWidth: 240 }}
            value={lead.assignedTo ?? ""}
            disabled={!!busy}
            onChange={e => run("assign", () => updateLead(lead.id, { assignedTo: e.target.value || null }), "השיוך עודכן")}
          >
            <option value="">— לא משויך —</option>
            {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        {isAdmin && (
          <Button
            variant="danger"
            size="sm"
            disabled={!!busy}
            style={{ marginInlineStart: "auto" }}
            onClick={() => {
              if (!window.confirm(`למחוק את הליד "${lead.name}" לצמיתות?`)) return;
              run("delete", () => deleteLead(lead.id).then(onDeleted), "הליד נמחק");
            }}
          >
            מחק
          </Button>
        )}
      </div>

      {/* Notes */}
      <div>
        <p className="t-eyebrow" style={{ marginBottom: 8 }}>הערות · {lead.notes?.length ?? 0}</p>
        <div style={{ display: "grid", gap: 8, maxHeight: 260, overflowY: "auto" }}>
          {(lead.notes ?? []).length === 0 && <p className="t-meta">אין הערות עדיין.</p>}
          {[...(lead.notes ?? [])].reverse().map(n => (
            <div key={n.id} className="card" style={{ padding: "var(--s-3)", background: "var(--paper)" }}>
              <p className="t-meta" style={{ fontSize: 11, marginBottom: 4 }}>
                <strong style={{ color: "var(--ink)" }}>{n.byName}</strong> · {formatLeadDate(n.at)}
              </p>
              <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{n.text}</p>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <Textarea
            rows={3}
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder="הוסף הערה על השיחה / הסיכום / המשך טיפול…"
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              size="sm"
              loading={busy === "note"}
              disabled={!!busy || !noteText.trim()}
              onClick={() => run("note", async () => { await addLeadNote(lead.id, noteText.trim()); setNoteText(""); }, "ההערה נוספה")}
            >
              הוסף הערה
            </Button>
          </div>
        </div>
      </div>

      {/* History */}
      {(lead.statusHistory ?? []).length > 0 && (
        <div>
          <p className="t-eyebrow" style={{ marginBottom: 6 }}>היסטוריית סטטוס</p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
            {[...lead.statusHistory].reverse().map((h, i) => (
              <li key={i} className="t-meta" style={{ fontSize: 11 }}>
                {formatLeadDate(h.at)} · {h.byName}: {LEAD_STATUS_LABEL[h.from] ?? h.from} → <strong style={{ color: LEAD_STATUS_COLOR[h.to] }}>{LEAD_STATUS_LABEL[h.to] ?? h.to}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── Manual lead form ────────────────────────────────────────────────── */

function NewLeadForm({ isAdmin, managers, onDone }: { isAdmin: boolean; managers: AccountManager[]; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", phone: "", email: "", business: "", field: "", message: "" });
  const [assignedTo, setAssignedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF(p => ({ ...p, [k]: e.target.value }));

  async function submit() {
    if (!f.name.trim() && !f.phone.trim()) { toast.warn("נדרש לפחות שם או טלפון"); return; }
    setBusy(true);
    try {
      const r = await importLeads([{ ...f, source: "manual" }], isAdmin ? (assignedTo || null) : undefined);
      if (r.imported === 0) toast.warn("הליד לא נוסף — כנראה כבר קיים ליד עם אותו טלפון");
      else toast.ok("הליד נוסף");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהוספה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-3)", padding: "var(--s-2) 0", minWidth: 360 }}>
      <Field label="שם" required><Input value={f.name} onChange={set("name")} autoFocus /></Field>
      <Field label="טלפון" required><Input value={f.phone} onChange={set("phone")} dir="ltr" inputMode="tel" /></Field>
      <Field label="אימייל"><Input value={f.email} onChange={set("email")} dir="ltr" type="email" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="עסק"><Input value={f.business} onChange={set("business")} /></Field>
        <Field label="תחום"><Input value={f.field} onChange={set("field")} /></Field>
      </div>
      <Field label="הערה / הודעה"><Textarea rows={3} value={f.message} onChange={set("message")} /></Field>
      {isAdmin && (
        <Field label="שייך למנהל">
          <select className="input" value={assignedTo} onChange={e => setAssignedTo(e.target.value)}>
            <option value="">— לא משויך —</option>
            {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" onClick={onDone} disabled={busy}>ביטול</Button>
        <Button onClick={submit} loading={busy}>הוסף ליד</Button>
      </div>
    </div>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function StatusPill({ label, count, color, active, onClick }: { label: string; count: number; color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "8px 14px", borderRadius: 10, cursor: "pointer",
        border: `1.5px solid ${active ? color : "var(--rule)"}`,
        background: active ? `${color}14` : "var(--paper)",
        color: "var(--ink)", fontSize: 13, fontWeight: 600,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
      {label}
      <span className="num" dir="ltr" style={{ fontWeight: 800, color }}>{count.toLocaleString("he-IL")}</span>
    </button>
  );
}

function StatusSelect({ value, onChange }: { value: LeadStatus; onChange: (s: LeadStatus) => void }) {
  const color = LEAD_STATUS_COLOR[value];
  return (
    <select
      value={value}
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

function PhoneLinks({ phone }: { phone: string }) {
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

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="t-eyebrow" style={{ marginBottom: 2 }}>{label}</p>
      <div style={{ color: "var(--ink)", fontSize: 13 }}>{children}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{
    padding: "10px 12px", textAlign: "right",
    fontSize: 11, fontWeight: 700, color: "var(--ink-2)",
    textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap",
  }}>{children}</th>;
}

function Td({ children, onClick }: { children: React.ReactNode; onClick?: (e: React.MouseEvent) => void }) {
  return <td onClick={onClick} style={{ padding: "10px 12px", textAlign: "right", verticalAlign: "middle" }}>{children}</td>;
}
