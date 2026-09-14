import { useEffect, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { getAdminFinanceRevenue, type FinanceRevenue } from "../../api/admin";

function formatIls(n: number): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n || 0);
}

export function AdminRevenuePage() {
  const [data, setData]       = useState<FinanceRevenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [months, setMonths]   = useState(12);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getAdminFinanceRevenue(months)
      .then(d => { if (!cancelled) setData(d); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [months]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי › פיננסים"
          title="הכנסות"
          meta={data ? `${data.byMonth.length} חודשים בתצוגה` : undefined}
        />
      }
    >
      {loading && <Spinner label="טוען הכנסות" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {data && (
        <>
          {/* Summary KPIs */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "var(--s-4)" }}>
              <Stat label="הכנסה כוללת" value={formatIls(data.summary.revenueTotal)} meta={`${data.summary.dealsTotal} עסקאות`} tone="green" />
              <Stat label="החודש"        value={formatIls(data.summary.revenueMonth)} tone="blue" />
              <Stat label="חודש שעבר"    value={formatIls(data.summary.revenueLastMonth)} />
              <Stat
                label="מגמה"
                value={data.summary.trendPct !== null
                  ? `${data.summary.trendPct >= 0 ? "+" : ""}${data.summary.trendPct.toFixed(1)}%`
                  : "—"}
                tone={data.summary.trendPct !== null && data.summary.trendPct >= 0 ? "green" : "red"}
              />
            </div>
          </section>

          {/* Range selector */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="t-meta">טווח:</span>
              {[3, 6, 12, 24].map(m => (
                <button
                  key={m}
                  onClick={() => setMonths(m)}
                  style={{
                    padding: "4px 12px", borderRadius: 99,
                    border: `1px solid ${months === m ? "var(--blue)" : "var(--rule)"}`,
                    background: months === m ? "var(--blue)" : "transparent",
                    color: months === m ? "#fff" : "var(--ink)",
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}
                >{m} חודשים</button>
              ))}
            </div>
          </section>

          {/* Monthly chart */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div className="card" style={{ padding: "var(--s-5)", borderTop: "3px solid var(--blue)" }}>
              <h3 className="t-section">הכנסה לחודש</h3>
              <MonthlyBars data={data.byMonth} />
            </div>
          </section>

          {/* Three breakdowns */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "var(--s-4)" }}>
              <BreakdownPanel title="לפי חבילה" rows={data.byPackage.map(p => ({ label: p.name, total: p.total, count: p.count }))} accent="#7C3AED" />
              <BreakdownPanel title="לפי מנהל"  rows={data.byManager.map(m => ({ label: m.name, total: m.total, count: m.count }))} accent="#2E7D32" />
              <BreakdownPanel title="לפי רמה"   rows={data.byTier.map(t => ({ label: t.tier, total: t.total, count: t.count }))} accent="var(--blue)" />
            </div>
          </section>
        </>
      )}
    </Layout>
  );
}

function Stat({ label, value, meta, tone }: { label: string; value: string; meta?: string; tone?: "green" | "blue" | "red" }) {
  const accent = tone === "green" ? "#2E7D32" : tone === "red" ? "#E53935" : tone === "blue" ? "var(--blue)" : "var(--ink-3)";
  return (
    <div className="card" style={{ padding: "var(--s-4) var(--s-5)", borderTop: `3px solid ${accent}` }}>
      <p className="t-eyebrow">{label}</p>
      <p className="num" dir="ltr" style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)", marginTop: 4 }}>{value}</p>
      {meta && <p className="t-meta" style={{ fontSize: 11, marginTop: 4 }}>{meta}</p>}
    </div>
  );
}

function MonthlyBars({ data }: { data: { month: string; total: number; count: number }[] }) {
  if (data.length === 0) return <p className="t-meta" style={{ marginTop: 12 }}>אין נתונים לטווח זה</p>;
  const max = Math.max(...data.map(d => d.total), 1);
  return (
    <div style={{ marginTop: "var(--s-4)", display: "flex", alignItems: "flex-end", gap: 6, height: 180, paddingBottom: 24, position: "relative" }}>
      {data.map(d => {
        const h = (d.total / max) * 140;
        return (
          <div key={d.month} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }} title={`${d.month} · ${formatIls(d.total)} (${d.count} עסקאות)`}>
            <div className="num" dir="ltr" style={{ fontSize: 9, color: "var(--ink-3)" }}>
              {d.total >= 1000 ? `${Math.round(d.total / 1000)}K` : d.total}
            </div>
            <div style={{
              width: "100%", height: Math.max(h, 2),
              background: "var(--blue)", borderRadius: "4px 4px 0 0",
            }} />
            <div className="num" dir="ltr" style={{ fontSize: 9, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{d.month}</div>
          </div>
        );
      })}
    </div>
  );
}

function BreakdownPanel({ title, rows, accent }: { title: string; rows: { label: string; total: number; count: number }[]; accent: string }) {
  const max = Math.max(...rows.map(r => r.total), 1);
  return (
    <div className="card" style={{ padding: "var(--s-5)", borderTop: `3px solid ${accent}` }}>
      <h3 className="t-section">{title}</h3>
      {rows.length === 0
        ? <p className="t-meta" style={{ marginTop: 12 }}>אין נתונים</p>
        : (
          <div style={{ marginTop: "var(--s-4)", display: "grid", gap: 8 }}>
            {rows.map((r, i) => (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
                  <span className="num" dir="ltr" style={{ fontWeight: 700, fontSize: 12, color: "var(--ink)" }}>{formatIls(r.total)}</span>
                </div>
                <div style={{ height: 4, background: "var(--bg-tint)", borderRadius: 99 }}>
                  <div style={{ width: `${(r.total / max) * 100}%`, height: "100%", background: accent, borderRadius: 99 }} />
                </div>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}
