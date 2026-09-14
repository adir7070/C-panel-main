import { useEffect, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { getAuditLog, type AuditEntry } from "../../api/admin";

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getAuditLog({ limit: 200 })
      .then(r => { if (!cancelled) setEntries(r.entries); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="יומן ביקורת"
          meta={`${entries.length} פעולות`}
        />
      }
    >
      {loading && <Spinner label="טוען ביקורת" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !error && entries.length === 0 && (
        <EmptyState title="אין רשומות ביקורת" meta="כל פעולה רגישה תופיע כאן." />
      )}

      {entries.length > 0 && (
        <section className="section" style={{ marginTop: 0 }}>
          <div className="card" style={{
            padding: "var(--s-2)", borderTop: "3px solid #E53935",
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--bg-tint)" }}>
                  <Th>תאריך</Th>
                  <Th>מבצע</Th>
                  <Th>פעולה</Th>
                  <Th>יעד</Th>
                  <Th>פרטים</Th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e._id} style={{ borderTop: "1px solid var(--rule)" }}>
                    <Td><span dir="ltr" className="num" style={{ fontSize: 11 }}>{formatDateTime(e.at)}</span></Td>
                    <Td>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{e.actor?.name || "—"}</div>
                      <div className="t-meta" style={{ fontSize: 10 }}>{e.actor?.role || ""}</div>
                    </Td>
                    <Td><code style={{ fontSize: 11 }}>{e.action}</code></Td>
                    <Td>
                      {e.target?.label ? (
                        <span style={{ fontSize: 12 }}>{e.target.label}</span>
                      ) : e.target?.id ? (
                        <span dir="ltr" style={{ fontSize: 11 }}>{e.target.kind}/{e.target.id}</span>
                      ) : <span className="t-meta">—</span>}
                    </Td>
                    <Td>
                      {(e.before != null || e.after != null) && (
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--blue)" }}>diff</summary>
                          <pre style={{
                            fontSize: 10, marginTop: 6, padding: 8,
                            background: "var(--bg-tint)", borderRadius: 4,
                            overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
                          }}>{JSON.stringify({ before: e.before, after: e.after, meta: e.meta }, null, 2)}</pre>
                        </details>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Layout>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "10px 12px", verticalAlign: "top" }}>{children}</td>;
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}
