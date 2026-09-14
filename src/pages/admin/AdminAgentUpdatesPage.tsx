import { useCallback, useEffect, useRef, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { getAgentTechReport, resolveAgentTechIssue, type TechReport, type TechReportItem } from "../../api/admin";

const SEV: Record<string, { label: string; color: string; bg: string }> = {
  high:   { label: "דחוף",   color: "#C62828", bg: "#FDECEA" },
  medium: { label: "בינוני", color: "#B26A00", bg: "#FFF4E5" },
  low:    { label: "נמוך",   color: "#2E7D32", bg: "#EAF6EC" },
};

function fmt(s?: string | null) {
  if (!s) return "";
  return new Date(s).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtPhone(p?: string) {
  if (!p) return "—";
  const d = String(p).replace(/\D/g, "");
  if (d.startsWith("972") && d.length === 12) return `0${d.slice(3)}`;
  return p;
}

export function AdminAgentUpdatesPage() {
  const [data, setData] = useState<TechReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);
  const [resolveMsg, setResolveMsg] = useState<Record<number, string>>({});

  const doResolve = async (i: number, it: TechReportItem) => {
    setResolving(i);
    try {
      const out = await resolveAgentTechIssue(it.tool, it.errorSample);
      if (!out.ok) throw new Error(out.error || "שגיאה");
      setResolveMsg((p) => ({ ...p, [i]: `הופעל — הסוכן מריץ מחדש ${out.clientsAffected ?? 0} לקוחות ברקע. הם יקבלו עדכון בצ׳אט.` }));
    } catch (e: any) {
      setResolveMsg((p) => ({ ...p, [i]: e?.message ?? "שגיאה בהפעלת הפתרון" }));
    } finally {
      setResolving(null);
    }
  };

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback((force = false) => {
    if (force) setRefreshing(true); else if (!data) setLoading(true);
    setError(null);
    getAgentTechReport(7, force)
      .then((r) => {
        setData(r);
        // report is generated in the background → poll until it's ready
        if (r.generating) {
          if (pollRef.current) clearTimeout(pollRef.current);
          pollRef.current = setTimeout(() => load(false), 4000);
        }
      })
      .catch((e) => setError(e?.message ?? "שגיאה בטעינת הדוח"))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [data]);

  useEffect(() => {
    load(false);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.items ?? [];

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי · חטיבת הייטק"
          title="עדכונים מהסוכן"
          meta={data ? `${data.totalFailures} כשלים · ${data.windowDays} ימים אחרונים` : "דוח תקלות טכניות + הצעות תיקון"}
        />
      }
    >
      <section className="section" style={{ marginTop: "var(--s-3)", display: "flex", gap: "var(--s-2)", alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="default" onClick={() => load(true)} disabled={refreshing}>{refreshing ? "מרענן…" : "רענן דוח"}</Button>
        {data?.generatedAt && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>עודכן {fmt(data.generatedAt)}{data.cached ? " (מטמון)" : ""}</span>}
      </section>

      {(loading || (data?.generating && !items.length)) && <Spinner label="הסוכן מנתח תקלות… (עד דקה)" />}
      {error && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !data?.generating && !error && !items.length && (
        <EmptyState title="אין תקלות טכניות בתקופה 🎉" meta="כשהסוכן ייתקל בכשלים חוזרים (שגיאות API, פרמטרים, מגבלות) — הם יסוכמו כאן עם ניתוח מפורט והצעות תיקון." />
      )}

      {!error && !!items.length && (
        <section className="section" style={{ marginTop: "var(--s-4)", display: "grid", gap: "var(--s-3)" }}>
          {items.map((it: TechReportItem, i) => {
            const sev = SEV[it.severity || "medium"] || SEV.medium;
            const expanded = open === i;
            return (
              <div key={i} className="card" style={{ padding: 0, borderRight: `4px solid ${sev.color}`, overflow: "hidden" }}>
                {/* header — click to expand */}
                <button
                  onClick={() => setOpen(expanded ? null : i)}
                  style={{ width: "100%", textAlign: "right", background: "transparent", border: "none", cursor: "pointer", padding: "14px 16px" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: sev.color, background: sev.bg, padding: "3px 9px", borderRadius: 999 }}>{sev.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{it.title || it.tool}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-3)", marginRight: "auto" }}>{it.count}× · {it.clientsAffected} לקוחות · {fmt(it.lastAt)}</span>
                    <span style={{ fontSize: 13, color: "var(--ink-3)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                    <code style={{ fontSize: 11, background: "var(--bg-tint)", padding: "2px 8px", borderRadius: 6, color: "var(--ink-2)" }}>{it.tool}</code>
                    {it.errorSample && (
                      <code style={{ fontSize: 11, color: "#C62828", direction: "ltr", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 520 }}>{it.errorSample.slice(0, 110)}</code>
                    )}
                  </div>
                </button>

                {/* expanded detail */}
                {expanded && (
                  <div style={{ padding: "0 16px 16px", borderTop: "1px solid var(--rule)", display: "grid", gap: 12 }}>
                    {it.detail && <Block title="מה קורה">{it.detail}</Block>}
                    {it.impact && <Block title="השפעה">{it.impact}</Block>}
                    {it.rootCause && <Block title="סיבת שורש">{it.rootCause}</Block>}

                    {!!it.steps?.length && (
                      <div style={{ background: "#F5F8FF", border: "1px solid #E4ECFB", borderRadius: 10, padding: "10px 14px" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#1565C0", marginBottom: 6 }}>💡 צעדי תיקון</div>
                        <ol style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 5 }}>
                          {it.steps.map((s, k) => <li key={k} style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>{s}</li>)}
                        </ol>
                      </div>
                    )}

                    {it.codePointers && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>📁 קוד רלוונטי</div>
                        <code style={{ fontSize: 12, color: "var(--ink-2)", direction: "ltr", display: "block", background: "var(--bg-tint)", padding: "8px 12px", borderRadius: 8, whiteSpace: "pre-wrap" }}>{it.codePointers}</code>
                      </div>
                    )}

                    {/* auto-resolve — re-run the affected clients' failed requests via the agent */}
                    <div style={{ background: "#EAF6EC", border: "1px solid #CDEBD3", borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#2E7D32" }}>🤖 פתרון אוטומטי</div>
                        <div style={{ fontSize: 11, color: "var(--ink-2)", marginTop: 2 }}>
                          הסוכן ירוץ מחדש על הבקשות שנכשלו של {it.clientsAffected} הלקוחות (פעולות כספיות עדיין דרך אישור הלקוח).
                        </div>
                        {resolveMsg[i] && <div style={{ fontSize: 11, color: "#2E7D32", marginTop: 4 }}>{resolveMsg[i]}</div>}
                      </div>
                      <Button variant="default" onClick={() => doResolve(i, it)} disabled={resolving === i}>
                        {resolving === i ? "מפעיל…" : "פתור אוטומטית"}
                      </Button>
                    </div>

                    {!!it.clients?.length && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>לקוחות מושפעים ({it.clients.length})</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {it.clients.slice(0, 20).map((c, k) => (
                            <span key={k} style={{ fontSize: 11, background: "var(--bg-tint)", padding: "2px 8px", borderRadius: 6, color: "var(--ink-2)" }}>{fmtPhone(c)}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {!!it.samples?.length && (
                      <details>
                        <summary style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-2)", cursor: "pointer" }}>דוגמאות גולמיות מהיומן ({it.samples.length})</summary>
                        <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                          {it.samples.map((s, k) => (
                            <div key={k} style={{ background: "var(--bg-tint)", borderRadius: 8, padding: "8px 10px", direction: "ltr" }}>
                              <div style={{ fontSize: 10, color: "var(--ink-3)" }}>{fmt(s.at)} · {fmtPhone(s.clientPhone)}</div>
                              {s.error && <div style={{ fontSize: 11, color: "#C62828", fontFamily: "monospace", marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(s.error).slice(0, 300)}</div>}
                              {s.args && <div style={{ fontSize: 10, color: "var(--ink-3)", fontFamily: "monospace", marginTop: 2, wordBreak: "break-word" }}>args: {JSON.stringify(s.args).slice(0, 200)}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </Layout>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}
