import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Input";
import { useToast } from "../../context/ToastContext";
import { useApi } from "../../hooks/useApi";
import { listLeads, assignLeads, roundRobinLeads, formatLeadDate, waLink, type Lead } from "../../api/leads";
import { getAccountManagers, type AccountManager } from "../../api/client";

/**
 * Admin: distribute incoming (unassigned) leads to account managers.
 * Leads arrive through the local intake endpoint (POST /api/leads/intake)
 * or the manual/CSV import; once assigned they show up on the manager's
 * own "לידים" page.
 */
export function AdminLeadsDistributionPage() {
  const toast = useToast();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const fetcher = useCallback(() => listLeads({ assigned: "unassigned", search, limit: 500 }), [search]);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);

  const managersFetcher = useCallback(() => getAccountManagers(), []);
  const { data: managers } = useApi<AccountManager[]>(managersFetcher, [managersFetcher]);

  const rows = useMemo(() => {
    const all = data?.leads ?? [];
    /* `<input type="date">` gives YYYY-MM-DD, which `new Date()` parses as
       UTC midnight — that shifts the range by the local offset (3h in
       Israel). Build local-midnight bounds instead. */
    const localMidnight = (ymd: string) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
    };
    const from = fromDate ? localMidnight(fromDate) : null;
    const to = toDate ? localMidnight(toDate) + 86_400_000 : null;
    return all.filter(l => {
      const t = new Date(l.createdAt).getTime();
      if (from !== null && t < from) return false;
      if (to !== null && t >= to) return false;
      return true;
    });
  }, [data, fromDate, toDate]);

  /* Selection. `selectedIds` below is the intersection with the currently
     visible rows and is what every action + the counter use, so filtering
     the table can never leave the action bar promising more than it sends. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickedManager, setPickedManager] = useState("");
  const [busy, setBusy] = useState(false);
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  function toggleAll() {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) rows.forEach(r => next.delete(r.id)); else rows.forEach(r => next.add(r.id));
      return next;
    });
  }
  function toggleOne(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  const selectedIds = useMemo(() => rows.filter(r => selected.has(r.id)).map(r => r.id), [rows, selected]);

  async function doAssign() {
    if (!selectedIds.length) return;
    if (!pickedManager) { toast.error("בחר מנהל לפני שיוך"); return; }
    setBusy(true);
    try {
      const r = await assignLeads(selectedIds, pickedManager);
      toast.ok(`שוייכו ${r.assigned} לידים${r.skipped ? ` · דולגו ${r.skipped}` : ""}`);
      setSelected(new Set());
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשיוך");
    } finally {
      setBusy(false);
    }
  }

  async function doRoundRobin() {
    if (!selectedIds.length) return;
    if (!confirm(`לחלק ${selectedIds.length} לידים בחלוקה שווה בין כל המנהלים הפעילים?`)) return;
    setBusy(true);
    try {
      const r = await roundRobinLeads(selectedIds, []);
      const dist = Object.entries(r.distribution).map(([n, c]) => `${n}: ${c}`).join(" · ");
      toast.ok(`הופצו ${r.assigned} לידים — ${dist}`);
      setSelected(new Set());
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בהפצה");
    } finally {
      setBusy(false);
    }
  }

  const intakeUrl = `${window.location.origin}/api/leads/intake`;

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="לידים לחלוקה"
          meta={data ? `${rows.length} לידים לא משויכים` : "טוען…"}
          trailing={<Button variant="ghost" size="sm" onClick={reload}>רענן</Button>}
        />
      }
    >
      {/* Intake how-to */}
      <section className="section" style={{ marginTop: 0 }}>
        <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)", padding: "var(--s-3) var(--s-4)" }}>
          <p className="t-eyebrow" style={{ color: "var(--blue)" }}>כניסת לידים</p>
          <p className="t-body" style={{ marginTop: 4, fontSize: 13 }}>
            כל מערכת חיצונית (דף נחיתה, טופס פייסבוק, Zapier) שולחת
            <span className="mono" dir="ltr"> POST {intakeUrl} </span>
            עם JSON (<span className="mono">name, phone, email, business, field, message, source</span>) וכותרת
            <span className="mono" dir="ltr"> x-api-key </span> = הערך של <span className="mono">LEADS_INTAKE_KEY</span> ב-.env.
            הליד נכנס לכאן כ"לא משויך" עד שתחלק אותו.
          </p>
        </div>
      </section>

      {/* Filter bar */}
      <section className="section" style={{ marginTop: "var(--s-4)" }}>
        <div className="card" style={{ padding: "var(--s-3) var(--s-4)", display: "grid", gridTemplateColumns: "1fr 150px 150px", gap: 8 }}>
          <Input value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="חיפוש: שם / טלפון / עסק / תחום…" />
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} title="מתאריך" className="input" />
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} title="עד תאריך" className="input" />
        </div>
      </section>

      {/* Table */}
      <section className="section" style={{ marginTop: "var(--s-4)" }}>
        {error ? (
          <EmptyState title="שגיאה בטעינת לידים" meta={error} action={<Button onClick={reload}>נסה שוב</Button>} />
        ) : loading && !data ? (
          <Spinner label="טוען לידים…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="אין לידים לחלוקה"
            meta="כל הלידים שנכנסו כבר שויכו למנהלים, או שעדיין לא נכנס ליד. בדוק את הפילטרים למעלה."
            action={<Button onClick={reload}>רענן</Button>}
          />
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden", borderTop: "3px solid var(--blue)" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: "var(--bg-tint)" }}>
                    <Th style={{ width: 40 }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ cursor: "pointer" }} />
                    </Th>
                    <Th>שם</Th>
                    <Th>טלפון</Th>
                    <Th>אימייל</Th>
                    <Th>עסק</Th>
                    <Th>תחום</Th>
                    <Th>מקור</Th>
                    <Th>הודעה</Th>
                    <Th>נכנס</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(lead => (
                    <LeadRow
                      key={lead.id}
                      lead={lead}
                      selected={selected.has(lead.id)}
                      onToggle={() => toggleOne(lead.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Floating action bar */}
      {selectedIds.length > 0 && (
        <div style={{
          position: "fixed", bottom: 16, insetInline: "240px 32px",
          background: "var(--paper)", borderRadius: 12,
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)", border: "1px solid var(--rule)",
          padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, zIndex: 100,
        }}>
          <strong style={{ fontSize: 14, color: "var(--ink)" }}>{selectedIds.length} נבחרו</strong>
          <span style={{ flex: 1 }} />
          <select
            value={pickedManager}
            onChange={e => setPickedManager(e.target.value)}
            className="input"
            style={{ minWidth: 180 }}
          >
            <option value="">בחר מנהל…</option>
            {(managers ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <Button onClick={doAssign} disabled={busy || !pickedManager}>{busy ? "שולח…" : "שייך למנהל הנבחר"}</Button>
          <Button variant="ghost" onClick={doRoundRobin} disabled={busy}>חלוקה אוטומטית</Button>
          <button
            onClick={() => setSelected(new Set())}
            style={{ background: "transparent", border: "none", color: "var(--ink-3)", fontSize: 18, cursor: "pointer", padding: "0 4px" }}
            title="בטל בחירה"
          >×</button>
        </div>
      )}
    </Layout>
  );
}

function LeadRow({ lead, selected, onToggle }: { lead: Lead; selected: boolean; onToggle: () => void }) {
  return (
    <tr
      onClick={onToggle}
      style={{ borderTop: "1px solid var(--rule)", cursor: "pointer", background: selected ? "rgba(0,115,234,0.06)" : "transparent" }}
    >
      <Td onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggle} style={{ cursor: "pointer" }} />
      </Td>
      <Td>
        <span style={{ fontWeight: 600 }}>{lead.name || "—"}</span>
        {lead.duplicateOf && <span style={{ marginInlineStart: 6 }}><Badge variant="warning">כפול</Badge></span>}
      </Td>
      <Td onClick={e => e.stopPropagation()}>
        {lead.phone ? (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <a href={`tel:${lead.phone}`} dir="ltr" className="num" style={{ fontSize: 12, color: "var(--ink)", textDecoration: "none" }}>{lead.phone}</a>
            <a href={waLink(lead.phone)} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#128C7E", fontWeight: 700 }}>WA</a>
          </span>
        ) : <span className="t-meta">—</span>}
      </Td>
      <Td onClick={e => e.stopPropagation()} title={lead.email}>
        {lead.email
          ? <a href={`mailto:${lead.email}`} dir="ltr" style={{ fontSize: 12, display: "inline-block", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>{lead.email}</a>
          : <span className="t-meta">—</span>}
      </Td>
      <Td>{lead.business || <span className="t-meta">—</span>}</Td>
      <Td>{lead.field || <span className="t-meta">—</span>}</Td>
      <Td><Badge>{lead.source || "—"}</Badge></Td>
      <Td title={lead.message}>
        <span style={{ display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>
          {lead.message || <span className="t-meta">—</span>}
        </span>
      </Td>
      <Td><span className="t-meta" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{formatLeadDate(lead.createdAt)}</span></Td>
    </tr>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{
    padding: "10px 12px", textAlign: "right",
    fontSize: 11, fontWeight: 700, color: "var(--ink-2)",
    textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap",
    ...style,
  }}>{children}</th>;
}

function Td({ children, onClick, title }: { children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  return <td style={{ padding: "10px 12px", textAlign: "right", verticalAlign: "middle" }} onClick={onClick} title={title}>{children}</td>;
}
