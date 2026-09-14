import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Image, Sparkles, Layers } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

export default function ContentPage() {
  const [stats, setStats] = useState(null);
  const [jobs, setJobs] = useState({ jobs: [], page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [jobType, setJobType] = useState("instagram");

  useEffect(() => {
    api.get("/api/admin/content/stats")
      .then(({ data }) => setStats(data))
      .catch(console.error);
  }, []);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/content/jobs", {
        params: { page, limit: 25, type: jobType },
      });
      setJobs(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, jobType]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  const columns = [
    { key: "jobId", label: "Job ID", render: (v) => <span className="text-xs font-mono">{v?.slice(0, 12)}</span> },
    {
      key: "status",
      label: "Status",
      render: (v) => (
        <Badge variant={v === "completed" ? "success" : v === "processing" ? "warning" : v === "failed" ? "danger" : "neutral"}>
          {v}
        </Badge>
      ),
    },
    {
      key: "createdAt",
      label: "Created",
      render: (v) => (v ? format(new Date(v), "MMM d, HH:mm") : "—"),
    },
  ];

  const s = stats;

  return (
    <div>
      <PageHeader title="AI & Content" subtitle="Generation jobs & statistics" />

      {s && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard title="Instagram Jobs" value={s.instagram.total} icon={Sparkles} color="purple" />
            <StatCard title="Batch Jobs" value={s.imageBatch.total} icon={Layers} color="blue" />
            <StatCard title="Total Images" value={s.totalImages?.toLocaleString()} icon={Image} color="green" />
            <StatCard
              title="Processing Now"
              value={(s.instagram.byStatus?.processing || 0) + (s.imageBatch.byStatus?.processing || 0)}
              icon={Sparkles}
              color="orange"
            />
          </div>

          {s.dailyGenerations?.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Generations (30d)</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={s.dailyGenerations}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="_id" tick={{ fontSize: 10 }} tickFormatter={(d) => d?.slice(5)} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2 mb-3">
        {["instagram", "batch"].map((t) => (
          <button
            key={t}
            onClick={() => { setJobType(t); setPage(1); }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              jobType === t ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {t === "instagram" ? "Instagram Jobs" : "Batch Jobs"}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={jobs.jobs}
        loading={loading}
        page={jobs.page}
        totalPages={jobs.totalPages}
        onPageChange={setPage}
        emptyMessage="No jobs found"
      />
    </div>
  );
}
