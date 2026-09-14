import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

const STATUS_COLORS = { new: "info", contacted: "warning", converted: "success", closed: "neutral" };
const PIE_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#6b7280", "#8b5cf6", "#ef4444"];

export default function LeadsPage() {
  const [data, setData] = useState({ leads: [], page: 1, totalPages: 1, total: 0 });
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([
        api.get("/api/admin/leads", { params: { page, limit: 25, search: search || undefined } }),
        page === 1 ? api.get("/api/admin/leads/stats") : Promise.resolve(null),
      ]);
      setData(list.data);
      if (s) setStats(s.data);
    } catch (err) {
      console.error("Leads load error:", err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  const columns = [
    { key: "name", label: "Name", render: (v) => v || "—" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email", render: (v) => v || "—" },
    {
      key: "status",
      label: "Status",
      render: (v) => <Badge variant={STATUS_COLORS[v] || "neutral"}>{v || "unknown"}</Badge>,
    },
    {
      key: "created_at",
      label: "Created",
      render: (v) => (v ? format(new Date(v), "MMM d, yyyy") : "—"),
    },
  ];

  return (
    <div>
      <PageHeader title="Leads" subtitle={`${data.total} total leads`} />

      {/* Stats Charts */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">By Status</h3>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={stats.byStatus} dataKey="count" nameKey="_id" cx="50%" cy="50%" outerRadius={80} label={({ _id, count }) => `${_id}: ${count}`}>
                  {stats.byStatus.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Leads (30d)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={stats.daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="_id" tick={{ fontSize: 10 }} tickFormatter={(d) => d?.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#3b82f6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data.leads}
        loading={loading}
        page={data.page}
        totalPages={data.totalPages}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search leads..."
        emptyMessage="No leads found"
      />
    </div>
  );
}
