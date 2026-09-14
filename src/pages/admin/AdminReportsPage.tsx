import { useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../context/ToastContext";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

interface ReportDef {
  id:    string;
  title: string;
  desc:  string;
  emoji: string;
  accent: string;
  needs: ("year" | "from" | "to")[];
  build: (params: { year: number; from: string; to: string }) => string;
}

const THIS_YEAR  = new Date().getFullYear();
const TODAY_ISO  = new Date().toISOString().slice(0, 10);
const MONTH_AGO  = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

const REPORTS: ReportDef[] = [
  {
    id:    "monthly-pnl",
    title: "P&L חודשי",
    desc:  "הכנסה / עמלות / רווח לחודש לאורך השנה",
    emoji: "💰",
    accent: "#2E7D32",
    needs: ["year"],
    build: ({ year }) => `monthly-pnl?year=${year}`,
  },
  {
    id:    "manager-performance",
    title: "ביצועי מנהלים",
    desc:  "לקוחות, עסקאות, הכנסה ועמלות פר מנהל. ל-HR / ביקורת.",
    emoji: "👥",
    accent: "#7C3AED",
    needs: ["from", "to"],
    build: ({ from, to }) => `manager-performance?from=${from}&to=${to}`,
  },
  {
    id:    "client-list",
    title: "רשימת לקוחות",
    desc:  "צילום מצב מלא של כל הלקוחות במערכת לחשבונאות.",
    emoji: "📋",
    accent: "var(--blue)",
    needs: [],
    build: () => "client-list",
  },
  {
    id:    "vat",
    title: "דוח מע״מ",
    desc:  "פירוט עסקאות עם חישוב מע״מ 17% — חובת ציות חודשי.",
    emoji: "🧾",
    accent: "#FB8C00",
    needs: ["from", "to"],
    build: ({ from, to }) => `vat?from=${from}&to=${to}`,
  },
  {
    id:    "activity",
    title: "דוח פעילות (Audit)",
    desc:  "כל פעולת אדמין/מנהל בטווח תאריכים — אקספורט מלא של audit log.",
    emoji: "📝",
    accent: "#E53935",
    needs: ["from", "to"],
    build: ({ from, to }) => `activity?from=${from}&to=${to}`,
  },
];

export function AdminReportsPage() {
  const [year, setYear] = useState(THIS_YEAR);
  const [from, setFrom] = useState(MONTH_AGO);
  const [to,   setTo]   = useState(TODAY_ISO);
  const [downloading, setDownloading] = useState<string | null>(null);
  const toast = useToast();

  async function download(report: ReportDef) {
    setDownloading(report.id);
    try {
      const url = `${API_BASE}/cpanel/admin/reports/${report.build({ year, from, to })}`;
      const token = localStorage.getItem("cpanel_token");
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const fname = cd.match(/filename="([^"]+)"/)?.[1] || `${report.id}.csv`;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fname;
      link.click();
      URL.revokeObjectURL(link.href);
      toast.ok(`הורד: ${fname}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "הורדה נכשלה");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="דוחות וייצוא"
          meta="CSV מותאם ל-Excel · כולל BOM לעברית · כל ייצוא מתועד ב-audit"
        />
      }
    >
      {/* Date params bar */}
      <section className="section" style={{ marginTop: 0 }}>
        <div className="card" style={{ padding: "var(--s-4) var(--s-5)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <Field label="שנה (ל-P&L)">
              <input
                type="number"
                value={year}
                min={2020}
                max={THIS_YEAR + 1}
                onChange={e => setYear(Number(e.target.value))}
                dir="ltr"
                style={inputStyle}
              />
            </Field>
            <Field label="מתאריך">
              <input
                type="date"
                value={from}
                onChange={e => setFrom(e.target.value)}
                dir="ltr"
                style={inputStyle}
              />
            </Field>
            <Field label="עד תאריך">
              <input
                type="date"
                value={to}
                onChange={e => setTo(e.target.value)}
                dir="ltr"
                style={inputStyle}
              />
            </Field>
          </div>
          <p className="t-meta" style={{ marginTop: 6, fontSize: 11 }}>
            הפרמטרים נחוצים רק לדוחות שדורשים אותם (מסומן בכל כרטיס למטה).
          </p>
        </div>
      </section>

      {/* Reports grid */}
      <section className="section" style={{ marginTop: "var(--s-4)" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "var(--s-4)",
        }}>
          {REPORTS.map(r => (
            <ReportCard
              key={r.id}
              report={r}
              downloading={downloading === r.id}
              onDownload={() => download(r)}
            />
          ))}
        </div>
      </section>
    </Layout>
  );
}

function ReportCard({ report, downloading, onDownload }: {
  report: ReportDef;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <div className="card" style={{
      padding: "var(--s-5)",
      borderTop: `3px solid ${report.accent}`,
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div>
        <div style={{ fontSize: 28, marginBottom: 4 }}>{report.emoji}</div>
        <h3 style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)", margin: 0 }}>{report.title}</h3>
        <p className="t-meta" style={{ marginTop: 6, fontSize: 12 }}>{report.desc}</p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {report.needs.map(n => (
          <span key={n} style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 99,
            background: "var(--bg-tint)", color: "var(--ink-3)",
          }}>
            {n === "year" ? "📅 שנה" : n === "from" ? "📅 מתאריך" : "📅 עד תאריך"}
          </span>
        ))}
      </div>

      <div style={{ marginTop: "auto" }}>
        <Button onClick={onDownload} disabled={downloading} size="sm">
          {downloading ? "מוריד…" : "📥 הורד CSV"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--rule)",
  background: "var(--paper)",
  fontSize: 13,
  color: "var(--ink)",
};
