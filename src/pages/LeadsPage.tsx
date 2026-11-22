import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  listLeads, getLeadStats, updateLead, importLeads,
  LEAD_STATUSES, LEAD_STATUS_LABEL, LEAD_STATUS_COLOR, formatLeadDate,
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
import { PhoneLinks, StatusSelect } from "../components/leads/LeadParts";

/**
 * LeadsPage — the agency's own incoming-leads pipeline (prospective
 * clients), served by the local leads API in server/leads.js.
 *   • intake lands via POST /api/leads/intake (see admin "לידים לחלוקה")
 *   • managers see the leads assigned to them; admins see everything
 *   • each lead: status (6 states) inline; clicking a row opens the lead
 *     screen (LeadDetailPage, /leads/:id) — details, intake answers,
 *     notes, history and the personal catalog
 */
export function LeadsPage() {
  const { agent } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
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

  /* ⌘/Ctrl-click opens the lead screen in a new tab. */
  function openLead(e: React.MouseEvent, id: string) {
    const url = `/leads/${id}`;
    if (e.metaKey || e.ctrlKey) window.open(url, "_blank");
    else navigate(url);
  }

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
                        onClick={e => openLead(e, l.id)}
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
