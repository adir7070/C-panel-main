import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Calendar, Clock } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

const STATUS_VARIANT = { scheduled: "info", completed: "success", cancelled: "danger", "no-show": "warning" };

export default function AppointmentsPage() {
  const [stats, setStats] = useState(null);
  const [data, setData] = useState({ appointments: [], page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/appointments/stats")
      .then(({ data }) => setStats(data))
      .catch(console.error);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get("/api/admin/appointments", {
        params: { page, limit: 25, search: search || undefined },
      });
      setData(d);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  const columns = [
    { key: "customerName", label: "Customer", render: (v) => v || "—" },
    { key: "customerPhone", label: "Phone", render: (v) => v || "—" },
    {
      key: "status",
      label: "Status",
      render: (v) => <Badge variant={STATUS_VARIANT[v] || "neutral"}>{v || "unknown"}</Badge>,
    },
    {
      key: "scheduledStart",
      label: "Scheduled",
      render: (v) => (v ? format(new Date(v), "MMM d, yyyy HH:mm") : "—"),
    },
  ];

  return (
    <div>
      <PageHeader title="Appointments" subtitle="Scheduled meetings" />

      {stats && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard title="Upcoming" value={stats.upcoming} icon={Calendar} color="blue" />
            {Object.entries(stats.byStatus).map(([status, count]) => (
              <StatCard key={status} title={status} value={count} icon={Clock} color={status === "completed" ? "green" : status === "cancelled" ? "red" : "orange"} />
            ))}
          </div>

          {stats.daily?.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Appointments (30d)</h3>
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
          )}
        </>
      )}

      <DataTable
        columns={columns}
        data={data.appointments}
        loading={loading}
        page={data.page}
        totalPages={data.totalPages}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by name or phone..."
        emptyMessage="No appointments found"
      />
    </div>
  );
}
