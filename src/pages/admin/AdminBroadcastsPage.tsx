import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../context/ToastContext";
import {
  listAdminBroadcasts,
  sendAdminBroadcast,
  listAdminManagers,
  type AdminBroadcastRow,
  type BroadcastChannel,
  type BroadcastSegment,
  type ManagerListEntry,
} from "../../api/admin";

const SEGMENT_LABEL: Record<string, string> = {
  all:      "כל הלקוחות",
  manager:  "לקוחות של מנהל",
  package:  "לפי חבילה",
  tier:     "לפי רמה",
  phones:   "רשימה ידנית",
};

const TIER_OPTIONS = ["GOLD", "VIP", "PRO", "PLUS", "SILVER", "REGULAR"];
const PACKAGE_OPTIONS = ["platinum", "premium", "basic"];

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function describeSegment(seg: BroadcastSegment, managerName?: string): string {
  switch (seg.kind) {
    case "all":     return "כל הלקוחות במערכת";
    case "manager": return `לקוחות של ${managerName || seg.agentId}`;
    case "package": return `מחזיקי חבילת ${seg.packageId}`;
    case "tier":    return `רמה ${seg.tier}`;
    case "phones":  return `${seg.phones.length} מספרים ידניים`;
    default:        return JSON.stringify(seg);
  }
}

export function AdminBroadcastsPage() {
  const [history, setHistory] = useState<AdminBroadcastRow[]>([]);
  const [managers, setManagers] = useState<ManagerListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const toast = useToast();

  /* Composer state */
  const [message,      setMessage]      = useState("");
  const [channel,      setChannel]      = useState<BroadcastChannel>("sms");
  const [segmentKind,  setSegmentKind]  = useState<BroadcastSegment["kind"]>("all");
  const [agentId,      setAgentId]      = useState("");
  const [packageId,    setPackageId]    = useState("platinum");
  const [tier,         setTier]         = useState("VIP");
  const [phonesText,   setPhonesText]   = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy,         setBusy]         = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [b, m] = await Promise.all([
        listAdminBroadcasts(),
        listAdminManagers().catch(() => ({ managers: [], total: 0 })),
      ]);
      setHistory(b.broadcasts);
      setManagers(m.managers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const segment = useMemo<BroadcastSegment>(() => {
    switch (segmentKind) {
      case "manager": return { kind: "manager", agentId };
      case "package": return { kind: "package", packageId };
      case "tier":    return { kind: "tier",    tier };
      case "phones":  return { kind: "phones",  phones: phonesText.split(/[\s,;\n]+/).map(s => s.trim()).filter(Boolean) };
      default:        return { kind: "all" };
    }
  }, [segmentKind, agentId, packageId, tier, phonesText]);

  const segmentValid = useMemo(() => {
    if (segmentKind === "manager") return !!agentId;
    if (segmentKind === "phones")  return phonesText.trim().length > 0;
    return true;
  }, [segmentKind, agentId, phonesText]);

  async function preview() {
    if (!segmentValid) return;
    setBusy(true); setPreviewCount(null);
    try {
      const r = await sendAdminBroadcast({ message: message || "(תצוגה מקדימה)", channel, segment, dryRun: true });
      setPreviewCount(r.targetCount);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "כשלון בתצוגה מקדימה");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!message.trim() || !segmentValid) return;
    if (previewCount === null) {
      toast.error("הרץ קודם תצוגה מקדימה לראות לכמה אנשים תישלח ההודעה");
      return;
    }
    const ok = window.confirm(
      `לשלוח את ההודעה ל-${previewCount} מקבלים דרך ${channel === "whatsapp" ? "WhatsApp" : "SMS"}?\n\n` +
      `אי אפשר לבטל לאחר שליחה. כל שליחה נכתבת ל-audit log.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await sendAdminBroadcast({ message: message.trim(), channel, segment });
      toast.ok(`נשלח: ${r.sentCount}/${r.targetCount} (${r.failCount} כשלונות)`);
      setMessage("");
      setPreviewCount(null);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שליחה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  const managerNameById = useMemo(() => new Map(managers.map(m => [m.id, m.name])), [managers]);

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="הודעות רחבות"
          meta="שליחה לקבוצות לקוחות · WhatsApp / SMS · מתועד ב-audit"
        />
      }
    >
      {loading && <Spinner label="טוען" />}
      {error   && <EmptyState title="שגיאה" meta={error} />}

      {!loading && !error && (
        <>
          {/* Composer */}
          <section className="section" style={{ marginTop: 0 }}>
            <div className="card" style={{ padding: "var(--s-5)", borderTop: "3px solid #E53935" }}>
              <h3 className="t-section">הודעה חדשה</h3>

              <div style={{ marginTop: "var(--s-4)", display: "grid", gap: 12 }}>
                {/* Channel + Segment */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <Field label="ערוץ">
                    <select
                      value={channel}
                      onChange={e => setChannel(e.target.value as BroadcastChannel)}
                      style={inputStyle}
                    >
                      <option value="sms">📱 SMS</option>
                      <option value="whatsapp">💬 WhatsApp</option>
                    </select>
                  </Field>

                  <Field label="קהל יעד">
                    <select
                      value={segmentKind}
                      onChange={e => { setSegmentKind(e.target.value as BroadcastSegment["kind"]); setPreviewCount(null); }}
                      style={inputStyle}
                    >
                      {Object.entries(SEGMENT_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                {/* Segment-specific input */}
                {segmentKind === "manager" && (
                  <Field label="מנהל">
                    <select value={agentId} onChange={e => { setAgentId(e.target.value); setPreviewCount(null); }} style={inputStyle}>
                      <option value="">— בחר מנהל —</option>
                      {managers.map(m => <option key={m.id} value={m.id}>{m.name} ({m.clientCount} לקוחות)</option>)}
                    </select>
                  </Field>
                )}
                {segmentKind === "package" && (
                  <Field label="חבילה">
                    <select value={packageId} onChange={e => { setPackageId(e.target.value); setPreviewCount(null); }} style={inputStyle}>
                      {PACKAGE_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </Field>
                )}
                {segmentKind === "tier" && (
                  <Field label="רמה">
                    <select value={tier} onChange={e => { setTier(e.target.value); setPreviewCount(null); }} style={inputStyle}>
                      {TIER_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </Field>
                )}
                {segmentKind === "phones" && (
                  <Field label="מספרי טלפון" hint="מופרדים ברווח / פסיק / שורה חדשה">
                    <textarea
                      value={phonesText}
                      onChange={e => { setPhonesText(e.target.value); setPreviewCount(null); }}
                      rows={4}
                      placeholder="0501234567&#10;0509876543"
                      dir="ltr"
                      style={{ ...inputStyle, fontFamily: "ui-monospace, monospace", resize: "vertical" }}
                    />
                  </Field>
                )}

                {/* Message */}
                <Field label="טקסט ההודעה" hint={`${message.length} תווים`}>
                  <textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    rows={5}
                    placeholder="כתוב את ההודעה כאן…"
                    style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }}
                  />
                </Field>

                {/* Preview / Send */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
                  <div>
                    {previewCount !== null && (
                      <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                        🎯 ההודעה תישלח ל-<strong>{previewCount}</strong> מקבלים
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button onClick={preview} variant="ghost" disabled={busy || !segmentValid}>
                      תצוגה מקדימה
                    </Button>
                    <Button onClick={send} disabled={busy || !message.trim() || previewCount === null}>
                      {busy ? "שולח…" : "שלח עכשיו"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* History */}
          <section className="section" style={{ marginTop: "var(--s-5)" }}>
            <div className="card" style={{ padding: 0, borderTop: "3px solid #7C3AED", overflow: "auto" }}>
              <div style={{ padding: "var(--s-4) var(--s-5)", borderBottom: "1px solid var(--rule)" }}>
                <h3 className="t-section">היסטוריה</h3>
                <p className="t-meta">{history.length} הודעות אחרונות</p>
              </div>

              {history.length === 0
                ? <p className="t-meta" style={{ padding: "var(--s-5)" }}>אין הודעות שנשלחו</p>
                : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "var(--bg-tint)" }}>
                        <Th>תאריך</Th>
                        <Th>שולח</Th>
                        <Th>ערוץ</Th>
                        <Th>קהל</Th>
                        <Th>הודעה</Th>
                        <Th align="left">נשלחו</Th>
                        <Th align="left">כשלונות</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map(b => {
                        const managerName = b.segment.kind === "manager" ? managerNameById.get(b.segment.agentId) : undefined;
                        return (
                          <tr key={b.id} style={{ borderTop: "1px solid var(--rule)" }}>
                            <Td><span dir="ltr" className="num" style={{ fontSize: 11 }}>{formatDateTime(b.sentAt)}</span></Td>
                            <Td><span style={{ fontSize: 12 }}>{b.sentBy || "—"}</span></Td>
                            <Td><Badge>{b.channel === "whatsapp" ? "💬 WhatsApp" : "📱 SMS"}</Badge></Td>
                            <Td><span style={{ fontSize: 12 }}>{describeSegment(b.segment, managerName)}</span></Td>
                            <Td><span style={{ fontSize: 12, maxWidth: 320, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.message}</span></Td>
                            <Td align="left"><span className="num" dir="ltr" style={{ fontWeight: 700, color: "var(--positive)" }}>{b.sentCount}/{b.targetCount}</span></Td>
                            <Td align="left">
                              {b.failCount > 0
                                ? <span className="num" dir="ltr" style={{ fontWeight: 700, color: "var(--negative)" }}>{b.failCount}</span>
                                : <span className="t-meta">—</span>}
                            </Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              }
            </div>
          </section>
        </>
      )}
    </Layout>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div className="t-meta" style={{ fontSize: 10, marginTop: 3 }}>{hint}</div>}
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

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th style={{ padding: "10px 12px", textAlign: align ?? "right", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{children}</th>;
}
function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "10px 12px", textAlign: align ?? "right", verticalAlign: "middle" }}>{children}</td>;
}
