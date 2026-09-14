import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { Eye, MousePointerClick, Globe, ArrowLeft, Search, RefreshCw } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import Badge from "../components/shared/Badge";
import UserJourneySankey from "../components/shared/UserJourneySankey";
import { localizeScreen, localizeAction, localizeEvent } from "../utils/labels";

const TYPE_CONFIG = {
  screen_view: { icon: Eye, color: "blue", label: "מסך" },
  screen_leave: { icon: Eye, color: "gray", label: "יציאה ממסך" },
  action: { icon: MousePointerClick, color: "green", label: "פעולה" },
  api_call: { icon: Globe, color: "purple", label: "API" },
};

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("he-IL", {
    day: "numeric", month: "numeric", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtDuration(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function UserActivityPage() {
  const { phone } = useParams();
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("limit", String(pageSize));

      const res = await api.get(`/api/appinfo/user-activity/${phone}?${params}`);
      if (res.data.success) {
        setEvents(res.data.data || []);
        setTotal(res.data.total || 0);
      }
    } catch (e) {
      console.error("Failed to fetch activity:", e);
    } finally {
      setLoading(false);
    }
  }, [phone, type, search, page]);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get(`/api/appinfo/user-activity/${phone}/summary`);
      if (res.data.success) setSummary(res.data);
    } catch (_) {}
  }, [phone]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div className="flex items-center gap-3">
        <Link to={`/users/${phone}`} className="p-2 rounded-lg hover:bg-gray-100 transition">
          <ArrowLeft size={20} className="text-gray-500" />
        </Link>
        <PageHeader title={`פעילות — ${phone}`} subtitle="ציר זמן מלא של פעילות המשתמש" />
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border p-4">
            <p className="text-xs text-gray-500">צפיות במסכים</p>
            <p className="text-2xl font-bold text-blue-600">{summary.screenViews?.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <p className="text-xs text-gray-500">פעולות</p>
            <p className="text-2xl font-bold text-green-600">{summary.actions?.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <p className="text-xs text-gray-500">קריאות API</p>
            <p className="text-2xl font-bold text-purple-600">{summary.apiCalls?.toLocaleString()}</p>
          </div>
          <div className="bg-white rounded-xl border p-4">
            <p className="text-xs text-gray-500">פעיל לאחרונה</p>
            <p className="text-sm font-semibold text-gray-700">{fmtDate(summary.lastActive)}</p>
          </div>
        </div>
      )}

      {/* Aggregated User Journey (Sankey) */}
      <UserJourneySankey phone={phone} />

      {/* Top Screens & Actions */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {summary.topScreens?.length > 0 && (
            <div className="bg-white rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">מסכים מובילים</h3>
              <div className="space-y-2">
                {summary.topScreens.map((s) => (
                  <div key={s._id} className="flex justify-between text-sm">
                    <span className="text-gray-600">{localizeScreen(s._id)}</span>
                    <span className="font-medium text-gray-800">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary.topActions?.length > 0 && (
            <div className="bg-white rounded-xl border p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">פעולות מובילות</h3>
              <div className="space-y-2">
                {summary.topActions.map((a) => (
                  <div key={a._id} className="flex justify-between text-sm">
                    <span className="text-gray-600">{localizeAction(a._id)}</span>
                    <span className="font-medium text-gray-800">{a.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">סוג</label>
          <select
            value={type}
            onChange={(e) => { setType(e.target.value); setPage(1); }}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">הכל</option>
            <option value="screen_view">צפיית מסך</option>
            <option value="action">פעולה</option>
            <option value="api_call">קריאת API</option>
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
              onKeyDown={(e) => e.key === "Enter" && (setPage(1), fetchEvents())}
              placeholder="חיפוש לפי שם אירוע..."
              className="border rounded-lg pr-9 pl-3 py-2 text-sm w-full"
            />
          </div>
        </div>
        <button
          onClick={() => { setPage(1); fetchEvents(); }}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-800 transition flex items-center gap-2"
        >
          <Search size={14} /> סינון
        </button>
        <button
          onClick={() => { fetchEvents(); fetchSummary(); }}
          className="px-3 py-2 bg-white border rounded-lg text-sm hover:bg-gray-50 transition"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-xl border overflow-hidden">
        {loading ? (
          <div className="text-center py-12 text-gray-400 text-sm">טוען...</div>
        ) : events.length === 0 ? (
          <div className="text-center py-12 text-gray-400 text-sm">לא נמצאה פעילות</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {events.map((ev, i) => {
              const cfg = TYPE_CONFIG[ev.type] || TYPE_CONFIG.action;
              const Icon = cfg.icon;
              return (
                <div key={ev._id || i} className="flex items-start gap-4 px-5 py-4 hover:bg-gray-50 transition">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-${cfg.color}-50`}>
                    <Icon size={16} className={`text-${cfg.color}-500`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge color={cfg.color}>{cfg.label}</Badge>
                      <span className="text-sm font-medium text-gray-800 truncate">{localizeEvent(ev.type, ev.name)}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400">
                      <span>{fmtDate(ev.timestamp)}</span>
                      {ev.duration != null && <span>{fmtDuration(ev.duration)}</span>}
                      {ev.meta?.statusCode && <span>סטטוס: {ev.meta.statusCode}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 text-xs text-gray-500">
            <span>סה"כ: {total.toLocaleString()} אירועים</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-2 py-1 rounded border bg-white disabled:opacity-30">→ הקודם</button>
              <span>{page} / {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-2 py-1 rounded border bg-white disabled:opacity-30">הבא ←</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
