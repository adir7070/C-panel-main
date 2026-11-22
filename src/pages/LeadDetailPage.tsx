import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  getLead, updateLead, addLeadNote, activateLead, deleteLead,
  LEAD_STATUS_LABEL, LEAD_STATUS_COLOR, CLIENT_LEAD_STATUSES, formatLeadDate,
  type Lead, type LeadPatch,
} from "../api/leads";
import { getAccountManagers, type AccountManager } from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { usePurchaseSync } from "../hooks/usePurchaseSync";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Tabs } from "../components/shell/Tabs";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Field } from "../components/ui/Field";
import { Input, Textarea } from "../components/ui/Input";
import { PersonalCatalogTab } from "../components/tabs/PersonalCatalogTab";
import {
  PhoneLinks, StatusButtons, KV, LeadCard, LeadAnswersList, LeadNotesList, LeadHistoryList,
} from "../components/leads/LeadParts";

/**
 * LeadDetailPage — /leads/:id[/personal_catalog]
 * One lead on its own screen: who they are, what they answered on the
 * intake form, notes, status history, and the personal catalog (quotes,
 * contract by SMS, charge). The catalog is keyed by phone — the same
 * packages show on the client page once the lead becomes a client, and a
 * payment made here converts the lead (backend purchase-sync).
 */

type TabId = "details" | "personal_catalog";

const TABS: { id: TabId; label: string }[] = [
  { id: "details",          label: "פרטי ליד"   },
  { id: "personal_catalog", label: "קטלוג אישי" },
];

export function LeadDetailPage() {
  const { id = "", tab: tabParam } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const { agent } = useAuth();
  const toast = useToast();
  const reduce = useReducedMotion();
  const isAdmin = agent?.role === "admin";

  /* /leads/:id/personal_catalog deep-links the catalog. Switching tabs stays
     in local state: route transitions are keyed by pathname (App.tsx), so
     rewriting the URL would remount the page and its open catalog editor. */
  const [tab, setTabState] = useState<TabId>(() => (tabParam === "personal_catalog" ? "personal_catalog" : "details"));
  const setTab = (t: string) => setTabState(t === "personal_catalog" ? "personal_catalog" : "details");

  const fetchLead = useCallback(() => getLead(id).then(r => r.lead), [id]);
  const { data: lead, loading, error, reload } = useApi(fetchLead, [fetchLead]);

  // a payment from the catalog flips the lead to "לקוח פעיל" server-side
  usePurchaseSync(ev => {
    if (!ev.phone || ev.phone === lead?.phone) reload();
  });

  const managersFetcher = useCallback(
    () => (isAdmin ? getAccountManagers() : Promise.resolve([] as AccountManager[])),
    [isAdmin],
  );
  const { data: managersData } = useApi(managersFetcher, [managersFetcher]);
  const managers = useMemo(() => managersData ?? [], [managersData]);

  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(key);
    try {
      await fn();
      toast.ok(okMsg);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(null);
    }
  }

  const back = <BackButton onClick={() => navigate("/leads")} />;

  if (!lead) {
    return (
      <Layout header={<Header eyebrow="ליד" title={loading ? "טוען ליד…" : "ליד"} back={back} />}>
        {loading ? (
          <Spinner size="lg" label="טוען ליד" />
        ) : (
          <EmptyState
            title="הליד לא נמצא"
            meta={error ?? "ייתכן שהוא נמחק או שאינו משויך אליך."}
            action={<Button onClick={() => navigate("/leads")}>חזרה ללידים</Button>}
            secondaryAction={<Button variant="ghost" onClick={reload}>נסה שוב</Button>}
          />
        )}
      </Layout>
    );
  }

  const isClient = !!lead.clientPhone;
  const statusColor = LEAD_STATUS_COLOR[lead.status];

  return (
    <Layout
      header={
        <Header
          eyebrow="ליד"
          title={lead.name || lead.phone || "ליד"}
          meta={lead.phone ? <span dir="ltr" className="tabular">{lead.phone}</span> : undefined}
          back={back}
          trailing={
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={reload} loading={loading}>רענן</Button>
              {isClient && (
                <Button size="sm" onClick={() => navigate(`/clients/${encodeURIComponent(lead.clientPhone as string)}`)}>
                  פתח בעמוד הלקוח
                </Button>
              )}
            </div>
          }
        />
      }
    >
      {/* ── Identity + status ── */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "stretch", flexWrap: "wrap" }}>
          <div className="card" style={{ flex: "2 1 420px", padding: "var(--s-5)", borderTop: `3px solid ${statusColor}`, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
              <Initial name={lead.name || lead.business || lead.phone} color={statusColor} />
              <div style={{ minWidth: 0, display: "grid", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: "var(--t-xl)", fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.01em" }}>
                    {lead.name || "—"}
                  </h2>
                  {lead.duplicateOf && (
                    <Link to={`/leads/${lead.duplicateOf}`} title="פתח את הליד הקודם עם אותו טלפון">
                      <Badge variant="warning">כפול · לליד המקורי</Badge>
                    </Link>
                  )}
                  {isClient && <Badge variant="positive">נפתח כלקוח</Badge>}
                </div>
                <div style={{ display: "flex", gap: "var(--s-4)", flexWrap: "wrap", alignItems: "center", fontSize: "var(--t-sm)", color: "var(--ink-2)" }}>
                  <PhoneLinks phone={lead.phone} />
                  {lead.email && <a href={`mailto:${lead.email}`} dir="ltr" style={{ color: "var(--ink-2)" }}>{lead.email}</a>}
                  {(lead.business || lead.field) && (
                    <span>{[lead.business, lead.field].filter(Boolean).join(" · ")}</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ marginTop: "var(--s-4)", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--s-3)" }}>
              <KV label="נכנס">{formatLeadDate(lead.createdAt)}</KV>
              <KV label="מקור">
                <Badge>{lead.source || "—"}</Badge>
                {lead.campaign && <span className="t-meta" style={{ marginInlineStart: 6 }}>{lead.campaign}</span>}
              </KV>
              <KV label="משויך ל">{lead.assignedToName || <span className="t-meta">לא משויך</span>}</KV>
              {lead.convertedAt && <KV label="נפתח כלקוח">{formatLeadDate(lead.convertedAt)}</KV>}
              {lead.activatedAt && <KV label="לקוח פעיל מ">{formatLeadDate(lead.activatedAt)}</KV>}
            </div>
          </div>

          <div className="card" style={{ flex: "1 1 300px", padding: "var(--s-5)", display: "grid", gap: "var(--s-4)", alignContent: "start", minWidth: 0 }}>
            <div>
              <p className="t-eyebrow" style={{ marginBottom: 8 }}>סטטוס</p>
              <StatusButtons
                value={lead.status}
                disabled={!!busy}
                onPick={s => run(`status:${s}`, () => updateLead(lead.id, { status: s }), `סטטוס עודכן: ${LEAD_STATUS_LABEL[s]}`)}
              />
              {!isClient && (
                <p className="t-meta" style={{ fontSize: 11, margin: "8px 0 0" }}>
                  בתהליך / לסלוק / לקוח פעיל פותחים את הליד כלקוח ב"כל הלקוחות".
                </p>
              )}
            </div>
            {isAdmin && (
              <div>
                <p className="t-eyebrow" style={{ marginBottom: 6 }}>שיוך למנהל</p>
                <select
                  className="input"
                  value={lead.assignedTo ?? ""}
                  disabled={!!busy}
                  onChange={e => run("assign", () => updateLead(lead.id, { assignedTo: e.target.value || null }), "השיוך עודכן")}
                >
                  <option value="">— לא משויך —</option>
                  {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {lead.status !== "active_client" && (
                <Button
                  size="sm"
                  loading={busy === "activate"}
                  disabled={!!busy}
                  onClick={() => run("activate", () => activateLead(lead.id), "הליד הפך ללקוח פעיל")}
                  style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                >
                  ✓ הפוך ללקוח פעיל
                </Button>
              )}
              {isAdmin && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!!busy}
                  style={{ marginInlineStart: "auto" }}
                  onClick={async () => {
                    if (!window.confirm(`למחוק את הליד "${lead.name}" לצמיתות?`)) return;
                    setBusy("delete");
                    try {
                      await deleteLead(lead.id);
                      toast.ok("הליד נמחק");
                      navigate("/leads", { replace: true });
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "שגיאה במחיקה");
                      setBusy(null);
                    }
                  }}
                >
                  מחק ליד
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <Tabs tabs={TABS} active={tab} onChange={setTab} sticky top={56} layoutId="lead-tab-underline" />

      <div style={{ padding: "var(--s-6) var(--s-5)", maxWidth: 1280, margin: "0 auto" }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            {tab === "details" && (
              <DetailsTab lead={lead} busy={busy} run={run} />
            )}
            {tab === "personal_catalog" && (
              lead.phone ? (
                <div style={{ display: "grid", gap: "var(--s-4)" }}>
                  {!isClient && (
                    <div className="card" style={{ padding: "var(--s-3) var(--s-4)", background: "var(--bg-tint)", fontSize: 13, color: "var(--ink-2)" }}>
                      הקטלוג נשמר על הטלפון <span dir="ltr" className="num">{lead.phone}</span>. כשהליד ייפתח כלקוח, אותו קטלוג יופיע בעמוד הלקוח.
                      תשלום מכאן (חיוב או חוזה ב-SMS) פותח את הלקוח ומעביר את הליד ל"לקוח פעיל" אוטומטית.
                    </div>
                  )}
                  <PersonalCatalogTab key={lead.phone} phone={lead.phone} />
                </div>
              ) : (
                <EmptyState
                  title="לליד אין טלפון"
                  meta="הקטלוג האישי נשמר לפי מספר טלפון. הוסף טלפון בטאב 'פרטי ליד'."
                  action={<Button onClick={() => setTab("details")}>לפרטי הליד</Button>}
                />
              )
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </Layout>
  );
}

/* ── פרטי ליד ─────────────────────────────────────────────────────────── */

function DetailsTab({ lead, busy, run }: {
  lead: Lead;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>, okMsg: string) => Promise<void>;
}) {
  const [noteText, setNoteText] = useState("");
  const answers = lead.answers ?? [];
  const tracking = Object.entries(lead.tracking ?? {});

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "var(--s-4)", alignItems: "start" }}>
      {/* Right column — who they are and what they said */}
      <div style={{ display: "grid", gap: "var(--s-4)", minWidth: 0 }}>
        <LeadCard title="שאלות שהליד ענה" count={answers.length} accent="var(--blue)">
          {answers.length > 0 ? (
            <LeadAnswersList answers={answers} />
          ) : (
            <p className="t-meta" style={{ margin: 0 }}>
              {lead.source === "manual" || lead.source === "import"
                ? "ליד שהוזן ידנית — אין שאלון."
                : "הליד לא ענה על שאלות בטופס."}
            </p>
          )}
        </LeadCard>

        {lead.message && (
          <LeadCard title="הודעה מהליד">
            <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0, overflowWrap: "anywhere" }}>{lead.message}</p>
          </LeadCard>
        )}

        <ContactCard lead={lead} busy={busy} run={run} />

        {tracking.length > 0 && (
          <LeadCard title="פרטי מעקב">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--s-3)" }}>
              {tracking.map(([k, v]) => (
                <KV key={k} label={k}><span dir="ltr">{v}</span></KV>
              ))}
            </div>
          </LeadCard>
        )}
      </div>

      {/* Left column — the team's work on the lead */}
      <div style={{ display: "grid", gap: "var(--s-4)", minWidth: 0 }}>
        <LeadCard title="הערות" count={lead.notes?.length ?? 0}>
          <div style={{ display: "grid", gap: 8 }}>
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
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <LeadNotesList notes={lead.notes ?? []} />
          </div>
        </LeadCard>

        <LeadCard title="היסטוריית סטטוס" count={lead.statusHistory?.length ?? 0}>
          <LeadHistoryList history={lead.statusHistory ?? []} />
        </LeadCard>
      </div>
    </div>
  );
}

/* Contact details — editable until the lead becomes a client. After that the
   client's איפיון is where they're kept, so this card points there. */
function ContactCard({ lead, busy, run }: {
  lead: Lead;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>, okMsg: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const blank = { name: lead.name, phone: lead.phone, email: lead.email, business: lead.business, field: lead.field, campaign: lead.campaign };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF(p => ({ ...p, [k]: e.target.value }));
  const isClient = !!lead.clientPhone || CLIENT_LEAD_STATUSES.includes(lead.status);

  async function save() {
    if (!f.name.trim() && !f.phone.trim()) return;
    const patch: LeadPatch = {};
    (Object.keys(f) as (keyof typeof f)[]).forEach(k => {
      if ((f[k] ?? "") !== (lead[k] ?? "")) patch[k] = f[k].trim();
    });
    if (Object.keys(patch).length === 0) { setEditing(false); return; }
    await run("contact", async () => { await updateLead(lead.id, patch); setEditing(false); }, "פרטי הליד עודכנו");
  }

  return (
    <LeadCard
      title="פרטי קשר"
      action={!isClient && !editing ? (
        <Button size="sm" variant="ghost" onClick={() => { setF(blank); setEditing(true); }}>ערוך</Button>
      ) : undefined}
    >
      {editing ? (
        <div style={{ display: "grid", gap: "var(--s-3)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="שם"><Input value={f.name} onChange={set("name")} /></Field>
            <Field label="טלפון"><Input value={f.phone} onChange={set("phone")} dir="ltr" inputMode="tel" /></Field>
            <Field label="אימייל"><Input value={f.email} onChange={set("email")} dir="ltr" type="email" /></Field>
            <Field label="קמפיין"><Input value={f.campaign} onChange={set("campaign")} /></Field>
            <Field label="עסק"><Input value={f.business} onChange={set("business")} /></Field>
            <Field label="תחום"><Input value={f.field} onChange={set("field")} /></Field>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy === "contact"}>ביטול</Button>
            <Button size="sm" onClick={save} loading={busy === "contact"} disabled={!!busy || (!f.name.trim() && !f.phone.trim())}>שמור</Button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--s-3)" }}>
            <KV label="שם">{lead.name || "—"}</KV>
            <KV label="טלפון"><PhoneLinks phone={lead.phone} /></KV>
            <KV label="אימייל">{lead.email ? <a href={`mailto:${lead.email}`} dir="ltr">{lead.email}</a> : "—"}</KV>
            <KV label="עסק">{lead.business || "—"}</KV>
            <KV label="תחום">{lead.field || "—"}</KV>
            <KV label="קמפיין">{lead.campaign || "—"}</KV>
          </div>
          {isClient && lead.phone && (
            <p className="t-meta" style={{ fontSize: 12, margin: 0 }}>
              הליד נפתח כלקוח — את פרטי העסק מעדכנים{" "}
              <Link to={`/clients/${encodeURIComponent(lead.clientPhone || lead.phone)}/characterization`}>באיפיון בעמוד הלקוח</Link>.
            </p>
          )}
        </>
      )}
    </LeadCard>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-quiet"
      style={{ background: "transparent", border: 0, padding: "var(--s-2) var(--s-3)" }}
      aria-label="חזרה ללידים"
    >
      <span className="t-eyebrow">‹ לידים</span>
    </button>
  );
}

function Initial({ name, color }: { name: string; color: string }) {
  return (
    <div style={{
      width: 48, height: 48, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: "var(--r-2)", background: color, color: "#fff",
      fontSize: "var(--t-lg)", fontWeight: 800,
    }}>
      {(name || "?").trim().charAt(0).toUpperCase()}
    </div>
  );
}
