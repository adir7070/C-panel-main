import { useState, useEffect } from "react";
import { Users, MessageCircle, Headphones, Target, Coins, Zap, Loader2 } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import api from "../api/client";
import StatCard from "../components/shared/StatCard";
import PageHeader from "../components/shared/PageHeader";
import { format } from "date-fns";

export default function DashboardPage() {
  const [overview, setOverview] = useState(null);
  const [charts, setCharts] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [ov, ch, ac] = await Promise.all([
          api.get("/api/admin/dashboard/overview"),
          api.get("/api/admin/dashboard/charts"),
          api.get("/api/admin/dashboard/activity?limit=15"),
        ]);
        setOverview(ov.data);
        setCharts(ch.data);
        setActivity(ac.data.activity);
      } catch (err) {
        console.error("Dashboard load error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  const o = overview || {};

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Overview of your IconIQ platform" />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="Total Users" value={o.totalUsers?.toLocaleString()} icon={Users} trend={o.usersTrend} trendLabel="vs last week" color="blue" />
        <StatCard title="Total Leads" value={o.totalLeads?.toLocaleString()} icon={Target} color="green" />
        <StatCard title="WA Sessions" value={o.activeSessions} icon={MessageCircle} color="purple" />
        <StatCard title="Open Tickets" value={o.openTickets} icon={Headphones} color="orange" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard title="Today's Revenue" value={`${o.todayRevenue} coins`} icon={Coins} color="cyan" />
        <StatCard title="New Users (7d)" value={o.newUsersThisWeek} icon={Users} color="blue" />
        <StatCard title="Processing Jobs" value={o.pendingJobs} icon={Zap} color="purple" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Users Chart */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">New Users (30 days)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={charts?.usersByDay || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="_id" tick={{ fontSize: 11 }} tickFormatter={(d) => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={(l) => l} />
              <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Leads Chart */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Leads (30 days)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={charts?.leadsByDay || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="_id" tick={{ fontSize: 11 }} tickFormatter={(d) => d?.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip labelFormatter={(l) => l} />
              <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Activity Feed */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Recent Activity</h3>
        <div className="space-y-3">
          {activity.map((a, i) => (
            <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
              <div className="flex items-center gap-3">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    a.type === "new_user" ? "bg-blue-500" : a.type === "new_lead" ? "bg-green-500" : "bg-purple-500"
                  }`}
                />
                <span className="text-gray-700">{a.label}</span>
                {a.phone && <span className="text-gray-400 text-xs">{a.phone}</span>}
              </div>
              <span className="text-xs text-gray-400 shrink-0">
                {a.date ? format(new Date(a.date), "MMM d, HH:mm") : "—"}
              </span>
            </div>
          ))}
          {activity.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-4">No recent activity</p>
          )}
        </div>
      </div>
    </div>
  );
}
