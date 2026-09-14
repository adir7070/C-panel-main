import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import dashenLogo from "../../assets/dashen-logo.jpg";
import {
  IcoHome, IcoUsers, IcoChat, IcoBroadcast, IcoTarget,
  IcoTasks, IcoCalendar, IcoActivity, IcoPipeline, IcoDigest, IcoLogOut, IcoBarChart, IcoCoin, IcoCheck,
} from "../icons/Icons";

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  group?: string;
  adminOnly?: boolean;
  ownerOnly?: boolean; // visible only to the top owner (ADMIN-BOSS)
}

const NAV: NavItem[] = [
  { to: "/",                    label: "דף הבית",     icon: <IcoHome size={17} />,      group: "main" },
  { to: "/clients",             label: "לקוחות",       icon: <IcoUsers size={17} />,     group: "main" },
  { to: "/chat",                label: "צ'אט כללי",    icon: <IcoChat size={17} />,      group: "main" },
  { to: "/broadcast",           label: "שליחה רחבה",   icon: <IcoBroadcast size={17} />, group: "main" },
  { to: "/leads",               label: "לידים",         icon: <IcoTarget size={17} />,    group: "data" },
  { to: "/pipeline",            label: "פייפליין",      icon: <IcoPipeline size={17} />,  group: "data" },
  { to: "/tasks",               label: "משימות",         icon: <IcoTasks size={17} />,     group: "data" },
  { to: "/appointments",        label: "פגישות",         icon: <IcoCalendar size={17} />,  group: "data" },
  { to: "/campaigns",           label: "קמפיינים",       icon: <IcoBarChart size={17} />,  group: "data" },
  { to: "/reviews",             label: "תגובות לקוחות",  icon: <IcoCheck size={17} />,     group: "data" },
  { to: "/wallet",              label: "ארנק ועמלות",   icon: <IcoCoin size={17} />,      group: "tools" },
  { to: "/digest",              label: "דייג׳סט AI",    icon: <IcoDigest size={17} />,    group: "tools" },
  { to: "/logs",                label: "לוגים",          icon: <IcoActivity size={17} />,  group: "tools" },
  { to: "/instructions",        label: "הוראות",         icon: <IcoDigest size={17} />,    group: "tools" },

  /* ── Admin-only group ──────────────────────────────────────────────
     Visible only when agent.role === "admin". Aggregates everything
     across managers (boss view). */
  { to: "/admin",               label: "דשבורד אדמין",   icon: <IcoBarChart size={17} />,  group: "admin", adminOnly: true },
  { to: "/admin/escalations",   label: "פניות מהסוכן",   icon: <IcoChat size={17} />,      group: "admin", adminOnly: true, ownerOnly: true },
  { to: "/admin/agent-updates", label: "עדכונים מהסוכן", icon: <IcoBarChart size={17} />,  group: "admin", adminOnly: true, ownerOnly: true },
  { to: "/admin/clients",       label: "כל הלקוחות",      icon: <IcoUsers size={17} />,     group: "admin", adminOnly: true },
  /* Admins only see the "admin" group, so the shared leads screen needs its
     own entry here too — otherwise an admin can only reach it by URL. */
  { to: "/leads",               label: "כל הלידים",       icon: <IcoTarget size={17} />,    group: "admin", adminOnly: true },
  { to: "/admin/leads-distribution", label: "לידים לחלוקה",  icon: <IcoTarget size={17} />,    group: "admin", adminOnly: true },
  { to: "/admin/finance/revenue",     label: "הכנסות",         icon: <IcoBarChart size={17} />,  group: "admin", adminOnly: true },
  { to: "/admin/integrations",      label: "בריאות אינטגרציות", icon: <IcoActivity size={17} />, group: "admin", adminOnly: true },
  { to: "/admin/broadcasts",        label: "הודעות רחבות",      icon: <IcoBroadcast size={17} />, group: "admin", adminOnly: true },
  { to: "/admin/reports",           label: "דוחות וייצוא",      icon: <IcoBarChart size={17} />,  group: "admin", adminOnly: true },
  { to: "/admin/users",             label: "ניהול משתמשים",     icon: <IcoUsers size={17} />,     group: "admin", adminOnly: true },
  { to: "/admin/instructions",      label: "הוראות",             icon: <IcoDigest size={17} />,    group: "admin", adminOnly: true },
  { to: "/admin/audit",         label: "יומן ביקורת",    icon: <IcoActivity size={17} />,  group: "admin", adminOnly: true },
];

const GROUPS = [
  { key: "main",  label: "ניהול" },
  { key: "data",  label: "נתונים" },
  { key: "tools", label: "כלים" },
  { key: "admin", label: "ניהול ראשי" },
];

interface Props {
  collapsed?: boolean;
  onToggle?:  () => void;
}

export function Sidebar({ collapsed = false, onToggle }: Props) {
  const { agent, logout } = useAuth();

  return (
    <aside className={"shell-side" + (collapsed ? " collapsed" : "")}>

      {/* Logo + collapse toggle. The toggle is always visible — same spot
          collapsed or expanded — so it's never lost. */}
      <div className="side-logo">
        <img src={dashenLogo} alt="דשן מדיה טק" className="side-logo-img" />
        <span className="side-logo-sub">Operations</span>
        <button
          type="button"
          onClick={onToggle}
          className="side-collapse-btn"
          aria-label={collapsed ? "פתח תפריט צד" : "סגור תפריט צד"}
          aria-expanded={!collapsed}
          title={collapsed ? "פתח תפריט (Ctrl+B)" : "סגור תפריט (Ctrl+B)"}
        >
          <ChevronCollapse collapsed={collapsed} />
        </button>
      </div>

      {/* Nav */}
      <nav className="side-nav">
        {GROUPS.map(g => {
          /* Admins only see the "ניהול ראשי" group — clean separation between
             personal-manager workflows and admin-of-the-system workflows. */
          const isAdmin = agent?.role === "admin";
          const isOwner = agent?.name === "admin-boss"
            || (agent?.phone ?? "").replace(/\D/g, "").endsWith("542587070");
          if (isAdmin && g.key !== "admin") return null;
          if (!isAdmin && g.key === "admin") return null;

          const items = NAV.filter(n => n.group === g.key && (!n.adminOnly || isAdmin) && (!n.ownerOnly || isOwner));
          if (!items.length) return null;
          return (
            <div key={g.key} className="side-group">
              <p className="side-group-label">{g.label}</p>
              {items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) => "side-nav-item" + (isActive ? " active" : "")}
                  /* Native tooltip when collapsed so icons-only mode is
                     still discoverable without a custom popover. */
                  title={collapsed ? item.label : undefined}
                  aria-label={item.label}
                >
                  <span className="side-nav-icon">{item.icon}</span>
                  <span className="side-nav-label">{item.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {/* Footer — agent card + logout */}
      {agent && (
        <div className="side-foot">
          <div className="side-agent-card" title={collapsed ? (agent.nickname || agent.name) : undefined}>
            <div className="side-agent-avatar">
              {(agent.nickname || agent.name || "?").charAt(0).toUpperCase()}
            </div>
            <div className="side-agent-info">
              <p className="side-agent-name">{agent.nickname || agent.name}</p>
              <p className="side-agent-role">
                {agent.role === "admin"
                  ? "Administrator"
                  : agent.role === "supervisor"
                  ? "Supervisor"
                  : "Account Manager"}
              </p>
            </div>
          </div>
          <button className="side-logout-full" onClick={logout} title="התנתקות" aria-label="התנתקות">
            <IcoLogOut size={14} />
            <span>התנתקות</span>
          </button>
        </div>
      )}
    </aside>
  );
}

/* Single inline chevron icon — flips direction when collapsed.
   In RTL the natural "open" direction is leftward (chevron points left
   when expanded → click to collapse rightward). When collapsed, points
   right to invite re-opening. */
function ChevronCollapse({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transition: "transform 220ms var(--ease-out)",
        transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
