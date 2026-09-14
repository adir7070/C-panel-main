import { useCallback, useEffect, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import {
  getAdminIntegrations,
  type IntegrationCheck,
  type IntegrationsReport,
  type IntegrationStatus,
} from "../../api/admin";

const STATUS_META: Record<IntegrationStatus, { label: string; color: string; emoji: string }> = {
  ok:      { label: "פעיל",   color: "#2E7D32", emoji: "🟢" },
  warn:    { label: "התראה",  color: "#FB8C00", emoji: "🟡" },
  error:   { label: "תקלה",   color: "#E53935", emoji: "🔴" },
  unknown: { label: "לא ידוע", color: "#9699A6", emoji: "⚪" },
};

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function AdminIntegrationsPage() {
  const [data, setData]       = useState<IntegrationsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const reload = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const d = await getAdminIntegrations();
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    reload(false);
    /* Auto-refresh every 30s — integrations health is live data. */
    const interval = window.setInterval(() => reload(true), 30_000);
    return () => window.clearInterval(interval);
  }, [reload]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="בריאות אינטגרציות"
          meta={data ? `נבדק ב-${formatDateTime(data.checkedAt)} · רענון אוטומטי כל 30 שניות` : undefined}
        />
      }
    >
      {loading && <Spinner label="בודק אינטגרציות" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {data && (
        <>
          {/* Summary */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--s-3)" }}>
              <SummaryCard label="סך הכל"      value={data.summary.total}  color="var(--ink-3)" />
              <SummaryCard label="פעילים"       value={data.summary.ok}     color="#2E7D32"      emoji="🟢" />
              <SummaryCard label="התראות"       value={data.summary.warn}   color="#FB8C00"      emoji="🟡" />
              <SummaryCard label="תקלות"        value={data.summary.error}  color="#E53935"      emoji="🔴" />
            </div>
            <div style={{ marginTop: "var(--s-3)", textAlign: "left" }}>
              <Button onClick={() => reload(false)} variant="ghost" size="sm" disabled={refreshing}>
                {refreshing ? "מרענן…" : "רענן עכשיו"}
              </Button>
            </div>
          </section>

          {/* Integration cards */}
          <section className="section" style={{ marginTop: "var(--s-4)" }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "var(--s-4)",
            }}>
              {data.integrations.map(i => <IntegrationCard key={i.name} check={i} />)}
            </div>
          </section>

          <p className="t-meta" style={{ marginTop: "var(--s-5)", textAlign: "center", fontSize: 11 }}>
            💡 רוב הבדיקות נעשות נגד MongoDB ושדות ENV — לא בקריאות חיות לשירותי הצד השלישי. זה שומר על הדף מהיר ולא יקר. בעיות אמיתיות מתגלות בעת שליחה.
          </p>
        </>
      )}
    </Layout>
  );
}

function SummaryCard({ label, value, color, emoji }: { label: string; value: number; color: string; emoji?: string }) {
  return (
    <div className="card" style={{ padding: "var(--s-3) var(--s-4)", borderTop: `3px solid ${color}` }}>
      <p className="t-eyebrow">{label}</p>
      <p className="num" dir="ltr" style={{ fontSize: 24, fontWeight: 800, color, marginTop: 4 }}>
        {emoji && <span style={{ fontSize: 16, marginInlineEnd: 6 }}>{emoji}</span>}
        {value}
      </p>
    </div>
  );
}

function IntegrationCard({ check }: { check: IntegrationCheck }) {
  const meta = STATUS_META[check.status] || STATUS_META.unknown;
  const metaEntries = Object.entries(check.meta || {});
  return (
    <div className="card" style={{
      padding: "var(--s-4) var(--s-5)",
      borderTop: `3px solid ${meta.color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)", margin: 0 }}>{check.name}</h3>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          padding: "3px 10px", borderRadius: 99,
          background: meta.color + "1a", color: meta.color,
          fontSize: 11, fontWeight: 700,
        }}>
          {meta.emoji} {meta.label}
        </span>
      </div>

      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 6 }}>{check.detail}</p>

      {metaEntries.length > 0 && (
        <div style={{
          marginTop: "var(--s-3)", paddingTop: "var(--s-2)",
          borderTop: "1px dashed var(--rule)",
          display: "grid", gap: 3,
        }}>
          {metaEntries.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 10 }}>
              <span className="t-meta">{k}</span>
              <span dir="ltr" className="num" style={{ color: "var(--ink-2)", fontFamily: "ui-monospace, monospace" }}>
                {String(v).slice(0, 40)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
