import { NavLink } from "react-router-dom";
import {
  Users,
  Activity,
  FileText,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  Briefcase,
} from "lucide-react";
const navItems = [
  { to: "/activity", icon: Activity, label: "פעילות", end: true },
  { to: "/metrics", icon: BarChart2, label: "מדדים" },
  { to: "/managers", icon: Briefcase, label: "מנהלים" },
  { to: "/users", icon: Users, label: "משתמשים" },
  { to: "/logs", icon: FileText, label: "לוגים" },
];

export default function Sidebar({ collapsed, onToggle }) {

  return (
    <aside
      className={`fixed right-0 top-0 h-screen bg-gray-900 text-white flex flex-col transition-all duration-300 z-50 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex items-center justify-between h-16 px-4 border-b border-gray-800">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight">ניהול קליק</span>
        )}
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
        >
          {collapsed ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>
      </div>

      <nav className="flex-1 py-4 overflow-y-auto">
        <ul className="space-y-1 px-2">
          {navItems.map(({ to, icon: Icon, label, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "text-gray-400 hover:bg-gray-800 hover:text-white"
                  }`
                }
                title={collapsed ? label : undefined}
              >
                <Icon size={20} className="shrink-0" />
                {!collapsed && <span>{label}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-gray-800 p-3">
        {!collapsed && (
          <div className="px-2 text-xs text-gray-500">ניהול קליק</div>
        )}
      </div>
    </aside>
  );
}
