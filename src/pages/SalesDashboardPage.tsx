import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useApi } from "../hooks/useApi";
import { usePurchaseSync } from "../hooks/usePurchaseSync";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton, SkeletonKpiTile, SkeletonStack } from "../components/ui/Skeleton";
import { KpiCard } from "../components/charts/KpiCard";
import { LineChart } from "../components/charts/LineChart";
import { DonutChart } from "../components/charts/DonutChart";
import { LeadCard } from "../components/leads/LeadParts";
import { IcoTarget, IcoPhone, IcoCheck, IcoTrendUp, IcoFile, IcoCoin } from "../components/icons/Icons";
import {
  getLeadDashboard, LEAD_STATUSES, LEAD_STATUS_LABEL, LEAD_STATUS_COLOR,
  type DashboardLead,
} from "../api/leads";
import { formatIls } from "../api/quotes";

/**
 * Home screen of a "sales" user (מכירות): what is waiting for them and how
 * their leads are doing. Everything comes from GET /api/leads/dashboard,
 * which only counts the caller's own leads and the quotes they built.
 */
export function SalesDashboardPage() {
  const { agent } = useAuth();
  const navigate = useNavigate();

  const fetcher = useCallback(() => getLeadDashboard(), []);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);
  // a payment flips a lead to "לקוח פעיל" server-side — show it
  usePurchaseSync(() => reload());

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : hour < 21 ? "ערב טוב" : "לילה טוב";
  const today = new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
  const name = agent?.nickname || agent?.name || "";

  const grid = (min: number): React.CSSProperties => ({
    display: "grid",
    gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
    gap: "var(--s-4)",
    marginBottom: "var(--s-5)",
  });

  return (
    <Layout
      header={
        <Header
          title={name ? `${greeting}, ${name}` : greeting}
          meta={today}
          trailing={
            <div style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={reload}>רענן</Button>
              <Button size="sm" onClick={() => navigate("/leads")}>הלידים שלי</Button>
            </div>
          }
        />
      }
    >
      {loading && !data ? (
        <>
          <div style={grid(200)}>{[0, 1, 2, 3].map(i => <SkeletonKpiTile key={i} />)}</div>
          <div style={grid(280)}>
            {[0, 1, 2].map(i => (
              <div key={i} className="card card-static" style={{ padding: "var(--s-4)", minHeight: 240 }}>
                <Skeleton variant="title" width={140} style={{ marginBottom: 12 }} />
                <SkeletonStack rows={5} gap={10} />
              </div>
            ))}
          </div>
        </>
      ) : error || !data ? (
        <EmptyState
          title="לא הצלחנו לטעון את הדשבורד"
          meta={error ?? undefined}
          action={<Button size="sm" onClick={reload}>נסה שוב</Button>}
        />
      ) : (
        <>
          {/* ── What needs doing now ── */}
          <div style={grid(200)}>
            <KpiCard
              label="לידים חדשים היום"
              value={data.newToday.toLocaleString("he-IL")}
              meta={`השבוע ${data.newWeek} · החודש ${data.newMonth}`}
              chip="blue" icon={<IcoTarget size={18} />}
              spark={data.daily.map(d => d.created)}
            />
            <KpiCard
              label="ממתינים לשיחה ראשונה"
              value={data.byStatus.new.toLocaleString("he-IL")}
              meta="בסטטוס חדש"
              chip="violet" icon={<IcoPhone size={18} />}
              onClick={() => navigate("/leads")}
            />
            <KpiCard
              label="להתקשר שוב"
              value={data.byStatus.call_again.toLocaleString("he-IL")}
              meta={`לסלוק: ${data.byStatus.to_charge}`}
              chip="amber" icon={<IcoPhone size={18} />}
              onClick={() => navigate("/leads")}
            />
            <KpiCard
              label="נסגרו החודש"
              value={data.activatedMonth.toLocaleString("he-IL")}
              meta={`אחוז המרה כולל ${data.conversionRate}% (${data.converted} מתוך ${data.total})`}
              chip="green" icon={<IcoTrendUp size={18} />}
              spark={data.daily.map(d => d.activated)}
            />
          </div>

          {/* ── Trend + status mix ── */}
          <div style={{ ...grid(300), gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" }}>
            <div className="card" style={{ minWidth: 0 }}>
              <SectionTitle eyebrow="14 ימים" title="לידים שנכנסו ולקוחות שנסגרו" />
              <LineChart
                height={200}
                series={[
                  {
                    name: "לידים חדשים",
                    color: "#0073EA",
                    fill: "rgba(0,115,234,0.08)",
                    points: data.daily.map(d => ({ label: shortDate(d.date), value: d.created })),
                  },
                  {
                    name: "נסגרו (לקוח פעיל)",
                    color: "#16A34A",
                    points: data.daily.map(d => ({ label: shortDate(d.date), value: d.activated })),
                  },
                ]}
                /* Counts — label whole-number gridlines only, so small
                   numbers don't print "1, 1, 2, 2". */
                formatValue={n => (Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : "")}
              />
            </div>
            <div className="card" style={{ minWidth: 0 }}>
              <SectionTitle eyebrow="כל הלידים שלי" title="לפי סטטוס" />
              {data.total === 0 ? (
                <p className="t-meta" style={{ padding: "var(--s-4) 0" }}>עדיין אין לידים משויכים אלייך.</p>
              ) : (
                <DonutChart
                  data={LEAD_STATUSES.map(s => ({ label: LEAD_STATUS_LABEL[s], value: data.byStatus[s], color: LEAD_STATUS_COLOR[s] }))}
                  centerValue={data.total}
                  centerLabel="לידים"
                />
              )}
            </div>
          </div>

          {/* ── Work lists ── */}
          <div style={{ ...grid(280), gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
            <LeadList title="לידים חדשים" count={data.byStatus.new} accent={LEAD_STATUS_COLOR.new}
              rows={data.fresh} empty="אין לידים חדשים שמחכים לך" when="createdAt" onOpen={id => navigate(`/leads/${id}`)} />
            <LeadList title="להתקשר שוב" count={data.byStatus.call_again} accent={LEAD_STATUS_COLOR.call_again}
              rows={data.callAgain} empty="אין לידים שמחכים לשיחה חוזרת" when="updatedAt" onOpen={id => navigate(`/leads/${id}`)} />
            <LeadList title="לסלוק" count={data.byStatus.to_charge} accent={LEAD_STATUS_COLOR.to_charge}
              rows={data.toCharge} empty="אין לידים שמחכים לסליקה" when="updatedAt" onOpen={id => navigate(`/leads/${id}`)} />
          </div>

          {/* ── Quotes ── */}
          <SectionTitle eyebrow="הצעות מחיר" title="ההצעות שבנית" />
          <div style={grid(200)}>
            <KpiCard label="הצעות מחיר" value={data.quotes.total.toLocaleString("he-IL")} chip="cyan" icon={<IcoFile size={18} />} />
            <KpiCard label="ממתינות לחתימה" value={data.quotes.pending.toLocaleString("he-IL")} chip="amber" icon={<IcoFile size={18} />} />
            <KpiCard
              label="נחתמו"
              value={data.quotes.signed.toLocaleString("he-IL")}
              meta={`החודש ${data.quotes.signedMonth}`}
              chip="green" icon={<IcoCheck size={18} />}
            />
            <KpiCard
              label="סכום ההצעות שנחתמו"
              value={formatIls(data.quotes.signedNet)}
              meta="לכל תקופת ההתחייבות, לפני מע״מ"
              chip="pink" icon={<IcoCoin size={18} />}
            />
          </div>
        </>
      )}
    </Layout>
  );
}

function LeadList({ title, count, accent, rows, empty, when, onOpen }: {
  title: string;
  count: number;
  accent: string;
  rows: DashboardLead[];
  empty: string;
  /** Which date the row shows: when the lead came in, or when it last changed. */
  when: "createdAt" | "updatedAt";
  onOpen: (id: string) => void;
}) {
  return (
    <LeadCard title={title} count={count} accent={accent}>
      {rows.length === 0 ? (
        <p className="t-meta" style={{ margin: 0 }}>{empty}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
          {rows.map(l => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onOpen(l.id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 0", background: "none", border: 0, borderTop: "1px solid var(--rule)",
                  cursor: "pointer", textAlign: "right", color: "inherit", font: "inherit",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 13, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.name || l.phoneRaw || l.phone}
                    {l.business && <span className="t-meta" style={{ fontWeight: 500 }}> · {l.business}</span>}
                  </p>
                  <p className="t-meta" dir="ltr" style={{ margin: 0, fontSize: 12, textAlign: "right" }}>{l.phoneRaw || l.phone}</p>
                </div>
                <span className="t-meta" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{timeAgo(l[when])}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && count > rows.length && (
        <p className="t-meta" style={{ margin: 0, fontSize: 12 }}>ועוד {count - rows.length} במסך הלידים</p>
      )}
    </LeadCard>
  );
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div style={{ marginBottom: "var(--s-3)" }}>
      <p className="t-eyebrow" style={{ margin: 0 }}>{eyebrow}</p>
      <h3 style={{ margin: "2px 0 0", fontSize: "var(--t-md)", fontWeight: 700, color: "var(--ink)" }}>{title}</h3>
    </div>
  );
}

/** "2026-11-24" → "24/11" */
function shortDate(ymd: string): string {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שע׳`;
  const d = Math.floor(h / 24);
  if (d < 7) return `לפני ${d} ימים`;
  return new Date(iso).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}
