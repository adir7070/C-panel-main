import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IcoBell, IcoCheck, IcoTarget, IcoChat, IcoCalendar, IcoCoin, IcoAlert } from "../icons/Icons";

type NotifType = "lead" | "message" | "appointment" | "payment" | "alert";

interface Notif {
  id: string;
  type: NotifType;
  title: string;
  body: string;
  ts: string;
  unread: boolean;
  href: string;        // navigation target on click
}

const ICONS: Record<NotifType, React.ReactNode> = {
  lead:        <IcoTarget size={15} />,
  message:     <IcoChat size={15} />,
  appointment: <IcoCalendar size={15} />,
  payment:     <IcoCoin size={15} />,
  alert:       <IcoAlert size={15} />,
};

const TINTS: Record<NotifType, { bg: string; color: string }> = {
  lead:        { bg: "rgba(30,58,138,0.10)",  color: "#1E3A8A" },
  message:     { bg: "rgba(6,182,212,0.12)",  color: "#0891B2" },
  appointment: { bg: "rgba(124,58,237,0.10)", color: "#7C3AED" },
  payment:     { bg: "rgba(16,185,129,0.12)", color: "#10B981" },
  alert:       { bg: "rgba(239,68,68,0.10)",  color: "#EF4444" },
};


/* DEMO data — until GET /cpanel/notifications endpoint exists.
   Each notification has a working href so click-to-navigate is testable now. */
const DEMO_NOTIFS: Notif[] = [
  { id: "d1", type: "lead",        title: "ליד חדש (דמו)",                 body: "אסתר כהן השאירה פרטים בדף נחיתה",          ts: "לפני 3 דק'",  unread: true,  href: "/leads" },
  { id: "d2", type: "message",     title: "הודעה לא נענתה (דמו)",          body: "דניאל לוי שלח 4 הודעות בשעה האחרונה",      ts: "לפני 12 דק'", unread: true,  href: "/chat" },
  { id: "d3", type: "payment",     title: "תשלום התקבל (דמו)",              body: "₪2,400 מחברת דמו בע״מ",                     ts: "לפני שעה",    unread: true,  href: "/clients" },
  { id: "d4", type: "appointment", title: "פגישה מחר (דמו)",                body: "ניהול תיק — מיכל שטרן · 09:30",             ts: "לפני 3 שעות", unread: false, href: "/appointments" },
  { id: "d5", type: "alert",       title: "תקציב יומי קרוב לסיום (דמו)",   body: "קמפיין 'לידים אפריל' — 92% תקציב נוצל",   ts: "לפני 5 שעות", unread: false, href: "/campaigns" },
];

export function NotificationCenter() {
  const navigate = useNavigate();
  const [open, setOpen]     = useState(false);
  const [notifs, setNotifs] = useState<Notif[]>(DEMO_NOTIFS);
  const ref = useRef<HTMLDivElement>(null);

  function handleClick(n: Notif) {
    setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, unread: false } : x));
    setOpen(false);
    navigate(n.href);
  }

  const unreadCount = notifs.filter(n => n.unread).length;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function markAllRead() {
    setNotifs(prev => prev.map(n => ({ ...n, unread: false })));
  }


  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="header-icon-btn"
        onClick={() => setOpen(o => !o)}
        title="התראות"
        style={{ position: "relative" }}
      >
        <IcoBell size={18} />
        {unreadCount > 0 && (
          <span style={{
            position: "absolute",
            top: 4, right: 4,
            minWidth: 16, height: 16,
            background: "var(--negative)",
            color: "#fff",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            border: "1.5px solid #fff",
            lineHeight: 1,
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown">
          <div className="notif-header">
            <div>
              <div style={{ fontSize: "var(--t-base)", fontWeight: 800, color: "var(--ink)" }}>התראות</div>
              <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 2 }}>
                {unreadCount > 0 ? `${unreadCount} חדשות` : "הכל נקרא"}
              </div>
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: "var(--t-xs)", fontWeight: 600,
                  color: "var(--blue)",
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                <IcoCheck size={12} /> סמן הכל
              </button>
            )}
          </div>

          <div className="notif-list">
            {notifs.length === 0 ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
                אין התראות כרגע
              </div>
            ) : (
              notifs.map(n => {
                const tint = TINTS[n.type];
                return (
                  <div
                    key={n.id}
                    className={`notif-item${n.unread ? " unread" : ""}`}
                    onClick={() => handleClick(n)}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: "var(--r-2)",
                      background: tint.bg, color: tint.color,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      {ICONS[n.type]}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)" }}>{n.title}</div>
                      <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)", marginTop: 2, lineHeight: 1.4 }}>{n.body}</div>
                      <div style={{ fontSize: 10, color: "var(--ink-4)", marginTop: 4, fontWeight: 600 }}>{n.ts}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div style={{
            padding: "10px 20px",
            borderTop: "1px solid var(--rule)",
            background: "var(--bg-tint)",
            textAlign: "center",
          }}>
            <button
              onClick={() => { setOpen(false); navigate("/logs"); }}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--blue)", borderBottom: "1px solid var(--blue-line)", padding: 0 }}
            >
              הצג את כל ההתראות
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
