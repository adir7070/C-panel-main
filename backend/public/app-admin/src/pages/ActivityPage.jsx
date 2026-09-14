import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Eye, MousePointerClick, Users, Zap, Loader2, Search, RefreshCw,
  Smartphone, Package, Route, ChevronDown, ChevronUp, Clock,
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import api from "../api/client";
import StatCard from "../components/shared/StatCard";
import PageHeader from "../components/shared/PageHeader";
import Badge from "../components/shared/Badge";
import { localizeScreen, localizeAction, localizePath, localizeEvent } from "../utils/labels";

const TYPE_CONFIG = {
  screen_view: { color: "info", label: "מסך" },
  screen_leave: { color: "neutral", label: "יציאה" },
  action: { color: "success", label: "פעולה" },
  api_call: { color: "purple", label: "API" },
};

const PIE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("he-IL", {
    day: "numeric", month: "numeric", year: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "כרגע";
  if (diff < 3600000) return `לפני ${Math.floor(diff / 60000)} דק'`;
  if (diff < 86400000) return `לפני ${Math.floor(diff / 3600000)} שע'`;
  return `לפני ${Math.floor(diff / 86400000)} ימים`;
}

function fmtDuration(ms) {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export default function ActivityPage() {
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [byHour, setByHour] = useState([]);
  const [byDay, setByDay] = useState([]);
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [phone, setPhone] = useState("");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [sessionPhone, setSessionPhone] = useState("");
  const [sessionFrom, setSessionFrom] = useState("");
  const [sessionTo, setSessionTo] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState(null);
  const [paths, setPaths] = useState([]);
  const [pathDepth, setPathDepth] = useState(3);
  const [pathsLoading, setPathsLoading] = useState(false);
  const [dropoffs, setDropoffs] = useState([]);
  const [dropoffsLoading, setDropoffsLoading] = useState(false);
  const limit = 30;

  const loadAll = useCallback(async () => {
    try {
      const [ov, hr, dy] = await Promise.all([
        api.get("/api/appinfo/app-activity/overview"),
        api.get("/api/appinfo/app-activity/by-hour"),
        api.get("/api/appinfo/app-activity/by-day"),
      ]);
      setOverview(ov.data);
      setByHour(hr.data.byHour || []);
      setByDay(dy.data.byDay || []);
    } catch (err) {
      console.error("Activity overview error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const { data } = await api.get("/api/appinfo/app-activity/recent", {
        params: { page, limit, type: type || undefined, phone: phone || undefined, search: search || undefined },
      });
      setEvents(data.data || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error("Activity events error:", err);
    } finally {
      setEventsLoading(false);
    }
  }, [page, type, phone, search]);

  const loadSessions = useCallback(async (phoneNum, from, to) => {
    if (!phoneNum) return;
    setSessionsLoading(true);
    try {
      const params = { phone: phoneNum, limit: 20 };
      if (from) params.from = from;
      if (to) params.to = to;
      const { data } = await api.get("/api/appinfo/app-activity/sessions", { params });
      setSessions(data.sessions || []);
    } catch (err) {
      console.error("Sessions error:", err);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadPaths = useCallback(async (depth = 3) => {
    setPathsLoading(true);
    try {
      const params = { depth };
      if (sessionFrom) params.from = sessionFrom;
      if (sessionTo) params.to = sessionTo;
      const { data } = await api.get("/api/appinfo/app-activity/paths", { params });
      setPaths(data.paths || []);
    } catch (err) {
      console.error("Paths error:", err);
    } finally {
      setPathsLoading(false);
    }
  }, [sessionFrom, sessionTo]);

  const loadDropoffs = useCallback(async () => {
    setDropoffsLoading(true);
    try {
      const params = {};
      if (sessionFrom) params.from = sessionFrom;
      if (sessionTo) params.to = sessionTo;
      const { data } = await api.get("/api/appinfo/app-activity/dropoffs", { params });
      setDropoffs(data.dropoffs || []);
    } catch (err) {
      console.error("Dropoffs error:", err);
    } finally {
      setDropoffsLoading(false);
    }
  }, [sessionFrom, sessionTo]);

  // Load paths and dropoffs on mount
  useEffect(() => { loadPaths(pathDepth); loadDropoffs(); }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { setPage(1); }, [type, phone, search]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  const ov = overview || {};
  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <PageHeader title="ניטור פעילות באפליקציה" subtitle="התנהגות משתמשים בזמן אמת מהאפליקציה" />
        <button
          onClick={() => { loadAll(); loadEvents(); }}
          className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-800 transition"
        >
          <RefreshCw size={14} /> רענון הכל
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="משתמשים פעילים היום" value={ov.activeToday?.toLocaleString()} icon={Users} color="blue" />
        <StatCard title="משתמשים פעילים (7 ימים)" value={ov.activeWeek?.toLocaleString()} icon={Users} color="cyan" />
        <StatCard title="אירועים היום" value={ov.eventsToday?.toLocaleString()} icon={Zap} color="green" />
        <StatCard title="אירועים (7 ימים)" value={ov.eventsWeek?.toLocaleString()} icon={Zap} color="purple" />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">אירועים לפי שעה (7 ימים אחרונים)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={byHour}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={2} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">פעילות יומית (30 ימים אחרונים)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={byDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="_id" tick={{ fontSize: 10 }} interval={4} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v, name) => [v, name === "count" ? "אירועים" : "משתמשים"]} />
              <Legend />
              <Line type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} dot={false} name="אירועים" />
              <Line type="monotone" dataKey="users" stroke="#10b981" strokeWidth={2} dot={false} name="משתמשים" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Platform + App Version + Active Users */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Platform Breakdown */}
        {ov.byPlatform?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Smartphone size={16} className="text-blue-500" /> פלטפורמה (7 ימים)
            </h3>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie
                  data={ov.byPlatform.map(p => ({ name: p._id || "לא ידוע", value: p.users }))}
                  cx="50%" cy="50%" innerRadius={40} outerRadius={65}
                  dataKey="value" paddingAngle={3}
                >
                  {ov.byPlatform.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => [`${v} משתמשים`]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-1.5 mt-3">
              {ov.byPlatform.map((p) => (
                <div key={p._id} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600 capitalize">{p._id || "לא ידוע"}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">{p.users} משתמשים</span>
                    <span className="text-xs font-medium text-blue-600">{p.events.toLocaleString()} אירועים</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* App Version Breakdown */}
        {ov.byAppVersion?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Package size={16} className="text-purple-500" /> גרסאות אפליקציה (7 ימים)
            </h3>
            <div className="space-y-2">
              {ov.byAppVersion.map((v, i) => {
                const maxEvents = ov.byAppVersion[0]?.events || 1;
                const pct = Math.round((v.events / maxEvents) * 100);
                return (
                  <div key={v._id || i}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700 font-medium">v{v._id || "לא ידוע"}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-400">{v.users} משתמשים</span>
                        <span className="text-xs font-medium text-purple-600">{v.events.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-purple-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Active Users */}
        {ov.activeUsers?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Users size={16} className="text-green-500" /> משתמשים פעילים (7 ימים)
            </h3>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {ov.activeUsers.map((u) => (
                <div
                  key={u._id}
                  className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-gray-50 cursor-pointer transition"
                  onClick={() => navigate(`/users/${u._id}/activity`)}
                >
                  <div>
                    <div className="text-sm font-medium text-gray-800">{u._id}</div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <span className="capitalize">{u.platform}</span>
                      {u.osVersion && <span>OS {u.osVersion}</span>}
                      <span>v{u.appVersion}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-medium text-gray-600">{u.eventCount.toLocaleString()} אירועים</div>
                    <div className="text-xs text-gray-400">{fmtRelative(u.lastSeen)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Top Screens & Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {ov.topScreens?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <Eye size={16} className="text-blue-500" /> מסכים מובילים (7 ימים)
            </h3>
            <div className="space-y-2">
              {ov.topScreens.map((s, i) => (
                <div key={s._id} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-xs text-gray-400 text-right">{i + 1}</span>
                    <span className="text-gray-700 font-medium">{localizeScreen(s._id)}</span>
                  </div>
                  <span className="text-xs text-blue-600 font-medium">{s.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {ov.topActions?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <MousePointerClick size={16} className="text-green-500" /> פעולות מובילות (7 ימים)
            </h3>
            <div className="space-y-2">
              {ov.topActions.map((a, i) => (
                <div key={a._id} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-xs text-gray-400 text-right">{i + 1}</span>
                    <span className="text-gray-700 font-medium">{localizeAction(a._id)}</span>
                  </div>
                  <span className="text-xs text-green-600 font-medium">{a.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Common Paths & Drop-offs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Common Paths */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Route size={16} className="text-orange-500" /> מסעות משתמש נפוצים
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">שלבים:</span>
              {[2, 3, 4, 5].map((d) => (
                <button
                  key={d}
                  onClick={() => { setPathDepth(d); loadPaths(d); }}
                  className={`w-7 h-7 rounded-lg text-xs font-medium transition ${pathDepth === d ? "bg-orange-500 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          {pathsLoading ? (
            <div className="text-center py-8"><Loader2 size={20} className="animate-spin text-gray-400 mx-auto" /></div>
          ) : paths.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Route size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">אין מספיק נתונים עדיין</p>
              <p className="text-xs mt-1">מסלולים יופיעו ככל שמשתמשים נוספים יפעלו באפליקציה</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
              {paths.map((p, i) => {
                const maxCount = paths[0]?.count || 1;
                const pct = Math.round((p.count / maxCount) * 100);
                const steps = p.path.split(" → ").map(localizeScreen);
                return (
                  <div key={i} className="group rounded-lg border border-gray-100 hover:border-orange-200 hover:bg-orange-50/30 transition p-3">
                    <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
                      {steps.map((step, j) => (
                        <div key={j} className="flex items-center gap-1.5 shrink-0">
                          {j > 0 && (
                            <svg width="16" height="10" className="text-orange-300 shrink-0 -scale-x-100"><path d="M0 5h12M9 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          )}
                          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${j === 0 ? "bg-green-100 text-green-800" : j === steps.length - 1 ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"}`}>
                            {j === 0 && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
                            {j === steps.length - 1 && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                            {step}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs font-semibold text-orange-600 shrink-0 w-8 text-right">{p.count}×</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Drop-offs */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Eye size={16} className="text-red-500" /> נקודות יציאה מהפעלה
            </h3>
            <button onClick={loadDropoffs} className="p-1.5 hover:bg-gray-100 rounded-lg transition">
              <RefreshCw size={14} className="text-gray-400" />
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-4">המסך האחרון שמשתמשים רואים לפני יציאה מהאפליקציה</p>
          {dropoffsLoading ? (
            <div className="text-center py-8"><Loader2 size={20} className="animate-spin text-gray-400 mx-auto" /></div>
          ) : dropoffs.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <Eye size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">אין מספיק נתונים עדיין</p>
              <p className="text-xs mt-1">נתוני יציאה יופיעו ככל שמצטברות הפעלות</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
              {dropoffs.map((d, i) => {
                const maxExits = dropoffs[0]?.exits || 1;
                const barPct = Math.round((d.exits / maxExits) * 100);
                const exitRatio = d.entries > 0 ? Math.round((d.exits / d.entries) * 100) : 100;
                const severity = exitRatio >= 80 ? "red" : exitRatio >= 50 ? "orange" : "yellow";
                const sevColors = {
                  red: { bg: "bg-red-50", border: "border-red-200", bar: "from-red-400 to-red-500", badge: "bg-red-100 text-red-700", dot: "bg-red-500" },
                  orange: { bg: "bg-orange-50", border: "border-orange-200", bar: "from-orange-400 to-orange-500", badge: "bg-orange-100 text-orange-700", dot: "bg-orange-500" },
                  yellow: { bg: "bg-yellow-50", border: "border-yellow-200", bar: "from-yellow-400 to-yellow-500", badge: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500" },
                };
                const c = sevColors[severity];
                return (
                  <div key={i} className={`rounded-lg border ${c.border} ${c.bg} p-3 transition hover:shadow-sm`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                        <span className="text-sm font-semibold text-gray-800">{localizeScreen(d.screen)}</span>
                      </div>
                      <span className={`text-xs font-bold rounded-full px-2 py-0.5 ${c.badge}`}>
                        {exitRatio}% שיעור יציאה
                      </span>
                    </div>
                    <div className="flex items-center gap-4 mb-2">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-green-600 font-medium">{d.entries}</span>
                        <span className="text-gray-400">הפעלות נכנסו</span>
                      </div>
                      <svg width="16" height="10" className="text-gray-300 -scale-x-100"><path d="M0 5h12M9 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="text-red-600 font-medium">{d.exits}</span>
                        <span className="text-gray-400">הפעלות הסתיימו כאן</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-white/60 rounded-full overflow-hidden">
                      <div className={`h-full bg-gradient-to-r ${c.bar} rounded-full`} style={{ width: `${barPct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Session Flow */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
        <h3 className="text-sm font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <Route size={16} className="text-orange-500" /> זרימת הפעלות משתמש
        </h3>

        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">מספר טלפון</label>
            <input
              type="text"
              value={sessionPhone}
              onChange={(e) => setSessionPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadSessions(sessionPhone, sessionFrom, sessionTo)}
              placeholder="הזן טלפון..."
              className="border rounded-lg px-3 py-2 text-sm w-40"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">מתאריך</label>
            <input
              type="date"
              value={sessionFrom}
              onChange={(e) => setSessionFrom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">עד תאריך</label>
            <input
              type="date"
              value={sessionTo}
              onChange={(e) => setSessionTo(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <button
            onClick={() => loadSessions(sessionPhone, sessionFrom, sessionTo)}
            disabled={!sessionPhone || sessionsLoading}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-800 transition disabled:opacity-40"
          >
            {sessionsLoading ? <Loader2 size={14} className="animate-spin" /> : "טעינה"}
          </button>
          {/* Quick pick from active users */}
          {ov.activeUsers?.length > 0 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">בחירה מהירה</label>
              <select
                className="border rounded-lg px-3 py-2 text-sm"
                value=""
                onChange={(e) => { setSessionPhone(e.target.value); loadSessions(e.target.value, sessionFrom, sessionTo); }}
              >
                <option value="">בחר משתמש...</option>
                {ov.activeUsers.map((u) => (
                  <option key={u._id} value={u._id}>{u._id} ({u.eventCount} אירועים)</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {sessions.length > 0 ? (
          <div className="space-y-4">
            {sessions.map((s) => {
              const isOpen = expandedSession === s.id;
              const sessionDuration = s.durationMs < 60000
                ? `${Math.round(s.durationMs / 1000)}s`
                : s.durationMs < 3600000
                  ? `${Math.round(s.durationMs / 60000)}m`
                  : `${(s.durationMs / 3600000).toFixed(1)}h`;
              const fmtStepDuration = (ms) => !ms ? "" : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`;

              return (
                <div key={s.id} className={`rounded-xl border overflow-hidden transition-shadow ${isOpen ? "border-blue-200 shadow-lg shadow-blue-100/50" : "border-gray-200 hover:shadow-md"}`}>
                  {/* Session header */}
                  <div
                    className={`flex items-center justify-between px-5 py-4 cursor-pointer transition ${isOpen ? "bg-gradient-to-r from-blue-50 to-indigo-50" : "bg-gray-50 hover:bg-gray-100"}`}
                    onClick={() => setExpandedSession(isOpen ? null : s.id)}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center transition ${isOpen ? "bg-blue-500" : "bg-gray-200"}`}>
                        {isOpen
                          ? <ChevronUp size={16} className="text-white" />
                          : <ChevronDown size={16} className="text-gray-500" />
                        }
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-800">
                          {new Date(s.start).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="inline-flex items-center gap-1 text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
                            <Eye size={10} /> {s.screenCount} מסכים
                          </span>
                          {s.actionCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
                              <MousePointerClick size={10} /> {s.actionCount} פעולות
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5 font-medium">
                            <Clock size={10} /> {sessionDuration}
                          </span>
                        </div>
                      </div>
                    </div>
                    {/* Mini flow preview */}
                    <div className="hidden md:flex items-center gap-1 text-xs max-w-sm overflow-hidden">
                      {s.steps.slice(0, 5).map((step, j) => (
                        <span key={j} className="flex items-center gap-1 shrink-0">
                          {j > 0 && <svg width="12" height="8" className="text-gray-300 shrink-0 -scale-x-100"><path d="M0 4h8M6 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                          <span className={`rounded px-1.5 py-0.5 truncate max-w-[80px] ${j === 0 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>{localizeScreen(step.screen)}</span>
                        </span>
                      ))}
                      {s.steps.length > 5 && <span className="text-gray-400 ml-1">+{s.steps.length - 5}</span>}
                    </div>
                  </div>

                  {/* Expanded flow — GA-style horizontal Sankey */}
                  {isOpen && (
                    <div className="p-6 bg-gradient-to-b from-gray-50/50 to-white overflow-x-auto">
                      <div className="flex items-stretch min-w-max" dir="rtl">
                        {s.steps.map((step, j) => {
                          const isFirst = j === 0;
                          const isLast = j === s.steps.length - 1;
                          const hasActions = step.actions?.length > 0;
                          const cardColor = isFirst
                            ? { bg: "bg-green-400", text: "text-white", border: "border-green-500", flow: "#86efac" }
                            : isLast
                            ? { bg: "bg-red-400", text: "text-white", border: "border-red-500", flow: "#fca5a5" }
                            : { bg: "bg-emerald-300", text: "text-emerald-950", border: "border-emerald-400", flow: "#6ee7b7" };
                          return (
                            <div key={j} className="flex items-stretch">
                              {/* Step column */}
                              <div className="flex flex-col items-stretch w-[180px]">
                                {/* Step header */}
                                <div className="flex items-center justify-between mb-2 px-1">
                                  <span className="text-[11px] font-semibold text-gray-500">שלב {j + 1}</span>
                                  <span className="text-[11px] text-gray-400">
                                    {new Date(step.enteredAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                </div>

                                {/* Main flat card (Sankey block) */}
                                <div className={`${cardColor.bg} ${cardColor.text} border ${cardColor.border} rounded-md shadow-sm px-3 py-3 flex flex-col gap-1`}>
                                  <div className="text-sm font-bold truncate text-center leading-tight">
                                    {localizeScreen(step.screen)}
                                  </div>
                                  <div className="flex items-center justify-center gap-2 text-[11px] opacity-90">
                                    {step.duration != null && (
                                      <span className="inline-flex items-center gap-1">
                                        <Clock size={10} /> {fmtStepDuration(step.duration)}
                                      </span>
                                    )}
                                    {isFirst && <span className="font-semibold">• התחלה</span>}
                                    {isLast && <span className="font-semibold">• יציאה</span>}
                                  </div>
                                </div>

                                {/* Action chips below the card */}
                                {hasActions && (
                                  <div className="flex flex-col gap-1 mt-2">
                                    {step.actions.map((a, k) => (
                                      <span
                                        key={k}
                                        className="inline-flex items-center justify-center gap-1 text-[10px] bg-blue-50 border border-blue-200 text-blue-700 rounded px-2 py-1 font-medium truncate"
                                        title={localizeAction(a)}
                                      >
                                        <MousePointerClick size={9} className="shrink-0" /> {localizeAction(a)}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Sankey-style flowing connector to next step */}
                              {!isLast && (
                                <div className="flex items-start pt-7 w-10 shrink-0">
                                  <svg width="40" height="44" viewBox="0 0 40 44" preserveAspectRatio="none" className="overflow-visible">
                                    <defs>
                                      <linearGradient id={`flow-${s.id}-${j}`} x1="0%" y1="0%" x2="100%" y2="0%">
                                        <stop offset="0%" stopColor={cardColor.flow} stopOpacity="0.85" />
                                        <stop offset="100%" stopColor={s.steps[j + 1] && j + 1 === s.steps.length - 1 ? "#fca5a5" : "#6ee7b7"} stopOpacity="0.85" />
                                      </linearGradient>
                                    </defs>
                                    <path
                                      d="M 0 22 C 20 22, 20 22, 40 22"
                                      stroke={`url(#flow-${s.id}-${j})`}
                                      strokeWidth="32"
                                      fill="none"
                                      strokeLinecap="butt"
                                    />
                                  </svg>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : sessionsLoading ? (
          <div className="text-center py-12"><Loader2 size={24} className="animate-spin text-gray-400 mx-auto" /></div>
        ) : sessionPhone ? (
          <div className="text-center py-12 text-gray-400">
            <Route size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">לא נמצאו הפעלות עבור משתמש זה</p>
          </div>
        ) : (
          <div className="text-center py-12 text-gray-400">
            <Route size={32} className="mx-auto mb-2 opacity-30" />
            <p className="text-sm">בחר משתמש לצפייה במסע ההפעלות שלו</p>
            <p className="text-xs mt-1">השתמש בבחירה מהירה או הזן מספר טלפון</p>
          </div>
        )}
      </div>

      {/* Events Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">פיד אירועים חי</h3>
          <span className="text-xs text-gray-400">{total.toLocaleString()} אירועים</span>
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-100 bg-gray-50/50">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="">כל הסוגים</option>
            <option value="screen_view">צפיית מסך</option>
            <option value="screen_leave">יציאה ממסך</option>
            <option value="action">פעולה</option>
            <option value="api_call">קריאת API</option>
          </select>
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="סינון לפי טלפון..."
            className="border rounded-lg px-3 py-1.5 text-sm w-36 bg-white"
          />
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute right-2.5 top-2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="חיפוש שם אירוע..."
              className="border rounded-lg pr-8 pl-3 py-1.5 text-sm w-full bg-white"
            />
          </div>
          <button
            onClick={() => { loadEvents(); }}
            className="p-1.5 bg-white border rounded-lg hover:bg-gray-50 transition"
            title="רענון"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2.5 text-right w-24">סוג</th>
                <th className="px-4 py-2.5 text-right">שם אירוע</th>
                <th className="px-4 py-2.5 text-right w-28">טלפון</th>
                <th className="px-4 py-2.5 text-right w-20">פלטפורמה</th>
                <th className="px-4 py-2.5 text-right w-20">גרסה</th>
                <th className="px-4 py-2.5 text-right w-20">משך</th>
                <th className="px-4 py-2.5 text-right">מטאדאטה</th>
                <th className="px-4 py-2.5 text-right w-36">זמן</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {eventsLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <Loader2 size={24} className="animate-spin text-gray-400 mx-auto" />
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400">לא נמצאה פעילות</td>
                </tr>
              ) : events.map((ev, i) => {
                const cfg = TYPE_CONFIG[ev.type] || TYPE_CONFIG.action;
                return (
                  <tr key={ev._id || i} className="hover:bg-gray-50/50 transition text-sm">
                    <td className="px-4 py-2.5">
                      <Badge variant={cfg.color}>{cfg.label}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-gray-800">{localizeEvent(ev.type, ev.name)}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className="text-blue-600 hover:underline cursor-pointer"
                        onClick={() => ev.phone && navigate(`/users/${ev.phone}/activity`)}
                      >
                        {ev.phone}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 capitalize text-xs">{ev.deviceInfo?.platform || "—"}</td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs">{ev.deviceInfo?.appVersion ? `v${ev.deviceInfo.appVersion}` : "—"}</td>
                    <td className="px-4 py-2.5 text-blue-600 text-xs font-medium">{ev.duration != null ? fmtDuration(ev.duration) : "—"}</td>
                    <td className="px-4 py-2.5">
                      {ev.meta && Object.keys(ev.meta).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(ev.meta).map(([k, v]) => (
                            <span key={k} className="bg-gray-100 rounded px-1.5 py-0.5 text-xs text-gray-600">
                              {k}: {String(v)}
                            </span>
                          ))}
                        </div>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{fmtDate(ev.timestamp || ev.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <span className="text-xs text-gray-500">עמוד {page} מתוך {totalPages}</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="px-2 py-1 rounded border bg-white text-xs disabled:opacity-30 hover:bg-gray-50">→ הקודם</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="px-2 py-1 rounded border bg-white text-xs disabled:opacity-30 hover:bg-gray-50">הבא ←</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
