import { useState, useEffect, useCallback } from "react";
import { FileText, AlertTriangle, AlertCircle, Info, Search, RefreshCw } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import Badge from "../components/shared/Badge";

const LEVEL_BADGE = {
  error: "red",
  warn: "yellow",
  log: "gray",
};

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("he-IL", {
    day: "numeric", month: "numeric", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export default function LogsPage() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState({ log: 0, warn: 0, error: 0 });
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  // Filters
  const [phone, setPhone] = useState("");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (phone) params.set("phone", phone);
      if (level) params.set("level", level);
      if (search) params.set("search", search);
      params.set("limit", String(pageSize));
      params.set("skip", String((page - 1) * pageSize));

      const res = await api.get(`/api/appinfo/log?${params}`);
      if (res.data.success) {
        setLogs(res.data.data || []);
        setTotal(res.data.total || 0);
      }
    } catch (e) {
      console.error("Failed to fetch logs:", e);
    } finally {
      setLoading(false);
    }
  }, [phone, level, search, page]);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (phone) params.set("phone", phone);
      if (search) params.set("search", search);

      const [logRes, warnRes, errRes] = await Promise.all([
        api.get(`/api/appinfo/log?${params}&level=log&limit=0`),
        api.get(`/api/appinfo/log?${params}&level=warn&limit=0`),
        api.get(`/api/appinfo/log?${params}&level=error&limit=0`),
      ]);
      setStats({
        log: logRes.data.total || 0,
        warn: warnRes.data.total || 0,
        error: errRes.data.total || 0,
      });
    } catch (_) {}
  }, [phone, search]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchLogs, 30000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="space-y-6">
      <PageHeader title="לוגי אפליקציה" subtitle="ניטור פעילות ושגיאות באפליקציה" />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border p-5 flex items-center gap-4">
          <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
            <Info size={20} className="text-gray-500" />
          </div>
          <div>
            <p className="text-sm text-gray-500">לוגים</p>
            <p className="text-2xl font-bold text-gray-800">{stats.log.toLocaleString()}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-yellow-100 p-5 flex items-center gap-4">
          <div className="w-10 h-10 bg-yellow-50 rounded-lg flex items-center justify-center">
            <AlertTriangle size={20} className="text-yellow-500" />
          </div>
          <div>
            <p className="text-sm text-yellow-600">אזהרות</p>
            <p className="text-2xl font-bold text-yellow-600">{stats.warn.toLocaleString()}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-red-100 p-5 flex items-center gap-4">
          <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
            <AlertCircle size={20} className="text-red-500" />
          </div>
          <div>
            <p className="text-sm text-red-500">שגיאות</p>
            <p className="text-2xl font-bold text-red-600">{stats.error.toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">טלפון</label>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="0542587070"
            className="border rounded-lg px-3 py-2 text-sm w-36"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">רמה</label>
          <select
            value={level}
            onChange={(e) => { setLevel(e.target.value); setPage(1); }}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">הכל</option>
            <option value="log">לוג</option>
            <option value="warn">אזהרה</option>
            <option value="error">שגיאה</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs text-gray-500 mb-1">חיפוש</label>
          <div className="relative">
            <Search size={16} className="absolute right-3 top-2.5 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (setPage(1), fetchLogs(), fetchStats())}
              placeholder="חיפוש בהודעות..."
              className="border rounded-lg pr-9 pl-3 py-2 text-sm w-full"
            />
          </div>
        </div>
        <button
          onClick={() => { setPage(1); fetchLogs(); fetchStats(); }}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-800 transition flex items-center gap-2"
        >
          <Search size={14} /> סינון
        </button>
        <button
          onClick={() => { fetchLogs(); fetchStats(); }}
          className="px-3 py-2 bg-white border rounded-lg text-sm hover:bg-gray-50 transition"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">טוען...</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">לא נמצאו לוגים</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wider">
                  <th className="text-right px-4 py-3 font-medium">זמן</th>
                  <th className="text-right px-4 py-3 font-medium">טלפון</th>
                  <th className="text-right px-4 py-3 font-medium">רמה</th>
                  <th className="text-right px-4 py-3 font-medium">הודעה</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log, i) => (
                  <tr
                    key={log._id || i}
                    className="hover:bg-gray-50 cursor-pointer transition"
                    onClick={() => setSelected(log)}
                  >
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(log.timestamp)}</td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs">{log.phone || "—"}</td>
                    <td className="px-4 py-3">
                      <Badge color={LEVEL_BADGE[log.level] || "gray"}>{log.level}</Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs max-w-lg truncate">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
            <span>סה"כ: {total.toLocaleString()} לוגים</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-2 py-1 rounded border bg-white disabled:opacity-30 hover:bg-gray-100"
              >
                → הקודם
              </button>
              <span>{page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-2 py-1 rounded border bg-white disabled:opacity-30 hover:bg-gray-100"
              >
                הבא ←
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">פרטי לוג</h3>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-gray-400 mb-1">זמן</p>
                <p className="text-gray-700">{fmtDate(selected.timestamp)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">טלפון</p>
                <p className="font-medium text-gray-800 font-mono">{selected.phone || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">רמה</p>
                <Badge color={LEVEL_BADGE[selected.level] || "gray"}>{selected.level}</Badge>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-1">הודעה</p>
                <pre className="text-gray-700 bg-gray-50 rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">{selected.message}</pre>
              </div>
              {selected.deviceInfo && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">מכשיר</p>
                  <p className="text-gray-600 text-xs">{selected.deviceInfo.platform} {selected.deviceInfo.version} | v{selected.deviceInfo.appVersion}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
