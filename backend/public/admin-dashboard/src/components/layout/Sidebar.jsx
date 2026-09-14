import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Target,
  CreditCard,
  MessageCircle,
  Sparkles,
  Headphones,
  Calendar,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/leads", icon: Target, label: "Leads" },
  { to: "/finance", icon: CreditCard, label: "Finance" },
  { to: "/whatsapp", icon: MessageCircle, label: "WhatsApp" },
  { to: "/content", icon: Sparkles, label: "AI & Content" },
  { to: "/support", icon: Headphones, label: "Support" },
  { to: "/appointments", icon: Calendar, label: "Appointments" },
  { to: "/system", icon: Settings, label: "System" },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { agent, logout } = useAuth();

  return (
    <aside
      className={`fixed left-0 top-0 h-screen bg-gray-900 text-white flex flex-col transition-all duration-300 z-50 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-16 px-4 border-b border-gray-800">
        {!collapsed && (
          <span className="text-lg font-bold tracking-tight">IconIQ</span>
        )}
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      {/* Navigation */}
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

      {/* Footer */}
      <div className="border-t border-gray-800 p-3">
        {!collapsed && agent && (
          <div className="mb-2 px-2 text-xs text-gray-500 truncate">
            {agent.name}
          </div>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors w-full"
          title="Logout"
        >
          <LogOut size={20} className="shrink-0" />
          {!collapsed && <span>Logout</span>}
        </button>
      </div>
    </aside>
  );
}
