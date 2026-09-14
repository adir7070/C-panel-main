import { useCallback, useState, useMemo } from "react";
import {
  getClientLeads, getClientFbLeadForms, getClientFbLeads, markFbLeadFollowedUp,
  type FbLead, type FbLeadForm,
} from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../context/ToastContext";
import { SectionHead } from "../ui/SectionHead";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";
import { FeatureUnavailable } from "../ui/FeatureUnavailable";
import { IcoCheck } from "../icons/BrandIcons";
import { KpiCard } from "../charts/KpiCard";
import { LineChart } from "../charts/LineChart";

interface Props { phone: string }

const PERIODS: { days: number; label: string }[] = [
  { days: 7,  label: "7 ימים"  },
  { days: 14, label: "14 יום" },
  { days: 30, label: "30 יום" },
];

export function LeadsTab({ phone }: Props) {
  const [days, setDays] = useState(7);
  const [view, setView] = useState<"trend" | "leads">("trend");

  return (
    <div style={{ display: "grid", gap: "var(--s-7)" }}>
      <section className="section" style={{ marginTop: 0 }}>
        <SectionHead
          eyebrow="Performance"
          title="ביצועים"
          meta="נתונים מ-Meta Marketing API, פר-לקוח"
          action={
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              {PERIODS.map(p => (
                <Button
                  key={p.days}
                  size="sm"
                  variant={p.days === days ? "default" : "ghost"}
                  onClick={() => setDays(p.days)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          }
        />

        <div className="tabs" style={{ marginBottom: "var(--s-5)", maxWidth: 360 }}>
          <button className={"tab " + (view === "trend" ? "active" : "")} onClick={() => setView("trend")}>
            סקירה
          </button>
          <button className={"tab " + (view === "leads" ? "active" : "")} onClick={() => setView("leads")}>
            לידים מפייסבוק
          </button>
        </div>

        {view === "trend" ? <TrendView phone={phone} days={days} /> : <FbLeadsView phone={phone} days={days} />}
      </section>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Trend view — aggregate counts + chart
   ───────────────────────────────────────────────────────────────────── */
function TrendView({ phone, days }: { phone: string; days: number }) {
  const fetcher = useCallback(() => getClientLeads(phone, days), [phone, days]);
  const { data, loading, error, errorCode, reload } = useApi(fetcher, [fetcher]);

  if (loading) return <Spinner label="טוען נתוני לידים" />;
  if (errorCode === "fb_unavailable") {
    return <FeatureUnavailable title="נתוני ביצועים לא זמינים" meta="הסקירה נשענת על Meta Marketing API ודורשת חיבור פייסבוק, שכבוי כרגע." />;
  }
  if (error)   return <ErrorBlock message={error} onRetry={reload} />;
  if (!data)   return null;

  const trend = data.trend ?? [];
  const totalLeads = data.total ?? 0;
  const totalSpend = trend.reduce((s, p) => s + (p.spend ?? 0), 0);
  const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;

  // Compute trend delta (first half vs second half)
  const half = Math.floor(trend.length / 2);
  const a = trend.slice(0, half).reduce((s, p) => s + (p.leads ?? 0), 0);
  const b = trend.slice(half).reduce((s, p) => s + (p.leads ?? 0), 0);
  const leadsDelta = a > 0 ? Math.round(((b - a) / a) * 100) : undefined;

  return (
    <>
      {data.error && (
        <div className="badge badge-warning" style={{ marginBottom: "var(--s-4)" }}>
          {data.error}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "var(--s-4)",
        marginBottom: "var(--s-6)",
      }}>
        <KpiCard
          chip="blue"
          icon={<SvgTarget />}
          label="סך לידים"
          value={totalLeads.toLocaleString("he-IL")}
          delta={leadsDelta}
          deltaLabel="לעומת חצי קודם"
          spark={trend.map(p => p.leads ?? 0)}
        />
        <KpiCard
          chip="violet"
          icon={<SvgCoin />}
          label="הוצאה"
          value={`₪${totalSpend.toLocaleString("he-IL")}`}
          spark={trend.map(p => p.spend ?? 0)}
          sparkColor="#7C3AED"
        />
        <KpiCard
          chip="green"
          icon={<SvgTrend />}
          label="עלות לליד"
          value={cpl != null ? `₪${cpl.toFixed(2)}` : "—"}
          meta={
            cpl == null ? "אין נתונים"
            : cpl < 50  ? "ביצועים מצוינים"
            : cpl < 150 ? "ביצועים טובים"
            : "טעון אופטימיזציה"
          }
        />
      </div>

      <div className="card">
        <SectionHead eyebrow="Trend" title={`מגמת לידים — ${days} ימים`} meta="קו לידים מול קו הוצאה" />
        {trend.length === 0 ? (
          <EmptyState title="אין נתונים" meta="לא נמצאה היסטוריית לידים בתקופה הנבחרת." />
        ) : (
          <LineChart
            height={240}
            series={[
              {
                name: "לידים",
                color: "var(--blue)",
                fill: "rgba(30, 58, 138, 0.10)",
                points: trend.map(p => ({ label: dateShort(p.date), value: p.leads ?? 0 })),
              },
              {
                name: "הוצאה (₪)",
                color: "#7C3AED",
                points: trend.map(p => ({ label: dateShort(p.date), value: p.spend ?? 0 })),
              },
            ]}
            formatValue={n => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(Math.round(n))}
          />
        )}
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Facebook Lead Ads — real submissions per client
   ───────────────────────────────────────────────────────────────────── */
function FbLeadsView({ phone, days }: { phone: string; days: number }) {
  const [formId, setFormId] = useState<string | "">("");
  const toast = useToast();

  const formsFetcher = useCallback(() => getClientFbLeadForms(phone), [phone]);
  const { data: formsData, loading: formsLoading, error: formsError, errorCode: formsErrorCode } = useApi(formsFetcher, [formsFetcher]);

  const leadsFetcher = useCallback(() => getClientFbLeads(phone, { formId: formId || undefined, days, limit: 200 }), [phone, formId, days]);
  const { data: leadsData, loading: leadsLoading, error: leadsError, errorCode: leadsErrorCode, reload: reloadLeads } = useApi(leadsFetcher, [leadsFetcher]);

  const forms: FbLeadForm[] = formsData?.forms ?? [];
  const leads: FbLead[] = leadsData?.leads ?? [];

  const followedUpCount = useMemo(() => leads.filter(l => l.isFollowedUp).length, [leads]);

  async function toggleFollowUp(lead: FbLead) {
    const next = !lead.isFollowedUp;
    try {
      await markFbLeadFollowedUp(phone, lead.id, next);
      toast.ok(next ? "סומן שהיה מעקב" : "הוסר סימון מעקב");
      reloadLeads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    }
  }

  if (formsErrorCode === "fb_unavailable" || leadsErrorCode === "fb_unavailable") {
    return <FeatureUnavailable title="לידים מפייסבוק לא זמינים" meta="משיכת לידים מטפסי פייסבוק דורשת חיבור פייסבוק, שכבוי כרגע." />;
  }

  if (formsError && /404|not found|missing/i.test(formsError)) {
    return (
      <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)" }}>
        <p className="t-eyebrow" style={{ color: "var(--blue)" }}>חיבור Meta נדרש</p>
        <p className="t-body" style={{ marginTop: 6 }}>
          לא נמצא Facebook Page ID או Access Token ללקוח הזה. עבור לטאב <strong>פרופיל</strong> והזן את הנתונים.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-5)" }}>
      <div className="card" style={{ padding: "var(--s-4) var(--s-5)" }}>
        <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", flexWrap: "wrap" }}>
          <Badge variant="clay">Live · Meta API</Badge>
          <span className="t-meta">
            {leads.length} לידים · {followedUpCount} בוצע מעקב
          </span>
          <div style={{ flex: 1 }} />
          <select
            className="input"
            value={formId}
            onChange={e => setFormId(e.target.value)}
            disabled={formsLoading || forms.length === 0}
            style={{ maxWidth: 280 }}
          >
            <option value="">כל הטפסים ({forms.length})</option>
            {forms.map(f => (
              <option key={f.id} value={f.id}>
                {f.name} {f.status !== "ACTIVE" ? `· ${f.status}` : ""}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="sm" onClick={reloadLeads}>רענן</Button>
        </div>
      </div>

      {formsLoading || leadsLoading ? (
        <Spinner label="מושך לידים מפייסבוק" />
      ) : leadsError ? (
        <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)" }}>
          <p className="t-eyebrow" style={{ color: "var(--blue)" }}>endpoint נדרש בשרת</p>
          <p className="t-body" style={{ marginTop: 6 }}>
            התכונה הזו משתמשת ב-token של הלקוח (FB Page Access Token) דרך השרת. צריך:
          </p>
          <ul style={{ marginTop: 8, paddingInlineStart: 20, fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.8 }}>
            <li><span className="mono">GET /cpanel/clients/:phone/fb-lead-forms</span> — רשימת טפסים בעמוד</li>
            <li><span className="mono">GET /cpanel/clients/:phone/fb-leads?formId=…&days=…&limit=200</span> — הלידים עצמם</li>
            <li><span className="mono">POST /cpanel/clients/:phone/fb-leads/:id/followed-up</span> — סימון מעקב</li>
          </ul>
          <p className="t-meta" style={{ marginTop: 8 }}>
            השרת מבצע את הקריאה ל-<span className="mono">graph.facebook.com/{`{form_id}`}/leads</span> עם ה-Page Access Token של הלקוח (כבר ב-DB), ומחזיר רשימה נורמלית של submissions.
          </p>
        </div>
      ) : leads.length === 0 ? (
        <EmptyState
          title="אין לידים בתקופה"
          meta={`לא נמצאו submissions ב-${days} הימים האחרונים${formId ? " בטופס שנבחר" : ""}.`}
        />
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "var(--bg-tint)", borderBottom: "1px solid var(--rule)" }}>
                  <th style={th}>שם</th>
                  <th style={th}>טלפון</th>
                  <th style={th}>אימייל</th>
                  <th style={th}>טופס / קמפיין</th>
                  <th style={thRight}>נשלח</th>
                  <th style={{ ...th, width: 120 }}>מעקב</th>
                </tr>
              </thead>
              <tbody>
                {leads.map(lead => <FbLeadRow key={lead.id} lead={lead} onToggle={() => toggleFollowUp(lead)} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FbLeadRow({ lead, onToggle }: { lead: FbLead; onToggle: () => void }) {
  const name  = lead.fields.full_name || lead.fields.name || lead.fields["שם_מלא"] || "—";
  const phone = lead.fields.phone_number || lead.fields.phone || lead.fields["טלפון"] || "";
  const email = lead.fields.email || "";
  const customFields = Object.entries(lead.fields).filter(([k]) =>
    !["full_name", "name", "שם_מלא", "phone_number", "phone", "טלפון", "email"].includes(k)
  );

  return (
    <tr style={{ borderBottom: "1px solid var(--rule)" }}>
      <td style={{ padding: "12px 16px" }}>
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{name}</p>
          {customFields.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: "var(--blue)", cursor: "pointer", fontWeight: 600 }}>
                {customFields.length} שדות נוספים
              </summary>
              <ul style={{ marginTop: 6, fontSize: 12, color: "var(--ink-2)", listStyle: "none", padding: 0 }}>
                {customFields.map(([k, v]) => (
                  <li key={k} style={{ paddingTop: 2 }}>
                    <strong style={{ color: "var(--ink-3)" }}>{k}:</strong> {v}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </td>
      <td style={{ padding: "12px 16px", fontFamily: "var(--mono)", fontSize: 13, direction: "ltr", textAlign: "right" }}>
        {phone ? <a href={`tel:${phone}`}>{phone}</a> : <span style={{ color: "var(--ink-4)" }}>—</span>}
      </td>
      <td style={{ padding: "12px 16px", fontSize: 13, direction: "ltr", textAlign: "right" }}>
        {email ? <a href={`mailto:${email}`}>{email}</a> : <span style={{ color: "var(--ink-4)" }}>—</span>}
      </td>
      <td style={{ padding: "12px 16px", fontSize: 12, color: "var(--ink-2)" }}>
        <p style={{ fontWeight: 600 }}>{lead.formName ?? lead.formId}</p>
        {lead.campaignName && <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{lead.campaignName}</p>}
      </td>
      <td style={{ padding: "12px 16px", textAlign: "left", fontSize: 12, color: "var(--ink-3)" }}>
        <span className="tabular">{relativeTime(lead.createdAt)}</span>
        <p className="tabular" style={{ fontSize: 11, marginTop: 2 }} dir="ltr">
          {new Date(lead.createdAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
        </p>
      </td>
      <td style={{ padding: "12px 16px" }}>
        <button
          onClick={onToggle}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: 0,
            background: lead.isFollowedUp ? "var(--positive-bg)" : "var(--bg-tint)",
            color: lead.isFollowedUp ? "var(--positive)" : "var(--ink-2)",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {lead.isFollowedUp ? <><IcoCheck size={12} /> בוצע</> : "סמן מעקב"}
        </button>
      </td>
    </tr>
  );
}

const th: React.CSSProperties = {
  padding: "12px 16px",
  textAlign: "right",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--ink-3)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const thRight: React.CSSProperties = { ...th, textAlign: "left" };

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card">
      <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
      <p className="t-body" style={{ marginTop: "var(--s-3)" }}>{message}</p>
      <div style={{ marginTop: "var(--s-5)" }}>
        <Button onClick={onRetry}>נסה שוב</Button>
      </div>
    </div>
  );
}

function dateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000)     return "עכשיו";
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}ד'`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}ש'`;
  return new Date(iso).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

const I = {
  width: 18, height: 18, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};
function SvgTarget() { return <svg {...I}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>; }
function SvgCoin()   { return <svg {...I}><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9.5a1.5 1.5 0 0 0 0 3H14"/></svg>; }
function SvgTrend()  { return <svg {...I}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>; }

