import { useCallback, useMemo } from "react";
import { getAgentWallet, type AgentWallet, type WalletCommission } from "../api/client";
import { useApi } from "../hooks/useApi";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { KpiCard } from "../components/charts/KpiCard";
import { LineChart, type LineSeries } from "../components/charts/LineChart";

const SOURCE_LABELS: Record<string, string> = {
  direct_charge: "חיוב טוקן ישיר",
  payment_link:  "לינק תשלום",
  package:       "חבילה",
};

const SOURCE_COLORS: Record<string, "blue" | "cyan" | "violet" | "amber" | "green"> = {
  direct_charge: "violet",
  payment_link:  "blue",
  package:       "cyan",
};

export function WalletPage() {
  const fetcher = useCallback(() => getAgentWallet(), []);
  const { data, loading, error, reload } = useApi<AgentWallet>(fetcher, [fetcher]);

  const trendSeries = useMemo<LineSeries[]>(() => {
    if (!data) return [];
    return [{
      name: "עמלות יומיות",
      color: "#7C3AED",
      fill: "rgba(124,58,237,0.12)",
      points: (data.trend || []).map(d => ({
        label: dateShort(d.date),
        value: d.earned,
      })),
    }];
  }, [data]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ארנק"
          title="ארנק העמלות שלי"
          meta={data ? `${formatIls(data.totalEarned, data.currency)} נצבר במצטבר` : "טוען..."}
          trailing={<Button variant="ghost" size="sm" onClick={reload}>רענן</Button>}
        />
      }
    >
      {loading ? <Spinner label="טוען נתוני ארנק" /> :
        error ? <EmptyState title="שגיאה" meta={error} action={<Button onClick={reload}>נסה שוב</Button>} /> :
        !data ? <EmptyState title="אין נתונים" /> :
        <>
          {/* ── KPIs row ───────────────────────────────────────── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: "var(--s-4)",
            marginBottom: "var(--s-7)",
          }}>
            <KpiCard
              label="יתרה פעילה"
              value={<BigCurrency amount={data.balance} currency={data.currency} />}
              meta={`${formatIls(data.totalPaid, data.currency)} כבר שולם`}
              chip="green"
              spark={(data.trend || []).map(d => d.earned)}
            />
            <KpiCard
              label="הרווחת החודש"
              value={<BigCurrency amount={data.monthEarned} currency={data.currency} />}
              meta={`${data.recent.filter(c => isThisMonth(c.earnedAt)).length} עמלות`}
              chip="violet"
            />
            <KpiCard
              label="סך נצבר אי-פעם"
              value={<BigCurrency amount={data.totalEarned} currency={data.currency} />}
              meta={`עמלה ${(data.commissionRate * 100).toFixed(1)}%`}
              chip="blue"
            />
            <KpiCard
              label="מחזור חיובים ללקוחות"
              value={<BigCurrency amount={data.totalCharged} currency={data.currency} />}
              meta="הסכום שגלגלת בלקוחות"
              chip="amber"
            />
          </div>

          {/* ── Trend chart ────────────────────────────────────── */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
              <h3 className="t-section">עמלות יומיות · 30 ימים אחרונים</h3>
              <p className="t-meta">סה״כ {formatIls((data.trend || []).reduce((s, d) => s + d.earned, 0), data.currency)}</p>
            </div>
            {(data.trend || []).length === 0 ? (
              <EmptyState title="אין עמלות עדיין" meta="ברגע שלקוח ישלם — העמלה תיצבר אוטומטית כאן." />
            ) : (
              <LineChart
                series={trendSeries}
                height={220}
                showLegend={false}
                formatValue={(n) => formatIls(n, data.currency)}
              />
            )}
          </section>

          {/* ── Recent commissions table ───────────────────────── */}
          <section className="section">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
              <h3 className="t-section">תנועות אחרונות</h3>
              <p className="t-meta">{data.recent.length} רשומות</p>
            </div>
            {data.recent.length === 0 ? (
              <EmptyState
                title="טרם נצברו עמלות"
                meta="כל פעם שתחייב/י לקוח, חלק מסכום החיוב יצטבר כאן כעמלה אישית שלך."
              />
            ) : (
              <CommissionsTable rows={data.recent} currency={data.currency} />
            )}
          </section>
        </>
      }
    </Layout>
  );
}

/* ── helpers ────────────────────────────────────────────────────────── */

function BigCurrency({ amount, currency }: { amount: number; currency: string }) {
  return (
    <span style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }} dir="ltr">
      {formatIls(amount, currency)}
    </span>
  );
}

function CommissionsTable({ rows, currency }: { rows: WalletCommission[]; currency: string }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--rule)", borderRadius: "var(--r-2)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: "var(--bg-tint)" }}>
            <Th>תאריך</Th>
            <Th>לקוח</Th>
            <Th>מקור</Th>
            <Th align="left">חיוב בסיס</Th>
            <Th align="left">% עמלה</Th>
            <Th align="left">סכום עמלה</Th>
            <Th>סטטוס</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderTop: "1px solid var(--rule)" }}>
              <Td>{formatDateTime(r.earnedAt)}</Td>
              <Td><span dir="ltr" className="num">{r.clientPhone || "—"}</span></Td>
              <Td>
                <Badge variant={SOURCE_COLORS[r.sourceKind] === "violet" ? "clay" : "default"}>
                  {SOURCE_LABELS[r.sourceKind] || r.sourceKind}
                </Badge>
              </Td>
              <Td align="left"><span dir="ltr" className="num">{formatIls(r.baseAmount, currency)}</span></Td>
              <Td align="left"><span dir="ltr" className="num">{(r.commissionRate * 100).toFixed(1)}%</span></Td>
              <Td align="left">
                <strong dir="ltr" className="num" style={{ color: "var(--blue)" }}>
                  {formatIls(r.commissionAmount, currency)}
                </strong>
              </Td>
              <Td>
                <Badge variant={r.status === "paid" ? "positive" : "default"}>
                  {r.status === "paid" ? "שולם" : "צבור"}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{ padding: "10px 12px", textAlign: align ?? "right", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</th>;
}

function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "10px 12px", textAlign: align ?? "right", verticalAlign: "middle" }}>{children}</td>;
}

function formatIls(n: number, currency: string = "ILS") {
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n || 0);
}

function dateShort(iso: string) {
  if (!iso) return "";
  /* Backend trend format: YYYY-MM-DD. */
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
}

function formatDateTime(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

function isThisMonth(iso: string) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}
