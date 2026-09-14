import { useCallback, useMemo, useState } from "react";
import {
  getClients,
  getBroadcastTemplates,
  getBroadcastHistory,
  sendBroadcast,
  type Client,
  type BroadcastTemplate,
} from "../api/client";
import { useApi } from "../hooks/useApi";
import { useToast } from "../context/ToastContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { Input, Textarea } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { SectionHead } from "../components/ui/SectionHead";

type Channel = "sms" | "whatsapp" | "both";
type AudienceMode = "all" | "selected" | "filter";

export function BroadcastPage() {
  const toast = useToast();
  const fetcher = useCallback(async () => {
    const [clients, tpl, hist] = await Promise.all([
      getClients(),
      getBroadcastTemplates().catch(() => ({ templates: [] as BroadcastTemplate[] })),
      getBroadcastHistory().catch(() => ({ items: [] })),
    ]);
    return { clients, templates: tpl.templates, history: hist.items };
  }, []);
  const { data, loading, reload } = useApi(fetcher, [fetcher]);

  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [mode, setMode] = useState<AudienceMode>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [body, setBody] = useState("");
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);

  const clients: Client[] = data?.clients ?? [];
  const templates = data?.templates ?? [];
  const history = data?.history ?? [];

  const filteredClients = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter(c => {
      if (q && !(c.name?.toLowerCase().includes(q) || c.phone.includes(q))) return false;
      if (mode === "filter" && filterStatus !== "all" && c.status !== filterStatus) return false;
      return true;
    });
  }, [clients, search, mode, filterStatus]);

  const audienceCount = useMemo(() => {
    if (mode === "all") return clients.length;
    if (mode === "selected") return selected.size;
    return filteredClients.length;
  }, [mode, clients.length, selected.size, filteredClients.length]);

  const audiencePhones = useMemo(() => {
    if (mode === "all") return clients.map(c => c.phone);
    if (mode === "selected") return clients.filter(c => selected.has(c.phone)).map(c => c.phone);
    return filteredClients.map(c => c.phone);
  }, [mode, clients, selected, filteredClients]);

  const charCount = body.length;
  const smsParts = Math.max(1, Math.ceil(charCount / 70)); // Hebrew unicode ~70 per part

  function applyTemplate(t: BroadcastTemplate) {
    setBody(t.body);
  }

  function toggleSelect(phone: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  }
  function selectAllVisible() {
    setSelected(new Set(filteredClients.map(c => c.phone)));
  }
  function clearSelection() { setSelected(new Set()); }

  async function send() {
    if (!body.trim()) { toast.error("חובה להזין תוכן הודעה"); return; }
    if (audienceCount === 0) { toast.error("בחר לפחות נמען אחד"); return; }
    if (!confirm(`לשלוח ${channelLabel(channel)} ל-${audienceCount} נמענים?`)) return;
    setSending(true);
    try {
      const audience = mode === "selected"
        ? { kind: "selected" as const, phones: audiencePhones }
        : mode === "filter"
        ? { kind: "filter" as const, status: filterStatus === "all" ? undefined : filterStatus }
        : { kind: "all" as const };
      const res = await sendBroadcast({
        channel, audience, message: body.trim(),
        scheduleAt: scheduleAt || undefined,
      });
      toast.ok(`נשלח · job ${res.jobId.slice(0, 8)}…`);
      setBody("");
      setScheduleAt("");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשליחה");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <Layout header={<Header eyebrow="שליחה רחבה" title="Broadcast" />}>
        <Spinner label="טוען" />
      </Layout>
    );
  }

  return (
    <Layout
      header={
        <Header
          eyebrow="שליחה רחבה"
          title="Broadcast"
          meta="SMS + WhatsApp דרך SMS4Free ו-Green API"
          trailing={<Badge>{audienceCount} נמענים</Badge>}
        />
      }
    >
      {/* Stats strip */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)" }}>
          <BroadcastKpi label="נמענים אפשריים" value={clients.length} color="var(--blue)" bg="var(--blue-soft)" />
          <BroadcastKpi label="ייבחרו עכשיו"  value={audienceCount}    color="#0891B2"     bg="#CFFAFE" />
          <BroadcastKpi label="תבניות"         value={templates.length} color="#7C3AED"     bg="#EDE9FE" />
          <BroadcastKpi label="שליחות אחרונות" value={history.length}   color="var(--positive)" bg="var(--positive-bg)" />
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: "var(--s-5)" }}>

        {/* ── Composer ── */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
          <SectionHead eyebrow="Compose" title="הרכבת ההודעה" />

          {/* Channel */}
          <Field label="ערוץ">
            <div className="tabs" style={{ width: "100%", maxWidth: 420 }}>
              <button className={"tab " + (channel === "whatsapp" ? "active" : "")} onClick={() => setChannel("whatsapp")}>WhatsApp</button>
              <button className={"tab " + (channel === "sms" ? "active" : "")} onClick={() => setChannel("sms")}>SMS</button>
              <button className={"tab " + (channel === "both" ? "active" : "")} onClick={() => setChannel("both")}>שניהם</button>
            </div>
          </Field>

          {/* Audience */}
          <Field label="קהל יעד" hint="ניתן לבחור הכל, סינון לפי סטטוס, או לבחור ידנית">
            <div className="tabs" style={{ width: "100%", maxWidth: 420 }}>
              <button className={"tab " + (mode === "all" ? "active" : "")} onClick={() => setMode("all")}>הכל ({clients.length})</button>
              <button className={"tab " + (mode === "filter" ? "active" : "")} onClick={() => setMode("filter")}>סינון</button>
              <button className={"tab " + (mode === "selected" ? "active" : "")} onClick={() => setMode("selected")}>בחירה ({selected.size})</button>
            </div>
          </Field>

          {mode === "filter" && (
            <Field label="סטטוס לקוח">
              <select
                className="input"
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                style={{ maxWidth: 240 }}
              >
                <option value="all">כל הסטטוסים</option>
                <option value="open">פעיל</option>
                <option value="pending">ממתין</option>
                <option value="closed">סגור</option>
              </select>
            </Field>
          )}

          {/* Templates */}
          {templates.length > 0 && (
            <Field label="תבניות מוכנות">
              <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
                {templates.map(t => (
                  <button
                    key={t.id}
                    onClick={() => applyTemplate(t)}
                    className="badge"
                    style={{ cursor: "pointer", border: "1px solid var(--blue-line)", background: "var(--blue-soft)", color: "var(--blue)" }}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {/* Body */}
          <Field
            label="תוכן ההודעה"
            hint={`${charCount} תווים · ${smsParts} חלק${smsParts > 1 ? "ים" : ""} SMS · ניתן להשתמש ב-{שם} למילוי אוטומטי`}
          >
            <Textarea
              rows={6}
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="היי {שם}, רצינו לעדכן אותך על המבצע השבועי החדש..."
            />
          </Field>

          {/* Schedule */}
          <Field label="תזמון" hint="אופציונלי — השאר ריק לשליחה מיידית">
            <Input
              type="datetime-local"
              value={scheduleAt}
              onChange={e => setScheduleAt(e.target.value)}
              dir="ltr"
              style={{ maxWidth: 280 }}
            />
          </Field>

          {/* CTA */}
          <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
            <Button onClick={send} loading={sending} size="lg" disabled={!body.trim() || audienceCount === 0}>
              {scheduleAt ? "תזמן שליחה" : "שלח עכשיו"} ({audienceCount})
            </Button>
            <span className="t-meta">
              {channelLabel(channel)} · {audienceCount.toLocaleString("he-IL")} נמענים
            </span>
          </div>
        </div>

        {/* ── Audience picker / preview ── */}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          {mode === "selected" ? (
            <>
              <SectionHead
                eyebrow="Audience"
                title="בחר נמענים"
                action={
                  <div style={{ display: "flex", gap: "var(--s-2)" }}>
                    <Button size="sm" variant="ghost" onClick={selectAllVisible}>בחר הכל</Button>
                    <Button size="sm" variant="ghost" onClick={clearSelection}>נקה</Button>
                  </div>
                }
              />
              <Input
                placeholder="חיפוש לקוח..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div style={{ maxHeight: 380, overflowY: "auto" }}>
                {filteredClients.map(c => {
                  const sel = selected.has(c.phone);
                  return (
                    <label
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--s-3)",
                        padding: "var(--s-3) var(--s-2)",
                        cursor: "pointer",
                        background: sel ? "var(--blue-soft)" : "transparent",
                        borderRadius: "var(--r-2)",
                        marginBottom: 2,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggleSelect(c.phone)}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)" }}>{c.name || "ללא שם"}</p>
                        <p className="row-meta tabular" dir="ltr" style={{ marginTop: 2 }}>{c.phone}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <SectionHead eyebrow="Preview" title="תצוגה מקדימה" />
              <div style={{
                background: channel === "whatsapp" ? "#DCF8C6" : "var(--bg-tint)",
                border: "1px solid var(--rule)",
                borderRadius: 16,
                padding: "var(--s-4)",
                color: "var(--ink)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                minHeight: 120,
              }}>
                {body || (
                  <span style={{ color: "var(--ink-3)" }}>
                    התוכן יופיע כאן…
                  </span>
                )}
              </div>
              <div style={{ marginTop: "var(--s-3)" }}>
                <p className="t-meta">
                  הודעה נשלחת אל <strong>{audienceCount}</strong> נמענים בערוץ <strong>{channelLabel(channel)}</strong>
                  {scheduleAt && <> בתאריך <strong>{new Date(scheduleAt).toLocaleString("he-IL")}</strong></>}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── History ── */}
      <section className="section" style={{ marginTop: "var(--s-7)" }}>
        <SectionHead eyebrow="History" title="שליחות אחרונות" meta={`${history.length} פריטים`} />
        {history.length === 0 ? (
          <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)" }}>
            <p className="t-eyebrow" style={{ color: "var(--blue)" }}>סטטוס</p>
            <p className="t-body" style={{ marginTop: 6 }}>
              היסטוריה תופיע פה כשהשרת יחבר את ה-endpoints:
            </p>
            <ul style={{ marginTop: 8, paddingInlineStart: 20, fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.8 }}>
              <li><span className="mono">POST /cpanel/broadcast</span> — שליחה (SMS4Free + Green API)</li>
              <li><span className="mono">GET /cpanel/broadcast/templates</span> — תבניות מוכנות</li>
              <li><span className="mono">GET /cpanel/broadcast/history</span> — היסטוריית שליחות</li>
            </ul>
          </div>
        ) : (
          <div>
            {history.map(h => (
              <div key={h.jobId} className="row">
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "baseline" }}>
                    <span style={{ fontSize: "var(--t-md)", fontWeight: 700 }}>{channelLabel(h.channel)}</span>
                    <Badge variant={h.status === "done" ? "positive" : h.status === "canceled" ? "negative" : "warning"}>
                      {statusLabel(h.status)}
                    </Badge>
                  </div>
                  <p className="t-meta" style={{ marginTop: 4 }}>{h.bodyPreview}</p>
                </div>
                <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "center" }}>
                  <DeliveryStat label="נשלח"  value={h.delivered} color="var(--positive)" />
                  <DeliveryStat label="כשל"   value={h.failed}    color="var(--negative)" />
                  <DeliveryStat label="ממתין" value={h.pending}   color="var(--warning)" />
                  <span className="row-meta tabular">{new Date(h.createdAt).toLocaleString("he-IL")}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
}

function BroadcastKpi({ label, value, color }: { label: string; value: number; color: string; bg?: string }) {
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
        fontSize: "var(--t-2xl)", fontWeight: 800, color: "var(--ink)",
        marginTop: 6, lineHeight: 1, letterSpacing: "-0.02em",
      }}>{value}</p>
    </div>
  );
}

function DeliveryStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center", minWidth: 60 }}>
      <p className="figure-num tabular" style={{ fontSize: "var(--t-md)", fontWeight: 800, color }}>{value}</p>
      <p style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 500, marginTop: 2 }}>{label}</p>
    </div>
  );
}

function channelLabel(c: Channel): string {
  return c === "sms" ? "SMS" : c === "whatsapp" ? "WhatsApp" : "SMS + WhatsApp";
}
function statusLabel(s: string): string {
  return s === "scheduled" ? "מתוזמן" : s === "sending" ? "בשליחה" : s === "done" ? "הושלם" : "בוטל";
}
