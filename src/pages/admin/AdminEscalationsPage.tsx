import { useCallback, useEffect, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { getAgentEscalations, resolveAgentEscalation, type Escalation } from "../../api/admin";

const CATEGORY_LABEL: Record<string, string> = {
  billing: "חיוב / תשלום / חשבונית",
  technical: "תקלה טכנית / באג",
  account: "מנוי / פרטי חשבון",
  cancellation: "ביטול / החזר כספי",
  dissatisfied: "חוסר שביעות רצון מהמודעות",
  landing_page: "תיקוני דף נחיתה",
  complaint: "תלונה כללית",
  human_request: "ביקש נציג אנושי",
  other: "אחר",
};

type Status = "waiting" | "stale" | "human" | "resolved";
const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  waiting:  { label: "ממתין למענה",            color: "#B26A00", bg: "#FFF4E5" },
  stale:    { label: "לא התקבל מענה 24 שעות",   color: "#C62828", bg: "#FDECEA" },
  human:    { label: "מענה אנושי",              color: "#1565C0", bg: "#E8F1FC" },
  resolved: { label: "טופל",                    color: "#2E7D32", bg: "#EAF6EC" },
};

function fmt(s?: string | null) {
  if (!s) return "";
  return new Date(s).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDur(ms?: number | null) {
  if (ms == null) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} דק׳`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} שע׳`;
  return `${Math.round(h / 24)} ימים`;
}

const STATUS_SORT: Record<Status, number> = { stale: 0, waiting: 1, human: 2, resolved: 3 };

export function AdminEscalationsPage() {
  const [tab, setTab] = useState<"all" | Status>("all");
  const [open, setOpen] = useState<Escalation[]>([]);
  const [resolved, setResolved] = useState<Escalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getAgentEscalations("open"), getAgentEscalations("resolved")])
      .then(([o, r]) => { setOpen(o.escalations || []); setResolved(r.escalations || []); })
      .catch((e) => setError(e?.message ?? "שגיאה בטעינת הפניות"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const doResolve = async (id: string) => {
    setResolving(id);
    try {
      const out = await resolveAgentEscalation(id);
      if (!out.ok) throw new Error(out.error || "שגיאה");
      load();
    } catch (e: any) {
      setError(e?.message ?? "שגיאה בסגירת הפנייה");
    } finally {
      setResolving(null);
    }
  };

  const count = (s: Status) => open.filter((e) => e.handlingStatus === s).length;
  const counters: { s: Status; n: number }[] = [
    { s: "stale", n: count("stale") },
    { s: "waiting", n: count("waiting") },
    { s: "human", n: count("human") },
  ];

  const rows = (tab === "resolved" ? resolved : open)
    .filter((e) => tab === "all" || tab === "resolved" || e.handlingStatus === tab)
    .slice()
    .sort((a, b) => {
      const sa = STATUS_SORT[(a.handlingStatus as Status) || "waiting"];
      const sb = STATUS_SORT[(b.handlingStatus as Status) || "waiting"];
      if (sa !== sb) return sa - sb;
      return (b.ageMs || 0) - (a.ageMs || 0); // oldest first within a status
    });

  const TABS: { key: "all" | Status; label: string }[] = [
    { key: "all", label: "הכל" },
    { key: "waiting", label: "ממתינות" },
    { key: "stale", label: "🔴 באיחור" },
    { key: "human", label: "בטיפול" },
    { key: "resolved", label: "טופל" },
  ];

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי · בקרה"
          title="פניות מהסוכן"
          meta={`${open.length} פתוחות · ${count("stale")} באיחור · ${count("human")} בטיפול`}
        />
      }
    >
      {/* dashboard counters */}
      <section className="section" style={{ marginTop: "var(--s-3)", display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        {counters.map(({ s, n }) => (
          <div key={s} className="card" style={{ padding: "10px 16px", borderTop: `3px solid ${STATUS_META[s].color}`, minWidth: 150 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: STATUS_META[s].color, lineHeight: 1 }}>{n}</div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>{STATUS_META[s].label}</div>
          </div>
        ))}
      </section>

      {/* tabs */}
      <section className="section" style={{ marginTop: "var(--s-3)", display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <Button key={t.key} variant={tab === t.key ? "default" : "ghost"} onClick={() => setTab(t.key)}>{t.label}</Button>
        ))}
      </section>

      {loading && <Spinner label="טוען פניות" />}
      {error && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !error && !rows.length && (
        <EmptyState
          title={tab === "resolved" ? "אין פניות שטופלו" : "אין פניות במצב הזה 🎉"}
          meta="הטיפול בפניות מתבצע ב-WebApp (שיחות AI). מסך זה הוא לבקרה בלבד."
        />
      )}

      {!loading && !error && !!rows.length && (
        <section className="section" style={{ marginTop: "var(--s-4)" }}>
          <div className="card" style={{ padding: 0, borderTop: "3px solid var(--ink-3)", overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 980 }}>
              <thead>
                <tr style={{ background: "var(--bg-tint)" }}>
                  <Th>עסק / לקוח</Th>
                  <Th>סטטוס</Th>
                  <Th>נושא</Th>
                  <Th>תקציר</Th>
                  <Th>מטפל</Th>
                  <Th>גיל / תגובה</Th>
                  <Th align="left"></Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((esc) => {
                  const cat = esc.lastCategory || esc.category;
                  const st = (esc.handlingStatus as Status) || "waiting";
                  const meta = STATUS_META[st];
                  return (
                    <tr key={esc._id} style={{ borderTop: "1px solid var(--rule)", verticalAlign: "top" }}>
                      <Td>
                        <div style={{ fontWeight: 600, color: "var(--ink)" }}>{esc.businessName || "—"}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{esc.clientPhone}</div>
                      </Td>
                      <Td>
                        <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700, color: meta.color, background: meta.bg, whiteSpace: "nowrap" }}>
                          {meta.label}
                        </span>
                      </Td>
                      <Td>
                        <span style={{ fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{CATEGORY_LABEL[cat] || cat}</span>
                        {esc.items?.length > 1 && <span style={{ marginRight: 6, fontSize: 11, color: "var(--ink-3)" }}>+{esc.items.length - 1}</span>}
                      </Td>
                      <Td>
                        <div style={{ color: "var(--ink-2)", lineHeight: 1.5, maxWidth: 340 }}>{esc.summary}</div>
                      </Td>
                      <Td>
                        <div style={{ color: "var(--ink-2)" }}>{esc.handledByName || (st === "human" ? "נציג" : "—")}</div>
                        {esc.humanTakeoverAt && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{fmt(esc.humanTakeoverAt)}</div>}
                      </Td>
                      <Td>
                        <div style={{ fontSize: 12, color: st === "stale" ? "#C62828" : "var(--ink-2)", whiteSpace: "nowrap" }}>לפני {fmtDur(esc.ageMs)}</div>
                        {esc.responseMs != null && <div style={{ fontSize: 11, color: "var(--positive)" }}>מענה תוך {fmtDur(esc.responseMs)}</div>}
                      </Td>
                      <Td align="left">
                        {esc.status === "open" ? (
                          <Button variant="ghost" onClick={() => doResolve(esc._id)} disabled={resolving === esc._id}>
                            {resolving === esc._id ? "…" : "סמן כטופל"}
                          </Button>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--positive)" }}>טופל {fmt(esc.resolvedAt)}</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Layout>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{
    padding: "10px 12px", textAlign: align ?? "right",
    fontSize: 11, fontWeight: 700, color: "var(--ink-2)",
    textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap",
  }}>{children}</th>;
}

function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "10px 12px", textAlign: align ?? "right", verticalAlign: "top" }}>{children}</td>;
}
