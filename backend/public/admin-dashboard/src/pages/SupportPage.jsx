import { useState, useEffect, useCallback } from "react";
import { Headphones, MessageSquare, Users } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

export default function SupportPage() {
  const [stats, setStats] = useState(null);
  const [agents, setAgents] = useState([]);
  const [chats, setChats] = useState({ chats: [], page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    Promise.all([
      api.get("/api/admin/support/stats"),
      api.get("/api/admin/support/agents"),
    ]).then(([s, a]) => {
      setStats(s.data);
      setAgents(a.data.agents);
    }).catch(console.error);
  }, []);

  const loadChats = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/support/chats", {
        params: { page, limit: 25, status: statusFilter || undefined },
      });
      setChats(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { loadChats(); }, [loadChats]);

  const chatColumns = [
    {
      key: "participants",
      label: "Participants",
      render: (v) => (v || []).join(", ") || "—",
    },
    {
      key: "status",
      label: "Status",
      render: (v) => (
        <Badge variant={v === "open" ? "warning" : v === "closed" ? "neutral" : "info"}>
          {v || "unknown"}
        </Badge>
      ),
    },
    { key: "station", label: "Station", render: (v) => v || "—" },
    {
      key: "messages",
      label: "Messages",
      render: (v) => (v?.length || 0),
    },
    {
      key: "updated_at",
      label: "Last Update",
      render: (v) => (v ? format(new Date(v), "MMM d, HH:mm") : "—"),
    },
  ];

  const s = stats;

  return (
    <div>
      <PageHeader title="Support" subtitle="Chat tickets & agent performance" />

      {s && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard title="Open Tickets" value={s.byStatus?.open || 0} icon={Headphones} color="orange" />
          <StatCard title="Closed" value={s.byStatus?.closed || 0} icon={Headphones} color="green" />
          <StatCard title="Total Messages" value={s.totalMessages?.toLocaleString()} icon={MessageSquare} color="blue" />
          <StatCard title="Agents" value={agents.length} icon={Users} color="purple" />
        </div>
      )}

      {/* Agents List */}
      {agents.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Agents</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {agents.map((a) => (
              <div key={a._id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <div className={`w-2 h-2 rounded-full ${a.active ? "bg-green-500" : "bg-gray-300"}`} />
                <div>
                  <p className="text-sm font-medium text-gray-700">{a.name}</p>
                  <p className="text-xs text-gray-400">{a.role} · {a.station || "no station"}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status filter */}
      <div className="flex items-center gap-2 mb-3">
        {["", "open", "closed", "waiting"].map((v) => (
          <button
            key={v}
            onClick={() => { setStatusFilter(v); setPage(1); }}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              statusFilter === v ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {v || "All"}
          </button>
        ))}
      </div>

      <DataTable
        columns={chatColumns}
        data={chats.chats}
        loading={loading}
        page={chats.page}
        totalPages={chats.totalPages}
        onPageChange={setPage}
        emptyMessage="No chats found"
      />
    </div>
  );
}
