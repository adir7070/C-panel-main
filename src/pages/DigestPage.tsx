import { useState } from "react";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { useApi } from "../hooks/useApi";
import { Spinner } from "../components/ui/Spinner";
import { TierBadge } from "../components/ui/TierBadge";
import { IcoAiBrain, IcoChartBars, IcoBellAlert, IcoMultiSend } from "../components/icons/BrandIcons";
import { useToast } from "../context/ToastContext";
import {
  getDigestSchedule,
  setDigestSchedule,
  runDigestNow,
  getDashboardSummary,
  type DigestSchedule,
  type AiDigestItem,
} from "../api/client";

/* ─── helpers ────────────────────────────────────────────────── */
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad2 = (n: number) => String(n).padStart(2, "0");

const fmtDate = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("he-IL", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

type Channel = DigestSchedule["channels"][number];

const CHANNELS: { key: Channel; label: string }[] = [
  { key: "inapp",    label: "התראה בתוך האפליקציה" },
  { key: "email",    label: "אימייל" },
  { key: "sms",      label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
];

const KIND_LABEL: Record<AiDigestItem["kind"], string> = {
  stale_chat:          "שיחה תקועה",
  low_credit:          "קרדיט נמוך",
  missed_appointment:  "פגישה שפוספסה",
  high_intent:         "כוונת רכישה גבוהה",
  churn_risk:          "סיכון נטישה",
};

const SEV_COLOR: Record<AiDigestItem["severity"], string> = {
  high: "var(--negative)",
  med:  "var(--warning)",
  low:  "var(--positive)",
};

const SEV_LABEL: Record<AiDigestItem["severity"], string> = {
  high: "דחוף",
  med:  "בינוני",
  low:  "נמוך",
};

/* ─── DigestPage ─────────────────────────────────────────────── */
export function DigestPage() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveItems, setLiveItems] = useState<AiDigestItem[] | null>(null);
  const [form, setForm] = useState<Partial<DigestSchedule>>({});

  const { data: schedule, loading, error, reload } =
    useApi<DigestSchedule>(() => getDigestSchedule(), []);

  const { data: dashboard, loading: dashLoading } =
    useApi(() => getDashboardSummary(), []);

  const merged: DigestSchedule = {
    enabled: true,
    hour: 8,
    channels: ["inapp"],
    ...(schedule ?? {}),
    ...form,
  };

  function patch(fields: Partial<DigestSchedule>) {
    setForm((prev) => ({ ...prev, ...fields }));
  }

  function toggleChannel(ch: Channel) {
    const current = merged.channels ?? [];
    const next = current.includes(ch)
      ? current.filter((c) => c !== ch)
      : ([...current, ch] as Channel[]);
    patch({ channels: next });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await setDigestSchedule(merged);
      toast.ok("הגדרות דייג'סט נשמרו");
      setForm({});
      reload();
    } catch {
      toast.error("שגיאה בשמירת ההגדרות");
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setLiveItems(null);
    try {
      const result = await runDigestNow();
      setLiveItems(result.items ?? []);
      toast.ok("דייג'סט הופעל בהצלחה");
      reload();
    } catch {
      toast.error("שגיאה בהפעלת הדייג'סט");
    } finally {
      setRunning(false);
    }
  }

  const hasChanges = Object.keys(form).length > 0;

  return (
    <Layout
      header={
        <Header
          eyebrow="AI"
          title="דייג'סט יומי"
          trailing={
            <button
              className="btn-primary"
              onClick={handleRunNow}
              disabled={running}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              {running
                ? <Spinner size="sm" />
                : <IconPlay />
              }
              הפעל עכשיו
            </button>
          }
        />
      }
    >
      <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>

        {/* ── Page header panel ── */}
        <div className="card" style={{
          padding: "var(--s-5) var(--s-6)",
          borderTop: "3px solid var(--blue)",
          display: "flex", alignItems: "center", gap: "var(--s-5)", flexWrap: "wrap",
        }}>
          <div style={{
            width: 52, height: 52,
            borderRadius: "var(--r-3)",
            background: "var(--blue-soft)",
            border: "1px solid var(--blue-line)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24,
          }}>🤖</div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <p style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, color: "var(--blue)", marginBottom: 3 }}>
              AI Daily Digest
            </p>
            <h2 style={{ fontSize: "var(--t-xl)", fontWeight: 800, margin: 0, color: "var(--ink)", letterSpacing: "-0.01em" }}>
              דייג'סט חכם לכל יום
            </h2>
            <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", marginTop: 5, maxWidth: 520, lineHeight: 1.5 }}>
              ה-AI מנתח את הלקוחות, השיחות, והפגישות ושולח לך תקציר ממוקד עם הפעולות החשובות ביותר להיום.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: "var(--bg-tint)", borderRadius: "var(--r-pill)", border: "1px solid var(--rule)" }}>
            <span className="pulse-dot" style={{ background: merged.enabled ? "var(--positive)" : "var(--ink-4)" }} />
            <span style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>
              {merged.enabled ? "פעיל" : "מושהה"} · {pad2(merged.hour)}:00
            </span>
          </div>
        </div>

        {/* ── Status strip ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)" }}>
          <DigestStat label="הפעלה אחרונה" value={fmtDate(schedule?.lastRunAt)} color="var(--blue)" bg="var(--blue-soft)" />
          <DigestStat label="הפעלה הבאה"   value={fmtDate(schedule?.nextRunAt)} color="#0891B2"     bg="#CFFAFE" />
          <DigestStat label="ערוצים"        value={(merged.channels ?? []).length.toString()} color="#7C3AED" bg="#EDE9FE" />
          <DigestStat label="שעת שליחה"    value={`${pad2(merged.hour)}:00`} color="var(--positive)" bg="var(--positive-bg)" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5)" }}>

          {/* ── Schedule settings ── */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            <h3 style={{ margin: 0, fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--blue)" }}>
              הגדרות תזמון
            </h3>

            {loading ? (
              <div style={{ padding: "24px 0", textAlign: "center" }}><Spinner /></div>
            ) : error ? (
              <p style={{ color: "var(--negative)", fontSize: "var(--t-xs)" }}>שגיאה בטעינת הגדרות</p>
            ) : (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", cursor: "pointer" }}>
                  <ToggleSwitch
                    checked={merged.enabled}
                    onChange={(v) => patch({ enabled: v })}
                  />
                  <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>
                    {merged.enabled ? "דייג'סט יומי פעיל" : "דייג'סט יומי מושהה"}
                  </span>
                </label>

                <div>
                  <label style={{ display: "block", fontSize: "var(--t-xs)", color: "var(--ink-3)", marginBottom: 6 }}>
                    שעת שליחה יומית
                  </label>
                  <select
                    className="input"
                    value={merged.hour}
                    onChange={(e) => patch({ hour: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>{pad2(h)}:00</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "var(--t-xs)", color: "var(--ink-3)", marginBottom: 8 }}>
                    ערוצי שליחה
                  </label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {CHANNELS.map(({ key, label }) => (
                      <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={merged.channels?.includes(key) ?? false}
                          onChange={() => toggleChannel(key)}
                          style={{ width: 16, height: 16, accentColor: "var(--blue)" }}
                        />
                        <span style={{ fontSize: "var(--t-sm)" }}>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={saving || !hasChanges}
                  style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}
                >
                  {saving ? <Spinner size="sm" /> : null}
                  שמור הגדרות
                </button>
              </>
            )}
          </div>

          {/* ── Live summary metrics ── */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            <h3 style={{ margin: 0, fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--blue)" }}>
              סיכום תקופה (7 ימים)
            </h3>
            {dashLoading ? (
              <div style={{ padding: "24px 0", textAlign: "center" }}><Spinner /></div>
            ) : dashboard ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" }}>
                <MetricTile label="לקוחות פעילים"    value={dashboard.clients.active7d} />
                <MetricTile label="הודעות שנשלחו"    value={dashboard.messages.sent7d} />
                <MetricTile label="לידים בפייפליין"  value={dashboard.pipeline.leads}   color="var(--cyan)" />
                <MetricTile label="עסקאות שנסגרו"    value={dashboard.pipeline.won}     color="var(--cyan)" />
                <MetricTile label="הוצאות"            value={`₪${(dashboard.spend7d ?? 0).toLocaleString()}`}   color="var(--warning)" />
                <MetricTile label="הכנסות"            value={`₪${(dashboard.revenue7d ?? 0).toLocaleString()}`} color="var(--positive)" />
              </div>
            ) : (
              <p style={{ color: "var(--ink-3)", fontSize: "var(--t-xs)", textAlign: "center", padding: "24px 0" }}>
                אין נתוני דשבורד
              </p>
            )}
          </div>
        </div>

        {/* ── Live digest result ── */}
        {(running || liveItems !== null) && (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
            <h3 style={{ margin: 0, fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--blue)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                background: running ? "var(--warning)" : "var(--positive)",
              }} />
              {running ? "מייצר דייג'סט…" : "דייג'סט אחרון"}
            </h3>

            {running && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
                <Spinner size="sm" />
                <span>ה-AI מנתח נתוני לקוחות, לידים ופגישות…</span>
              </div>
            )}

            {liveItems !== null && liveItems.length === 0 && (
              <p style={{ color: "var(--ink-3)", fontSize: "var(--t-sm)", textAlign: "center", padding: "16px 0" }}>
                אין פריטים לדייג'סט
              </p>
            )}

            {liveItems?.map((item, i) => (
              <DigestItemCard key={i} item={item} />
            ))}
          </div>
        )}

        {/* ── How it works ── */}
        <div className="card" style={{ background: "var(--blue-soft)" }}>
          <h3 style={{ margin: "0 0 var(--s-3)", fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--blue)" }}>
            איך עובד הדייג'סט היומי?
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--s-4)" }}>
            {DIGEST_STEPS.map((step) => (
              <div key={step.title} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <DigestStepIcon id={step.id} size={20} />
                  <span style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--blue)" }}>{step.title}</span>
                </div>
                <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--ink-3)", lineHeight: 1.5 }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </Layout>
  );
}

/* ─── Sub-components ─────────────────────────────────────────── */

function DigestStat({ label, value, color }: { label: string; value: string; color: string; bg?: string }) {
  return (
    <div className="card" style={{
      padding: "var(--s-4)",
      borderTop: `3px solid ${color}`,
      cursor: "default",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ background: color }} />
        <p style={{ fontSize: 11, fontWeight: 700, color: color, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</p>
      </div>
      <p className="num" style={{
        fontSize: "var(--t-base)", fontWeight: 800, color: "var(--ink)",
        marginTop: 6, lineHeight: 1.2, letterSpacing: "-0.01em",
      }}>{value}</p>
    </div>
  );
}

function MetricTile({ label, value, color = "var(--blue)" }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: "var(--bg)", borderRadius: "var(--r-2)", padding: "10px 14px" }}>
      <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--ink-3)" }}>{label}</p>
      <p style={{ margin: "2px 0 0", fontSize: "var(--t-md)", fontWeight: 800, color }}>{value}</p>
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 999,
        border: "none",
        background: checked ? "var(--blue)" : "var(--rule-strong)",
        cursor: "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
      }}
    >
      <span style={{
        position: "absolute",
        top: 3,
        left: checked ? 23 : 3,
        width: 18, height: 18,
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.2s",
        boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function DigestItemCard({ item }: { item: AiDigestItem }) {
  const color = SEV_COLOR[item.severity] ?? "var(--ink-3)";
  const isPriority = item.tier === "GOLD" || item.tier === "VIP";

  return (
    <div style={{
      display: "flex", gap: "var(--s-3)",
      padding: "12px 14px",
      background: isPriority ? "var(--warning-bg, rgba(253,171,61,0.08))" : "var(--bg)",
      borderRadius: "var(--r-2)",
      borderRight: `3px solid ${color}`,
      alignItems: "flex-start",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <p style={{ margin: 0, fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>
            {KIND_LABEL[item.kind] ?? item.kind}
          </p>
          {item.tier && item.tier !== "REGULAR" && <TierBadge tier={item.tier} size="sm" />}
        </div>
        <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--ink-3)", lineHeight: 1.5 }}>
          {item.reason}
        </p>
        <p style={{ margin: "4px 0 0", fontSize: "var(--t-xs)", color: "var(--blue)", fontWeight: 600 }}>
          👤 {item.clientName}
        </p>
      </div>
      <span style={{
        flexShrink: 0,
        fontSize: "var(--t-xs)", fontWeight: 700,
        color,
        background: color + "15",
        padding: "2px 8px",
        borderRadius: 999,
      }}>
        {SEV_LABEL[item.severity] ?? item.severity}
      </span>
    </div>
  );
}

const DIGEST_STEPS: { id: "ai" | "stats" | "alerts" | "send"; title: string; desc: string }[] = [
  { id: "ai",     title: "ניתוח AI",            desc: "GPT-4o סורק את כל הלקוחות, הלידים, הפגישות והמשימות הפתוחות." },
  { id: "stats",  title: "מדדים חיים",           desc: "שולף נתוני ביצוע מהיום: הודעות, תגובות, המרות, הכנסות." },
  { id: "alerts", title: "התראות חכמות",         desc: "מזהה לקוחות שלא טופלו, לידים שפגו תוקפם ופגישות ממחר." },
  { id: "send",   title: "שליחה מרובת ערוצים",   desc: "מפיץ לאפליקציה, אימייל, SMS ו-WhatsApp — לפי ההעדפות שלך." },
];

function DigestStepIcon({ id, size = 22 }: { id: "ai" | "stats" | "alerts" | "send"; size?: number }) {
  if (id === "ai")     return <IcoAiBrain    size={size} />;
  if (id === "stats")  return <IcoChartBars  size={size} />;
  if (id === "alerts") return <IcoBellAlert  size={size} />;
  return                       <IcoMultiSend size={size} />;
}

function IconPlay() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
