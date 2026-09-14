import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  getStats, getClients, getDashboardSummary, getAgentWallet, aiDailyDigest,
  listProductReviews,
  type Client, type DashboardSummary, type AgentWallet, type AiDigestItem,
  type ReviewListItem,
} from "../api/client";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Skeleton, SkeletonKpiTile, SkeletonStack } from "../components/ui/Skeleton";
import { DonutChart } from "../components/charts/DonutChart";
import { LineChart } from "../components/charts/LineChart";
import { FunnelChart } from "../components/charts/FunnelChart";
import { Sparkline } from "../components/charts/Sparkline";
import {
  IcoUsers, IcoChat, IcoTarget, IcoCoin,
  IcoTrendUp, IcoCard, IcoActivity,
  IcoBroadcast, IcoTasks, IcoCalendar, IcoBarChart,
} from "../components/icons/Icons";

/* ── Local task type (matches TasksPage storage) ───────────────────── */
interface LocalTask {
  id: string;
  title: string;
  description: string;
  dueAt: string;
  done: boolean;
  clientPhone?: string;
  createdAt: string;
}
function loadTasks(): LocalTask[] {
  try {
    const raw = localStorage.getItem("cpanel_tasks_local");
    return raw ? (JSON.parse(raw) as LocalTask[]) : [];
  } catch { return []; }
}

/* ── Alert types ───────────────────────────────────────────────────── */
interface SystemAlert {
  id: string;
  level: "error" | "warn" | "info";
  title: string;
  body: string;
  href?: string;
}

export function DashboardPage() {
  const { agent } = useAuth();
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  const fetcher = useCallback(async () => {
    const [stats, clients] = await Promise.all([getStats(), getClients()]);
    const summary  = await getDashboardSummary(7).catch(() => null);
    const wallet   = await getAgentWallet().catch(() => null);
    const digest   = await aiDailyDigest().catch(() => null);
    const reviews  = await listProductReviews({ limit: 8 }).catch(() => ({ reviews: [], total: 0 }));
    return { stats, clients, summary, wallet, digest, reviews };
  }, []);

  const { data, loading, reload } = useApi(fetcher, [fetcher]);

  const today = new Date().toLocaleDateString("he-IL", {
    weekday: "long", day: "numeric", month: "long",
  });

  const hourGreeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "בוקר טוב";
    if (h < 17) return "צהריים טובים";
    if (h < 21) return "ערב טוב";
    return "לילה טוב";
  })();

  const clients: Client[]              = data?.clients ?? [];
  const summary: DashboardSummary | null = data?.summary ?? null;
  const wallet: AgentWallet | null     = data?.wallet ?? null;
  const digest: AiDigestItem[]         = data?.digest?.items ?? [];
  const recentReviews: ReviewListItem[] = data?.reviews?.reviews ?? [];

  const totalClients  = data?.stats?.totalClients ?? clients.length;
  const unread        = data?.stats?.unreadMessages ?? 0;
  const withCard      = useMemo(() => clients.filter(c => c.hasPaymentToken).length, [clients]);

  const recentlyActive = useMemo(() => {
    const cut = Date.now() - 1000 * 60 * 60 * 24 * 7;
    return clients.filter(c => c.lastActive && new Date(c.lastActive).getTime() > cut).length;
  }, [clients]);

  /* ── Tasks (local) ─────────────────────────────────────────────── */
  const tasks = useMemo(() => loadTasks(), []);
  const openTasks  = useMemo(() => tasks.filter(t => !t.done), [tasks]);
  const overdueTasks = useMemo(() => openTasks.filter(t => new Date(t.dueAt).getTime() < Date.now()), [openTasks]);
  const todayTasks   = useMemo(() => {
    const now = new Date(); const d = now.toDateString();
    return openTasks.filter(t => new Date(t.dueAt).toDateString() === d);
  }, [openTasks]);

  /* ── Missed chats ──────────────────────────────────────────────── */
  const missedChats = useMemo(() =>
    clients.filter(c => c.unread).slice(0, 8),
  [clients]);

  /* ── System alerts ─────────────────────────────────────────────── */
  const alerts = useMemo((): SystemAlert[] => {
    const list: SystemAlert[] = [];

    /* Commission balance — informational only.
       The wallet stores commissions earned but not yet paid out. A low
       value here is normal for new managers and after a fresh payout
       cycle, NOT an error condition (sending isn't blocked by it). */
    if (wallet) {
      if (wallet.balance === 0) {
        list.push({
          id: "wallet-info",
          level: "info",
          title: "לא נצברו עמלות עדיין",
          body: "ככל שתסגור עסקאות, העמלות שלך יופיעו כאן.",
          href: "/wallet",
        });
      } else if (wallet.balance < 200) {
        list.push({
          id: "wallet-info",
          level: "info",
          title: `עמלות שטרם שולמו: ₪${wallet.balance.toLocaleString("he-IL")}`,
          body: "הסכום ישולם במחזור התשלומים הבא של המנהל.",
          href: "/wallet",
        });
      }
    }

    // Clients without payment token
    const noCard = totalClients - withCard;
    if (noCard > 0) {
      list.push({
        id: "no-card",
        level: "info",
        title: `${noCard} לקוחות ללא כרטיס אשראי`,
        body: "לקוחות אלה לא יוכלו לשלם עבור שירותים.",
        href: "/clients",
      });
    }

    // Overdue tasks
    if (overdueTasks.length > 0) {
      list.push({
        id: "overdue-tasks",
        level: "warn",
        title: `${overdueTasks.length} משימות באיחור`,
        body: overdueTasks.slice(0, 2).map(t => t.title).join(" · "),
        href: "/tasks",
      });
    }

    // AI insights with high severity
    const highAlerts = digest.filter(d => d.severity === "high");
    for (const d of highAlerts.slice(0, 2)) {
      list.push({
        id: `digest-${d.clientPhone}`,
        level: "error",
        title: kindTitle(d.kind),
        body: `${d.clientName} · ${d.reason}`,
        href: `/clients/${encodeURIComponent(d.clientPhone)}`,
      });
    }

    return list.slice(0, 6);
  }, [wallet, totalClients, withCard, overdueTasks, digest]);

  /* ── Chart data ────────────────────────────────────────────────── */
  const sparkLeads   = summary?.trends?.leads?.map(t => t.value)   ?? syntheticSpark(7, 8, 24);
  const sparkSpend   = summary?.trends?.spend?.map(t => t.value)   ?? syntheticSpark(7, 200, 1200);
  const sparkRevenue = summary?.trends?.revenue?.map(t => t.value) ?? syntheticSpark(7, 400, 2800);

  const statusDonut = useMemo(() => [
    { label: "פעילים השבוע", value: recentlyActive,           color: "#0073EA" },
    { label: "עם כרטיס",    value: withCard,                   color: "#00C875" },
    { label: "ללא כרטיס",  value: Math.max(0, totalClients - withCard), color: "#C3C6D4" },
  ], [recentlyActive, withCard, totalClients]);

  const pipeline = summary?.pipeline ?? { leads: 0, qualified: 0, proposals: 0, won: 0 };

  const recentClients = useMemo(() =>
    clients
      .filter(c => c.lastActive)
      .sort((a, b) => new Date(b.lastActive!).getTime() - new Date(a.lastActive!).getTime())
      .slice(0, 8),
  [clients]);

  /* ── KPI strip ─────────────────────────────────────────────────── */
  const kpis = [
    { label: "סך לקוחות",    value: totalClients.toLocaleString("he-IL"), spark: sparkLeads,   color: "#0073EA", icon: <IcoUsers size={16} /> },
    { label: "הודעות חדשות",  value: unread.toLocaleString("he-IL"),       spark: sparkLeads,   color: "#00C875", icon: <IcoChat size={16} /> },
    { label: "הוצאה בשבוע",  value: `₪${(summary?.spend7d ?? 0).toLocaleString("he-IL")}`, spark: sparkSpend, color: "#784BD1", icon: <IcoCoin size={16} /> },
    { label: "הכנסות בשבוע", value: `₪${(summary?.revenue7d ?? 0).toLocaleString("he-IL")}`, spark: sparkRevenue, color: "#00C5A5", icon: <IcoTrendUp size={16} /> },
  ];

  return (
    <Layout
      header={
        <Header
          title={agent ? `${hourGreeting}, ${agent.nickname || agent.name}` : hourGreeting}
          meta={today}
          trailing={
            wallet ? (
              <button
                onClick={() => navigate("/wallet")}
                title="עמלות שלא שולמו"
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "5px 12px",
                  background: "var(--blue-soft)",
                  border: "1px solid rgba(0,115,234,0.20)",
                  borderRadius: "var(--r-pill)",
                  cursor: "pointer",
                  fontSize: "var(--t-xs)", fontWeight: 700,
                  color: "var(--blue)",
                }}
              >
                <IcoCoin size={13} />
                ₪{wallet.balance.toLocaleString("he-IL")}
              </button>
            ) : undefined
          }
        />
      }
    >
      {loading ? (
        /* Reserve the page shape with skeletons so content doesn't jump
           when data arrives (per skill rule: "content-jumping"). 4 KPI
           tiles + 3 panel cards mirror the real layout one-to-one. */
        <>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "var(--s-3)",
            marginBottom: "var(--s-5)",
          }}>
            {[0, 1, 2, 3].map(i => <SkeletonKpiTile key={i} />)}
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "var(--s-4)",
          }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="card card-static" style={{ padding: "var(--s-4)", minHeight: 280 }}>
                <Skeleton variant="title" width={140} style={{ marginBottom: 12 }} />
                <SkeletonStack rows={5} gap={10} />
              </div>
            ))}
          </div>
          {/* Subtle "still loading" cue — accessible to screen readers via Spinner aria-label */}
          <div style={{ position: "absolute", insetInlineEnd: 16, bottom: 16, opacity: 0.6 }}>
            <Spinner size="sm" inline label="טוען דשבורד" />
          </div>
        </>
      ) : (
        <>
          {/* ── System Alerts banner ─────────────────────────────── */}
          {alerts.filter(a => a.level === "error").length > 0 && (
            <div style={{ marginBottom: "var(--s-4)", display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              {alerts.filter(a => a.level === "error").map(a => (
                <AlertBanner key={a.id} alert={a} onNavigate={navigate} />
              ))}
            </div>
          )}

          {/* ── KPI Strip — motion stagger on mount ─────────────────── */}
          <motion.div
            initial={reduce ? false : "hidden"}
            animate="show"
            variants={reduce ? undefined : {
              hidden: { opacity: 0 },
              show:   { opacity: 1, transition: { staggerChildren: 0.06 } },
            }}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "var(--s-3)",
              marginBottom: "var(--s-5)",
            }}
          >
            {kpis.map((k, i) => (
              <motion.div
                key={i}
                variants={reduce ? undefined : {
                  hidden: { opacity: 0, y: 12 },
                  show:   { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
                }}
              >
                <KpiTile {...k} />
              </motion.div>
            ))}
          </motion.div>

          {/* ── Row 1: Tasks · Missed Chats · Alerts ─────────────── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "var(--s-4)",
            marginBottom: "var(--s-5)",
          }}>
            {/* My Tasks */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <PanelHead
                title="המשימות שלי"
                count={openTasks.length}
                countColor={overdueTasks.length > 0 ? "var(--negative)" : "var(--blue)"}
                action={<button className="btn btn-sm" style={{ boxShadow: "none" }} onClick={() => navigate("/tasks")}>הכל</button>}
              />
              {openTasks.length === 0 ? (
                <div style={{ padding: "var(--s-5)", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
                  אין משימות פתוחות
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {openTasks.slice(0, 6).map(t => {
                    const due = new Date(t.dueAt);
                    const isOver = due.getTime() < Date.now();
                    const isToday = due.toDateString() === new Date().toDateString();
                    return (
                      <li key={t.id} onClick={() => navigate("/tasks")} style={{
                        display: "flex", alignItems: "flex-start", gap: 10,
                        padding: "9px var(--s-4)",
                        borderBottom: "1px solid var(--rule)",
                        cursor: "pointer",
                        transition: "background 120ms",
                      }}
                        onMouseEnter={e => e.currentTarget.style.background = "var(--bg-tint)"}
                        onMouseLeave={e => e.currentTarget.style.background = ""}
                      >
                        <div style={{
                          width: 16, height: 16, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                          border: `2px solid ${isOver ? "var(--negative)" : isToday ? "var(--warning)" : "var(--rule-strong)"}`,
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</p>
                          <p style={{ fontSize: 11, color: isOver ? "var(--negative)" : "var(--ink-3)", marginTop: 2, fontWeight: isOver ? 700 : 400 }}>
                            {isOver ? "באיחור · " : isToday ? "היום · " : ""}{due.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" })}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div style={{ padding: "var(--s-3) var(--s-4)", borderTop: "1px solid var(--rule)", display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {todayTasks.length} היום · {overdueTasks.length} באיחור
                </span>
                <button onClick={() => navigate("/tasks")} style={{
                  background: "none", border: "none", color: "var(--blue)",
                  fontSize: 12, fontWeight: 700, cursor: "pointer",
                }}>+ משימה חדשה</button>
              </div>
            </div>

            {/* Missed Chats */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <PanelHead
                title="שיחות שלא נענו"
                count={missedChats.length}
                countColor={missedChats.length > 0 ? "var(--warning)" : "var(--positive)"}
                action={<button className="btn btn-sm" style={{ boxShadow: "none" }} onClick={() => navigate("/chat")}>פתח צ'אט</button>}
              />
              {missedChats.length === 0 ? (
                <div style={{ padding: "var(--s-5)", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
                  אין שיחות ממתינות
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {missedChats.slice(0, 6).map(c => (
                    <li key={c.id} onClick={() => navigate(`/chat?phone=${encodeURIComponent(c.phone)}`)} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "9px var(--s-4)",
                      borderBottom: "1px solid var(--rule)",
                      cursor: "pointer", transition: "background 120ms",
                    }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--bg-tint)"}
                      onMouseLeave={e => e.currentTarget.style.background = ""}
                    >
                      <div style={{
                        width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                        background: "var(--warning-bg)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 700, color: "#9C6000",
                      }}>
                        {(c.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name || "ללא שם"}
                        </p>
                        <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }} dir="ltr">{c.phone}</p>
                      </div>
                      <div style={{
                        background: "var(--warning)", color: "#fff",
                        borderRadius: "var(--r-pill)", fontSize: 10, fontWeight: 800,
                        padding: "2px 7px", flexShrink: 0,
                      }}>!{c.unread}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ padding: "var(--s-3) var(--s-4)", borderTop: "1px solid var(--rule)" }}>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {unread} הודעות לא נקראו בסך הכל
                </span>
              </div>
            </div>

            {/* System Alerts */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <PanelHead
                title="התראות מערכת"
                count={alerts.length}
                countColor={alerts.some(a => a.level === "error") ? "var(--negative)" : alerts.some(a => a.level === "warn") ? "var(--warning)" : "var(--positive)"}
                action={<button className="btn btn-sm btn-ghost" onClick={reload}>רענן</button>}
              />
              {alerts.length === 0 ? (
                <div style={{ padding: "var(--s-5)", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
                  הכל תקין
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {alerts.map(a => (
                    <li
                      key={a.id}
                      onClick={() => a.href && navigate(a.href)}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 10,
                        padding: "9px var(--s-4)",
                        borderBottom: "1px solid var(--rule)",
                        cursor: a.href ? "pointer" : "default",
                        transition: "background 120ms",
                        borderInlineStart: `3px solid ${a.level === "error" ? "var(--negative)" : a.level === "warn" ? "var(--warning)" : "var(--blue)"}`,
                      }}
                      onMouseEnter={e => { if (a.href) e.currentTarget.style.background = "var(--bg-tint)"; }}
                      onMouseLeave={e => e.currentTarget.style.background = ""}
                    >
                      <span style={{
                        flexShrink: 0,
                        marginTop: 6,
                        width: 8, height: 8,
                        borderRadius: 99,
                        background: a.level === "error" ? "var(--negative)" : a.level === "warn" ? "var(--warning)" : "var(--blue)",
                        boxShadow: `0 0 0 3px ${a.level === "error" ? "var(--negative-bg)" : a.level === "warn" ? "var(--warning-bg)" : "var(--blue-soft)"}`,
                      }} aria-hidden="true" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>{a.title}</p>
                        <p style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ padding: "var(--s-3) var(--s-4)", borderTop: "1px solid var(--rule)" }}>
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {alerts.filter(a => a.level === "error").length} קריטי · {alerts.filter(a => a.level === "warn").length} אזהרה
                </span>
              </div>
            </div>
          </div>

          {/* ── Row 2: Charts ─────────────────────────────────────── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr)",
            gap: "var(--s-4)",
            marginBottom: "var(--s-5)",
          }}>
            <div className="card">
              <SectionH eyebrow="Trend" title="לידים והוצאה — 7 ימים" />
              <LineChart
                height={220}
                series={[
                  {
                    name: "לידים",
                    color: "#0073EA",
                    fill: "rgba(0,115,234,0.08)",
                    points: summary?.trends.leads ?? syntheticTrend(7, 4, 22),
                  },
                  {
                    name: "הוצאה (₪)",
                    color: "#784BD1",
                    points: summary?.trends.spend ?? syntheticTrend(7, 200, 1400),
                  },
                ]}
                formatValue={(n) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))}
              />
            </div>
            <div className="card">
              <SectionH eyebrow="Mix" title="חלוקת לקוחות" />
              <DonutChart
                data={statusDonut}
                centerValue={totalClients}
                centerLabel="סה״כ"
              />
            </div>
          </div>

          {/* ── Row 3: Pipeline + Recent Clients ─────────────────── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)",
            gap: "var(--s-4)",
            marginBottom: "var(--s-5)",
          }}>
            <div className="card">
              <SectionH eyebrow="Pipeline" title="משפך מכירות" />
              <FunnelChart
                stages={[
                  { label: "לידים",  value: pipeline.leads     || 120 },
                  { label: "ממוין",  value: pipeline.qualified || 74 },
                  { label: "הצעה",   value: pipeline.proposals || 28 },
                  { label: "נסגר",   value: pipeline.won       || 11 },
                ]}
                height={180}
              />
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "var(--s-4) var(--s-5)", borderBottom: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase", margin: 0 }}>פעיל לאחרונה</p>
                  <h3 style={{ fontSize: "var(--t-md)", fontWeight: 700, color: "var(--ink)", margin: "2px 0 0" }}>לקוחות פעילים</h3>
                </div>
                <button onClick={() => navigate("/clients")} className="btn btn-sm btn-ghost" style={{ boxShadow: "none" }}>כל הלקוחות</button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--t-sm)" }}>
                  <thead>
                    <tr style={{ background: "var(--bg-tint)", borderBottom: "1px solid var(--rule)" }}>
                      <th style={TH}>לקוח</th>
                      <th style={TH}>טלפון</th>
                      <th style={TH}>פעיל</th>
                      <th style={{ ...TH, width: 80 }}>סטטוס</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentClients.map(c => (
                      <tr
                        key={c.id}
                        onClick={() => navigate(`/clients/${encodeURIComponent(c.phone)}`)}
                        style={{ borderBottom: "1px solid var(--rule)", cursor: "pointer", transition: "background 100ms" }}
                        onMouseEnter={e => e.currentTarget.style.background = "var(--bg-tint)"}
                        onMouseLeave={e => e.currentTarget.style.background = ""}
                      >
                        <td style={{ padding: "8px var(--s-4)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{
                              width: 26, height: 26, borderRadius: "50%",
                              background: "var(--blue-soft)", color: "var(--blue)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 11, fontWeight: 700, flexShrink: 0,
                            }}>
                              {(c.name || "?").charAt(0).toUpperCase()}
                            </div>
                            <span style={{ fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
                              {c.name || "ללא שם"}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px var(--s-4)", direction: "ltr", textAlign: "right" }}>
                          <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>{c.phone}</span>
                        </td>
                        <td style={{ padding: "8px var(--s-4)", color: "var(--ink-3)", fontSize: 12 }}>
                          {c.lastActive ? relativeTime(c.lastActive) : "—"}
                        </td>
                        <td style={{ padding: "8px var(--s-4)" }}>
                          {c.unread ? (
                            <span style={{ background: "var(--warning)", color: "#fff", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>ממתין</span>
                          ) : (
                            <span style={{ background: "var(--positive-bg)", color: "#007A46", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>פעיל</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Row 4: AI Digest + Recent Client Responses + Quick Actions ── */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.9fr)",
            gap: "var(--s-4)",
          }}>
            {/* Recent client responses — pulls from /cpanel/reviews */}
            <div className="card">
              <SectionH
                eyebrow="Reviews"
                title="תגובות אחרונות מלקוחות"
                action={
                  <button
                    onClick={() => navigate("/reviews")}
                    style={{ background: "transparent", border: 0, color: "var(--blue)", fontSize: 12, cursor: "pointer", fontWeight: 700 }}
                  >
                    הצג הכל ›
                  </button>
                }
              />
              {recentReviews.length === 0 ? (
                <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", margin: 0 }}>
                  עדיין לא נשלחו אישורי לקוח. שלח חבילה לאישור מטאב 'מוצרים'.
                </p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
                  {recentReviews.slice(0, 5).map(r => {
                    const cfg =
                      r.status === "approved"
                        ? { dot: "var(--positive)", bg: "var(--positive-bg)", color: "var(--positive)", label: "אושר" }
                        : r.status === "rejected"
                          ? { dot: "var(--negative)", bg: "var(--negative-bg)", color: "var(--negative)", label: "נדחה" }
                          : { dot: "var(--warning)", bg: "var(--warning-bg)", color: "var(--warning)", label: "ממתין" };
                    const summary = [
                      r.summary.ads > 0     ? `${r.summary.ads} מודעות`     : null,
                      r.summary.organic > 0 ? `${r.summary.organic} פוסטים` : null,
                      r.summary.lp          ? "LP"                          : null,
                    ].filter(Boolean).join(" + ");
                    return (
                      <li key={r.token}>
                        <button
                          onClick={() => navigate(`/clients/${encodeURIComponent(r.phone)}?tab=products`)}
                          style={{
                            display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
                            background: "transparent", border: 0, padding: "8px 0",
                            borderBottom: "1px solid var(--rule)", cursor: "pointer", textAlign: "right",
                          }}
                        >
                          <span style={{
                            width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 5,
                            background: cfg.dot,
                          }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>{r.clientName}</p>
                            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {summary} · {timeAgo(r.respondedAt || r.sentAt)}
                            </p>
                          </div>
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: "2px 8px",
                            borderRadius: "var(--r-pill)",
                            background: cfg.bg, color: cfg.color, flexShrink: 0,
                          }}>
                            {cfg.label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>


            {/* AI Insights */}
            <div className="card">
              <SectionH
                eyebrow="AI Insights"
                title="תקציר חכם"
                action={<span style={{ fontSize: 12, color: "var(--ink-3)" }}>{digest.length} פריטים</span>}
              />
              {digest.length === 0 ? (
                <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", margin: 0 }}>
                  אין תובנות AI כרגע. ה-AI ירוץ אוטומטית פעם ביום וייצר תובנות לפי פעילות הלקוחות.
                </p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
                  {digest.map((item, i) => (
                    <li key={i}>
                      <button
                        onClick={() => navigate(`/clients/${encodeURIComponent(item.clientPhone)}`)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
                          background: "transparent", border: 0, padding: "8px 0",
                          borderBottom: "1px solid var(--rule)", cursor: "pointer", textAlign: "right",
                        }}
                      >
                        <span style={{
                          width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginTop: 5,
                          background: item.severity === "high" ? "var(--negative)" : item.severity === "med" ? "var(--warning)" : "var(--positive)",
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>{item.clientName}</p>
                          <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{item.reason}</p>
                        </div>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: "2px 8px",
                          borderRadius: "var(--r-pill)",
                          background: item.severity === "high" ? "var(--negative-bg)" : item.severity === "med" ? "var(--warning-bg)" : "var(--positive-bg)",
                          color: item.severity === "high" ? "var(--negative)" : item.severity === "med" ? "#9C6000" : "#007A46",
                          flexShrink: 0,
                        }}>
                          {kindTitle(item.kind)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Quick Actions */}
            <div className="card">
              <SectionH eyebrow="פעולות" title="פעולות מהירות" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" }}>
                {[
                  { icon: <IcoBroadcast size={18} />, label: "שליחה רחבה", color: "#0073EA", href: "/broadcast" },
                  { icon: <IcoTasks size={18} />,     label: "משימה חדשה",  color: "#784BD1", href: "/tasks" },
                  { icon: <IcoCalendar size={18} />,  label: "פגישה חדשה",  color: "#00C875", href: "/appointments" },
                  { icon: <IcoTarget size={18} />,    label: "לידים",        color: "#FDAB3D", href: "/leads" },
                  { icon: <IcoUsers size={18} />,     label: "לקוחות",       color: "#00C2FF", href: "/clients" },
                  { icon: <IcoBarChart size={18} />,  label: "קמפיינים",     color: "#E2445C", href: "/campaigns" },
                  { icon: <IcoActivity size={18} />,  label: "לוגים",        color: "#676879", href: "/logs" },
                  { icon: <IcoCard size={18} />,      label: "ארנק",         color: "#00C5A5", href: "/wallet" },
                ].map((a, i) => (
                  <button
                    key={i}
                    onClick={() => navigate(a.href)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px var(--s-3)",
                      background: "var(--bg-tint)", border: "1px solid var(--rule)",
                      borderRadius: "var(--r-2)", cursor: "pointer",
                      transition: "all 150ms",
                      textAlign: "right",
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.background = "var(--blue-soft)";
                      e.currentTarget.style.borderColor = "rgba(0,115,234,0.25)";
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = "var(--bg-tint)";
                      e.currentTarget.style.borderColor = "var(--rule)";
                    }}
                  >
                    <div style={{ color: a.color, flexShrink: 0 }}>{a.icon}</div>
                    <span style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)" }}>{a.label}</span>
                  </button>
                ))}
              </div>

              {/* Warn alerts (non-critical) */}
              {alerts.filter(a => a.level === "warn").length > 0 && (
                <div style={{ marginTop: "var(--s-4)", borderTop: "1px solid var(--rule)", paddingTop: "var(--s-3)" }}>
                  {alerts.filter(a => a.level === "warn").map(a => (
                    <div key={a.id} onClick={() => a.href && navigate(a.href)} style={{
                      display: "flex", gap: 8, alignItems: "flex-start",
                      padding: "6px 0", cursor: a.href ? "pointer" : "default",
                      fontSize: "var(--t-xs)", color: "var(--ink-3)",
                    }}>
                      <span style={{
                        flexShrink: 0, marginTop: 5,
                        width: 7, height: 7, borderRadius: 99,
                        background: "var(--warning)",
                        boxShadow: "0 0 0 3px var(--warning-bg)",
                      }} aria-hidden="true" />
                      <span><strong style={{ color: "var(--ink)" }}>{a.title}</strong> — {a.body}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

const TH: React.CSSProperties = {
  padding: "9px var(--s-4)",
  textAlign: "right",
  fontSize: 10,
  fontWeight: 700,
  color: "var(--ink-3)",
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

function AlertBanner({ alert, onNavigate }: { alert: SystemAlert; onNavigate: (href: string) => void }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: -8 }}
      animate={reduce ? undefined : { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
      onClick={() => alert.href && onNavigate(alert.href)}
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px var(--s-5)",
        background: "var(--negative-bg)",
        border: "1px solid rgba(226,68,92,0.30)",
        borderRadius: "var(--r-2)",
        cursor: alert.href ? "pointer" : "default",
      }}
    >
      <span style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        width: 28, height: 28, borderRadius: 99,
        background: "var(--negative)", color: "#fff",
      }} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ fontSize: "var(--t-sm)", color: "var(--negative)" }}>{alert.title}</strong>
        <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", marginInlineStart: 8 }}>{alert.body}</span>
      </div>
      {alert.href && <span style={{ flexShrink: 0, fontSize: 12, color: "var(--negative)", fontWeight: 700 }}>לפתיחה ›</span>}
    </motion.div>
  );
}

function KpiTile({
  label, value, spark, color, icon,
}: {
  label: string;
  value: string;
  spark?: number[];
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: "var(--s-4)", position: "relative", overflow: "hidden" }}>
      {spark && spark.length > 1 && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, opacity: 0.10, pointerEvents: "none" }}>
          <Sparkline values={spark} width={240} height={40} color={color} showFill />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.09em", textTransform: "uppercase" }}>{label}</span>
        <div style={{ color, opacity: 0.8 }}>{icon}</div>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.02em", fontFeatureSettings: '"tnum" 1', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ height: 3, background: color, borderRadius: 3, marginTop: 12, opacity: 0.7 }} />
    </div>
  );
}

function PanelHead({
  title, count, countColor, action,
}: {
  title: string;
  count: number;
  countColor?: string;
  action?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "var(--s-3) var(--s-4)",
      borderBottom: "1px solid var(--rule)",
      background: "var(--bg-tint)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>{title}</span>
        <span style={{
          background: countColor ?? "var(--blue)",
          color: "#fff", borderRadius: "var(--r-pill)",
          padding: "1px 7px", fontSize: 11, fontWeight: 800,
        }}>{count}</span>
      </div>
      {action}
    </div>
  );
}

function SectionH({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: "var(--s-4)", paddingBottom: "var(--s-3)", borderBottom: "1px solid var(--rule)" }}>
      <div>
        {eyebrow && <p style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.12em", textTransform: "uppercase", margin: "0 0 3px" }}>{eyebrow}</p>}
        <h3 style={{ fontSize: "var(--t-md)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>{title}</h3>
      </div>
      {action}
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function kindTitle(k: AiDigestItem["kind"]): string {
  return k === "stale_chat"        ? "שיחה רדומה"     :
         k === "low_credit"        ? "מעט קרדיט"      :
         k === "missed_appointment"? "פגישה שפוספסה"  :
         k === "high_intent"       ? "כוונה גבוהה"    :
         k === "churn_risk"        ? "סיכון לעזיבה"   : k;
}

function timeAgo(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)    return "עכשיו";
  if (m < 60)   return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `לפני ${h} שעות`;
  const days = Math.floor(h / 24);
  if (days < 7) return `לפני ${days} ימים`;
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function syntheticSpark(n: number, lo: number, hi: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.round(lo + (hi - lo) * (0.4 + 0.6 * Math.sin(i * 0.7)))
  );
}
function syntheticTrend(n: number, lo: number, hi: number): { label: string; value: number }[] {
  const days = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];
  return Array.from({ length: n }, (_, i) => ({
    label: days[i % 7],
    value: Math.round(lo + (hi - lo) * (0.4 + 0.6 * Math.sin(i * 0.7 + 1))),
  }));
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
