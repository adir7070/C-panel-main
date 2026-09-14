import { useState, useEffect, useCallback } from "react";
import { MessageCircle, Wifi, WifiOff, CheckCircle, XCircle } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

export default function WhatsAppPage() {
  const [sessionsData, setSessionsData] = useState(null);
  const [logs, setLogs] = useState({ logs: [], page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [logsPage, setLogsPage] = useState(1);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/whatsapp/sessions")
      .then(({ data }) => setSessionsData(data))
      .catch(console.error);
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/whatsapp/sms-logs", {
        params: { page: logsPage, limit: 25, phone: search || undefined },
      });
      setLogs(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [logsPage, search]);

  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => { setLogsPage(1); }, [search]);

  const s = sessionsData;

  const sessionColumns = [
    { key: "phone", label: "Phone" },
    {
      key: "status",
      label: "Status",
      render: (v) => (
        <Badge variant={v === "connected" ? "success" : v === "qr_pending" ? "warning" : "danger"}>
          {v}
        </Badge>
      ),
    },
    { key: "session_id", label: "Session ID", render: (v) => <span className="text-xs font-mono">{v?.slice(0, 12)}...</span> },
    {
      key: "created_at",
      label: "Created",
      render: (v) => (v ? format(new Date(v), "MMM d, HH:mm") : "—"),
    },
  ];

  const logColumns = [
    { key: "phone", label: "Phone" },
    {
      key: "success",
      label: "Status",
      render: (v) => (
        <Badge variant={v ? "success" : "danger"}>
          {v ? "Sent" : "Failed"}
        </Badge>
      ),
    },
    {
      key: "created_at",
      label: "Time",
      render: (v) => (v ? format(new Date(v), "MMM d, HH:mm") : "—"),
    },
  ];

  return (
    <div>
      <PageHeader title="WhatsApp" subtitle="Sessions & message logs" />

      {s && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard title="Total Sessions" value={s.totalSessions} icon={MessageCircle} color="green" />
          <StatCard title="Connected" value={s.connectedCount} icon={Wifi} color="blue" />
          <StatCard title="SMS Success Rate" value={`${s.smsStats.successRate}%`} icon={CheckCircle} color="purple" />
          <StatCard title="Failed SMS" value={s.smsStats.failed} icon={XCircle} color="red" />
        </div>
      )}

      {/* Sessions Table */}
      {s?.sessions?.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Sessions</h3>
          <DataTable columns={sessionColumns} data={s.sessions} loading={false} emptyMessage="No sessions" />
        </div>
      )}

      {/* SMS Logs */}
      <h3 className="text-sm font-semibold text-gray-700 mb-3">SMS Logs</h3>
      <DataTable
        columns={logColumns}
        data={logs.logs}
        loading={loading}
        page={logs.page}
        totalPages={logs.totalPages}
        onPageChange={setLogsPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Filter by phone..."
        emptyMessage="No SMS logs"
      />
    </div>
  );
}
