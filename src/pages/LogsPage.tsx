import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getLogs, type LogRecord } from "../api/client";
import { useApi } from "../hooks/useApi";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";

function isError(e: LogRecord) {
  return e.level === "error" || e.type === "error";
}
function isLogin(e: LogRecord) {
  return e.type === "login" || e.type === "app_open";
}

export function LogsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"all" | "errors" | "logins">("all");

  const fetcher = useCallback(() => getLogs({ limit: 200 }), []);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);

  const events = data?.data ?? [];

  const filtered = useMemo(() => {
    if (filter === "errors") return events.filter(isError);
    if (filter === "logins") return events.filter(isLogin);
    return events;
  }, [events, filter]);

  return (
    <Layout
      header={
        <Header
          eyebrow="לוגים"
          title="לוגים של הלקוחות שלי"
          meta={data ? `${events.length} אירועים` : "טוען…"}
          trailing={<Button variant="ghost" size="sm" onClick={reload}>רענן</Button>}
        />
      }
    >
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)", marginBottom: "var(--s-5)" }}>
          <LogKpi label="סה״כ אירועים" value={events.length}                         color="var(--blue)"     />
          <LogKpi label="שגיאות"        value={events.filter(isError).length}         color="var(--negative)" />
          <LogKpi label="כניסות"        value={events.filter(isLogin).length}         color="var(--positive)" />
          <LogKpi label="בסיס נתונים"   value={data?.total ?? 0}                      color="var(--warning)"  />
        </div>
      </section>

      <section className="section" style={{ marginTop: 0 }}>
        <div className="tabs" style={{ marginBottom: "var(--s-5)", maxWidth: 420 }}>
          <button className={"tab " + (filter === "all"    ? "active" : "")} onClick={() => setFilter("all")}>הכל</button>
          <button className={"tab " + (filter === "logins" ? "active" : "")} onClick={() => setFilter("logins")}>כניסות</button>
          <button className={"tab " + (filter === "errors" ? "active" : "")} onClick={() => setFilter("errors")}>שגיאות</button>
        </div>

        {loading ? (
          <Spinner label="טוען לוגים" />
        ) : error ? (
          <EmptyState title="שגיאה" meta={error} action={<Button onClick={reload}>נסה שוב</Button>} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="אין אירועים"
            meta={filter === "all" ? "לא נמצאו לוגים." : "אין אירועים בקטגוריה זו."}
          />
        ) : (
          <div className="card" style={{ padding: "var(--s-5)" }}>
            <ul className="timeline" style={{ listStyle: "none", padding: 0, margin: 0, paddingInlineStart: 28 }}>
              {filtered.map((ev, i) => {
                const err = isError(ev);
                const login = isLogin(ev);
                const sev = err ? "negative" : login ? "positive" : "";
                const evType = ev.level ?? ev.type ?? "info";
                const evName = ev.message ?? ev.msg ?? ev.name ?? evType;
                const ts = ev.createdAt ?? ev.timestamp ?? "";
                return (
                  <li key={ev._id || i} className={`timeline-item ${sev}`}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--s-3)", alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>{evName}</span>
                          <Badge variant={err ? "negative" : login ? "positive" : "clay"}>
                            {evTypeLabel(evType)}
                          </Badge>
                        </div>
                        {ev.phone && (
                          <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)", marginTop: 4 }}>
                            {ev.clientName && (
                              <button
                                onClick={() => navigate(`/clients/${encodeURIComponent(ev.phone!)}`)}
                                style={{ background: "transparent", border: 0, padding: 0, color: "var(--blue)", cursor: "pointer", fontWeight: 700, borderBottom: "1px solid var(--blue-line)" }}
                              >
                                {ev.clientName}
                              </button>
                            )}
                            <span dir="ltr" className="num" style={{ marginInlineStart: ev.clientName ? 8 : 0, color: "var(--ink-3)" }}>{ev.phone}</span>
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600, whiteSpace: "nowrap", textAlign: "left" }} dir="ltr" className="num">
                        {ts ? `${formatTime(ts)} · ${formatDate(ts)}` : "—"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </Layout>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}
function evTypeLabel(type: string): string {
  if (type === "screen_view")                       return "מסך";
  if (type === "app_open")                          return "פתיחה";
  if (type === "button_click" || type === "press")  return "לחיצה";
  if (type === "error")                             return "שגיאה";
  if (type === "login")                             return "התחברות";
  if (type === "info")                              return "מידע";
  if (type === "warn" || type === "warning")        return "אזהרה";
  return type;
}

function LogKpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card" style={{ padding: "var(--s-4)", borderTop: `3px solid ${color}`, cursor: "default" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ background: color }} />
        <p style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{label}</p>
      </div>
      <p style={{ fontSize: "var(--t-2xl)", fontWeight: 800, color: "var(--ink)", marginTop: 6, lineHeight: 1, letterSpacing: "-0.02em" }}>{value}</p>
    </div>
  );
}
