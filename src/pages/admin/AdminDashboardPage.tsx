import { useEffect, useState, useRef } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { getAdminDashboard, type AdminDashboard } from "../../api/admin";
import { usePurchaseSync } from "../../hooks/usePurchaseSync";

const URGENCY_COLOR: Record<string, string> = {
  red:    "#E53935",
  orange: "#FB8C00",
  yellow: "#FDD835",
};

function formatIls(n: number): string {
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(n || 0);
}

export function AdminDashboardPage() {
  const [data,    setData]    = useState<AdminDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  /* A purchase anywhere bumps syncTick → refetch, keeping the current
     numbers on screen instead of flashing the spinner. */
  const [syncTick, setSyncTick] = useState(0);
  usePurchaseSync(() => setSyncTick(t => t + 1));
  // silent only with numbers already on screen — a first load must show its error
  const hasDataRef = useRef(false);
  useEffect(() => { hasDataRef.current = data !== null; }, [data]);

  useEffect(() => {
    let cancelled = false;
    const silent = syncTick > 0 && hasDataRef.current;
    if (!silent) { setLoading(true); setError(null); }
    getAdminDashboard()
      .then(d => { if (!cancelled) { setData(d); setError(null); } })
      // a failed background refresh keeps the numbers that are already showing
      .catch(err => { if (!cancelled && !silent) setError(err instanceof Error ? err.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [syncTick]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="דשבורד אדמין"
          meta="תצוגה מאוחדת על כל המנהלים"
        />
      }
    >
      {loading && <Spinner label="טוען נתונים" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {data && (
        <>
          {/* Alerts feed */}
          {data.alerts.length > 0 && (
            <section className="section" style={{ marginTop: 0 }}>
              <div style={{ display: "grid", gap: 6 }}>
                {data.alerts.map((a, i) => {
                  const color = URGENCY_COLOR[a.urgency] || "var(--blue)";
                  return (
                    <div key={i} className="card" style={{
                      borderInlineStart: `4px solid ${color}`,
                      padding: "10px 14px",
                      display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: 99, background: color,
                      }} />
                      <span style={{ fontSize: 13, color: "var(--ink)" }}>{a.message}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* KPI cards */}
          <section className="section" style={{ marginTop: data.alerts.length > 0 ? "var(--s-5)" : 0 }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "var(--s-4)",
            }}>
              <Kpi label="הכנסה היום"      value={formatIls(data.kpis.revenueToday)}   tone="blue" />
              <Kpi label="הכנסה החודש"     value={formatIls(data.kpis.revenueMonth)}   tone="violet" meta={`${data.kpis.purchasesMonth} עסקאות`} />
              <Kpi label="הכנסה כוללת"     value={formatIls(data.kpis.revenueTotal)}   tone="green" />
              <Kpi label="לקוחות במערכת"   value={data.kpis.clientsTotal.toLocaleString()} />
              <Kpi label="מנהלי תיקים"     value={data.kpis.managersActive.toLocaleString()} meta={`${data.kpis.managersTotal} סה״כ`} />
              <Kpi label="חבילות בתהליך"   value={Object.values(data.kpis.packagesByStatus).reduce((a, b) => a + b, 0).toLocaleString()} meta="מצב פעיל" />
            </div>
          </section>

          {/* Revenue trend (90 days) */}
          <section className="section" style={{ marginTop: "var(--s-5)" }}>
            <div className="card" style={{
              padding: "var(--s-5)",
              borderTop: "3px solid var(--blue)",
            }}>
              <h3 className="t-section">מגמת הכנסות · 90 ימים</h3>
              <RevenueSparkline data={data.revenueTrend} />
            </div>
          </section>

          {/* Two-column: package mix + top managers */}
          <section className="section" style={{ marginTop: "var(--s-5)" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "var(--s-4)",
            }}>
              <PackageMixPanel rows={data.packageMix} />
              <TopManagersPanel rows={data.topManagers} />
            </div>
          </section>

          {/* Project status breakdown */}
          <section className="section" style={{ marginTop: "var(--s-5)" }}>
            <div className="card" style={{ padding: "var(--s-5)", borderTop: "3px solid var(--blue)" }}>
              <h3 className="t-section">פירוט סטטוסי חבילות</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--s-3)", marginTop: "var(--s-4)" }}>
                {Object.entries(data.kpis.packagesByStatus).map(([key, count]) => (
                  <div key={key} style={{
                    background: "var(--bg-tint)", padding: "10px 12px", borderRadius: 8,
                    border: "1px solid var(--rule)",
                  }}>
                    <div className="num" dir="ltr" style={{ fontSize: 22, fontWeight: 800, color: "var(--ink)" }}>
                      {count}
                    </div>
                    <div className="t-meta" style={{ fontSize: 11, marginTop: 2 }}>{statusLabel(key)}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
    </Layout>
  );
}

function statusLabel(key: string): string {
  const labels: Record<string, string> = {
    waiting_brief:               "ממתין להשלמת איפיון",
    sent_to_creation:            "נשלח ליצירה",
    waiting_manager_approval:    "ממתין לאישור מנהל",
    sent_to_client:              "נשלח לאישור לקוח",
    client_returned_corrections: "החזיר תיקונים",
    in_correction:               "בתיקון",
    corrections_done:            "הושלמו תיקונים",
    client_approved:             "לקוח אישר",
    completed:                   "הסתיים",
  };
  return labels[key] || key;
}

function Kpi({ label, value, meta, tone }: { label: string; value: string; meta?: string; tone?: "blue" | "violet" | "green" }) {
  const accent = tone === "violet" ? "#7C3AED" : tone === "green" ? "#2E7D32" : "var(--blue)";
  return (
    <div className="card" style={{
      padding: "var(--s-4) var(--s-5)",
      borderTop: `3px solid ${accent}`,
    }}>
      <p className="t-eyebrow">{label}</p>
      <p className="num" dir="ltr" style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)", marginTop: 4 }}>
        {value}
      </p>
      {meta && <p className="t-meta" style={{ fontSize: 11, marginTop: 4 }}>{meta}</p>}
    </div>
  );
}

function RevenueSparkline({ data }: { data: { date: string; total: number }[] }) {
  if (data.length === 0) {
    return <p className="t-meta" style={{ marginTop: 12 }}>אין נתונים ל-90 ימים האחרונים</p>;
  }
  const max = Math.max(...data.map(d => d.total), 1);
  const W = 100;
  const H = 30;
  const points = data.map((d, i) => {
    const x = (i / Math.max(data.length - 1, 1)) * W;
    const y = H - (d.total / max) * H;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div style={{ marginTop: "var(--s-4)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 120 }}>
        <polyline points={points} fill="none" stroke="var(--blue)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span className="t-meta">{data[0]?.date}</span>
        <span className="t-meta">{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function PackageMixPanel({ rows }: { rows: { name: string; total: number; count: number }[] }) {
  return (
    <div className="card" style={{ padding: "var(--s-5)", borderTop: "3px solid #7C3AED" }}>
      <h3 className="t-section">חבילות פופולריות · החודש</h3>
      {rows.length === 0
        ? <p className="t-meta" style={{ marginTop: 12 }}>טרם בוצעו רכישות החודש</p>
        : (
          <div style={{ marginTop: "var(--s-4)", display: "grid", gap: 6 }}>
            {rows.map(r => (
              <div key={r.name} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "baseline" }}>
                <span style={{ fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span className="t-meta" dir="ltr">{r.count}×</span>
                <span className="num" dir="ltr" style={{ fontWeight: 700, color: "var(--ink)" }}>{formatIls(r.total)}</span>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}

function TopManagersPanel({ rows }: { rows: { agentId: string; name: string; total: number; count: number }[] }) {
  return (
    <div className="card" style={{ padding: "var(--s-5)", borderTop: "3px solid #2E7D32" }}>
      <h3 className="t-section">טופ מנהלים · החודש</h3>
      {rows.length === 0
        ? <p className="t-meta" style={{ marginTop: 12 }}>אין הכנסות החודש</p>
        : (
          <div style={{ marginTop: "var(--s-4)", display: "grid", gap: 6 }}>
            {rows.map((r, i) => (
              <div key={r.agentId} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 10, alignItems: "baseline" }}>
                <span style={{
                  width: 22, height: 22, borderRadius: 99,
                  background: i === 0 ? "#FBBF24" : i === 1 ? "#9CA3AF" : i === 2 ? "#D97706" : "var(--bg-tint)",
                  color: i < 3 ? "#fff" : "var(--ink-3)",
                  fontSize: 11, fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                }}>{i + 1}</span>
                <span style={{ fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                <span className="t-meta" dir="ltr">{r.count}×</span>
                <span className="num" dir="ltr" style={{ fontWeight: 700, color: "var(--ink)" }}>{formatIls(r.total)}</span>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}
