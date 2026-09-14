import { useEffect, useState } from "react";
import { Users, TrendingUp, CalendarDays, UserPlus, FileText, CheckCircle, UserCheck, DollarSign, TrendingDown, Clock, AlertCircle, UsersRound, Percent } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { BarChart, Bar, Cell, XAxis as BXAxis, YAxis as BYAxis, CartesianGrid as BGrid, Tooltip as BTooltip, ResponsiveContainer as BRC } from "recharts";
import api from "../api/client";
import MetricDetailModal from "../components/MetricDetailModal";

const DAY_NAMES = ["", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function StatCard({ icon: Icon, label, value, sub, color, currency, percent, drillType, onDrill }) {
  const display = value === null
    ? "—"
    : currency
      ? "₪" + value.toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 })
      : percent
        ? value + "%"
        : value.toLocaleString();
  const clickable = !!drillType && !!onDrill;
  return (
    <div
      className={`bg-white rounded-xl p-5 shadow-sm border border-gray-100 flex items-center gap-4 ${clickable ? "cursor-pointer hover:shadow-md hover:border-blue-200 transition" : ""}`}
      onClick={clickable ? () => onDrill(drillType) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDrill(drillType); } } : undefined}
    >
      <div className={`p-3 rounded-xl ${color}`}>
        <Icon size={22} className="text-white" />
      </div>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-800 mt-0.5">{display}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-sm">
      <p className="text-gray-500 mb-1">{label}</p>
      <p className="font-semibold text-blue-600">+{payload[0].value} משתמשים חדשים</p>
    </div>
  );
};

function pct(a, b) {
  if (!b) return "0%";
  return Math.round((a / b) * 100) + "%";
}

export default function MetricsPage() {
  const [data, setData] = useState(null);
  const [quotes, setQuotes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingQ, setLoadingQ] = useState(true);
  const [drillType, setDrillType] = useState(null);

  useEffect(() => {
    api.get("/api/appinfo/metrics/active-users")
      .then(r => setData(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));

    api.get("/api/appinfo/metrics/quotes-stats")
      .then(r => setQuotes(r.data))
      .catch(console.error)
      .finally(() => setLoadingQ(false));
  }, []);

  const openDrill = (type) => setDrillType(type);

  return (
    <div className="space-y-8" dir="rtl">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">מדדים</h1>
        <p className="text-gray-500 text-sm mt-1">נתוני שימוש באפליקציה</p>
      </div>

      {/* ── משתמשי אפליקציה ── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          משתמשי האפליקציה
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            icon={Users}
            label="סה״כ משתמשים"
            value={loading ? null : data?.total ?? 0}
            sub="כל הזמנים"
            color="bg-blue-500"
          />
          <StatCard
            icon={UserPlus}
            label="הצטרפו (30 ימים)"
            value={loading ? null : data?.lastMonth ?? 0}
            sub="חודש אחרון"
            color="bg-emerald-500"
          />
          <StatCard
            icon={CalendarDays}
            label="הצטרפו (7 ימים)"
            value={loading ? null : data?.lastWeek ?? 0}
            sub="שבוע אחרון"
            color="bg-violet-500"
          />
        </div>
      </div>

      {/* ── גרף הרשמות ── */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp size={18} className="text-blue-500" />
          <h2 className="font-semibold text-gray-700">הרשמות יומיות (30 ימים אחרונים)</h2>
        </div>
        {loading ? (
          <div className="h-56 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data?.dailyRegistrations ?? []} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorUsers" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="_id"
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                tickFormatter={v => v?.slice(5)}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 11, fill: "#9ca3af" }} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#colorUsers)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── הצעות מחיר ── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
          הצעות מחיר
        </h2>

        {/* כרטיסי סיכום כלליים */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={FileText}
            label="הצעות נשלחו (סה״כ)"
            value={loadingQ ? null : quotes?.totals?.quotesTotal ?? 0}
            sub="כל הזמנים"
            color="bg-slate-500"
            drillType="all"
            onDrill={openDrill}
          />
          <StatCard
            icon={CheckCircle}
            label="הצעות שנסגרו"
            value={loadingQ ? null : quotes?.totals?.quotesClosed ?? 0}
            sub={loadingQ ? null : pct(quotes?.totals?.quotesClosed, quotes?.totals?.quotesTotal) + " מכלל ההצעות"}
            color="bg-green-500"
            drillType="closed"
            onDrill={openDrill}
          />
          <StatCard
            icon={Users}
            label="לקוחות שקיבלו הצעה"
            value={loadingQ ? null : quotes?.totals?.clientsReached ?? 0}
            sub="לקוחות ייחודיים"
            color="bg-amber-500"
            drillType="clientsReached"
            onDrill={openDrill}
          />
          <StatCard
            icon={UserCheck}
            label="לקוחות שסגרו"
            value={loadingQ ? null : quotes?.totals?.clientsClosed ?? 0}
            sub={loadingQ ? null : pct(quotes?.totals?.clientsClosed, quotes?.totals?.clientsReached) + " מכלל הלקוחות"}
            color="bg-teal-500"
            drillType="clientsClosed"
            onDrill={openDrill}
          />
          <StatCard
            icon={DollarSign}
            label="סה״כ הכנסות"
            value={loadingQ ? null : quotes?.totals?.revenueTotal ?? 0}
            sub="מהצעות שנסגרו"
            color="bg-yellow-500"
            currency
            drillType="revenueTotal"
            onDrill={openDrill}
          />
        </div>

        {/* KPI מתקדמים */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            icon={DollarSign}
            label="ממוצע הכנסה לעסקה"
            value={loadingQ ? null : quotes?.totals?.quotesClosed > 0 ? Math.round(quotes.totals.revenueTotal / quotes.totals.quotesClosed) : 0}
            sub="לעסקה סגורה"
            color="bg-indigo-500"
            currency
            drillType="avgRevenue"
            onDrill={openDrill}
          />
          <StatCard
            icon={TrendingUp}
            label="ערך פיפליין פעיל"
            value={loadingQ ? null : quotes?.advanced?.pipelineValue ?? 0}
            sub="הצעות פתוחות"
            color="bg-orange-500"
            currency
            drillType="pipeline"
            onDrill={openDrill}
          />
          <StatCard
            icon={AlertCircle}
            label="הצעות ישנות +30 יום"
            value={loadingQ ? null : quotes?.advanced?.staleQuotes ?? 0}
            sub="פתוחות מעל חודש"
            color="bg-red-500"
            drillType="stale"
            onDrill={openDrill}
          />
          <StatCard
            icon={UsersRound}
            label="לקוחות עם 2+ הצעות"
            value={loadingQ ? null : quotes?.advanced?.multiQuoteClients ?? 0}
            sub="לקוחות עם follow-up"
            color="bg-purple-500"
            drillType="multiQuote"
            onDrill={openDrill}
          />
          <StatCard
            icon={Clock}
            label="ממוצע ימים לסגירה"
            value={loadingQ ? null : quotes?.advanced?.avgDaysToClose ?? 0}
            sub="ימים בממוצע לסגירה"
            color="bg-sky-500"
            drillType="avgDaysToClose"
            onDrill={openDrill}
          />
          <StatCard
            icon={quotes?.advanced?.weekTrendPct >= 0 ? TrendingUp : TrendingDown}
            label="מגמת סגירות שבועית"
            value={loadingQ ? null : Math.abs(quotes?.advanced?.weekTrendPct ?? 0)}
            sub={loadingQ ? null : `${quotes?.advanced?.closedThisWeek ?? 0} השבוע vs ${quotes?.advanced?.closedLastWeek ?? 0} שבוע שעבר`}
            color={quotes?.advanced?.weekTrendPct >= 0 ? "bg-green-500" : "bg-red-500"}
            percent
            drillType="weekTrend"
            onDrill={openDrill}
          />
          <StatCard
            icon={Percent}
            label="שיעור חשיפה"
            value={loadingQ ? null : Math.round((quotes?.advanced?.exposureRate ?? 0) * 100)}
            sub={loadingQ ? null : `${quotes?.advanced?.uniqueClientsWithQuotes ?? 0} מתוך ${quotes?.advanced?.totalUsers ?? 0} משתמשים`}
            color="bg-fuchsia-500"
            percent
            drillType="exposure"
            onDrill={openDrill}
          />
          <StatCard
            icon={UserCheck}
            label="נציג מוביל לעסקה"
            value={loadingQ ? null : (() => {
              const best = quotes?.byAgent
                ?.filter(r => r.quotesClosed > 0)
                ?.reduce((b, r) => {
                  const avg = r.revenueTotal / r.quotesClosed;
                  return !b || avg > b.avg ? { name: r.agentName, avg } : b;
                }, null);
              return best?.avg ? Math.round(best.avg) : 0;
            })()}
            sub={loadingQ ? null : (() => {
              const best = quotes?.byAgent
                ?.filter(r => r.quotesClosed > 0)
                ?.reduce((b, r) => {
                  const avg = r.revenueTotal / r.quotesClosed;
                  return !b || avg > b.avg ? { name: r.agentName, avg } : b;
                }, null);
              return best ? `${best.name} — ממוצע לעסקה` : "אין נתונים";
            })()}
            color="bg-rose-500"
            currency
            drillType="topAgent"
            onDrill={openDrill}
          />
        </div>

        {/* גרפים מתקדמים */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-700 mb-4">הכנסות לפי חודש (12 חודשים)</h3>
            {loadingQ ? (
              <div className="h-56 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
            ) : (
              <BRC width="100%" height={220}>
                <BarChart data={quotes?.advanced?.monthlyStats ?? []} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                  <BGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <BXAxis
                    dataKey="_id"
                    tick={{ fontSize: 11, fill: "#9ca3af" }}
                    tickFormatter={v => v ? v.slice(5) + "/" + v.slice(2, 4) : ""}
                    interval="preserveStartEnd"
                  />
                  <BYAxis tick={{ fontSize: 11, fill: "#9ca3af" }} allowDecimals={false} />
                  <BTooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-sm">
                          <p className="text-gray-500 mb-1">{label}</p>
                          <p className="font-semibold text-indigo-600">₪{payload[0]?.value?.toLocaleString("he-IL")} הכנסות</p>
                          <p className="text-gray-500">{payload[0]?.payload?.count} עסקאות</p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </BRC>
            )}
          </div>

          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-700 mb-4">סגירות לפי יום בשבוע</h3>
            {loadingQ ? (
              <div className="h-56 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
            ) : (() => {
              const dowData = quotes?.advanced?.byDayOfWeek ?? [];
              const maxCount = Math.max(...dowData.map(d => d.count), 0);
              return (
                <BRC width="100%" height={220}>
                  <BarChart data={dowData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                    <BGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <BXAxis
                      dataKey="_id"
                      tick={{ fontSize: 11, fill: "#9ca3af" }}
                      tickFormatter={v => DAY_NAMES[v] ?? v}
                    />
                    <BYAxis tick={{ fontSize: 11, fill: "#9ca3af" }} allowDecimals={false} />
                    <BTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return (
                          <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-sm">
                            <p className="text-gray-500 mb-1">{DAY_NAMES[d?._id] ?? d?._id}</p>
                            <p className="font-semibold text-blue-600">{d?.count} סגירות</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {dowData.map((entry, index) => (
                        <Cell key={index} fill={entry.count === maxCount ? "#22c55e" : "#3b82f6"} />
                      ))}
                    </Bar>
                  </BarChart>
                </BRC>
              );
            })()}
          </div>
        </div>

        {/* מדדים מתקדמים — סבב 2 */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            מדדים מתקדמים — סבב 2
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              icon={Percent}
              label="שיעור הנחות"
              value={loadingQ ? null : quotes?.advanced?.discountUsagePct ?? 0}
              sub={loadingQ ? null : `ממוצע הנחה: ${quotes?.advanced?.avgDiscountGiven ?? 0}%`}
              color="bg-pink-500"
              percent
            />
            <StatCard
              icon={Users}
              label="משתמשים ללא הצעה"
              value={loadingQ ? null : (quotes?.advanced?.totalUsers ?? 0) - (quotes?.advanced?.uniqueClientsWithQuotes ?? 0)}
              sub="לא קיבלו הצעה אף פעם"
              color="bg-gray-500"
            />
            <StatCard
              icon={UsersRound}
              label="לקוח הכי מעקש"
              value={loadingQ ? null : quotes?.advanced?.topClient?.count ?? 0}
              sub={loadingQ ? null : quotes?.advanced?.topClient
                ? `${quotes.advanced.topClient.phone.slice(-4)}**** | סגר: ${quotes.advanced.topClient.closed}`
                : "אין נתונים"}
              color="bg-orange-600"
            />
            <StatCard
              icon={FileText}
              label="ממוצע הצעות לסגירה"
              value={loadingQ ? null : quotes?.advanced?.avgQuotesBeforeClose ?? 0}
              sub="הצעות עד שלקוח קונה"
              color="bg-cyan-500"
            />
            <StatCard
              icon={Clock}
              label="שעת שיא לסגירות"
              value={loadingQ ? null : (() => {
                const hours = quotes?.advanced?.byHour ?? [];
                if (!hours.length) return "—";
                const max = hours.reduce((a, b) => b.count > a.count ? b : a, hours[0]);
                return String(max._id).padStart(2, "0") + ":00";
              })()}
              sub={loadingQ ? null : (() => {
                const hours = quotes?.advanced?.byHour ?? [];
                if (!hours.length) return "";
                const max = hours.reduce((a, b) => b.count > a.count ? b : a, hours[0]);
                return `${max.count} סגירות`;
              })()}
              color="bg-amber-600"
            />
            <StatCard
              icon={CalendarDays}
              label="ממוצע ימים מהרשמה להצעה"
              value={loadingQ ? null : quotes?.advanced?.avgTimeToFirstQuote ?? 0}
              sub="זמן מהרשמה להצעה ראשונה"
              color="bg-teal-600"
            />
            <StatCard
              icon={TrendingUp}
              label="נציג הכי מהיר"
              value={loadingQ ? null : quotes?.advanced?.fastestAgent?.avgDays ?? 0}
              sub={loadingQ ? null : quotes?.advanced?.fastestAgent
                ? `${quotes.advanced.fastestAgent.agentName} | ימים ממוצע לסגירה`
                : "אין נתונים"}
              color="bg-lime-500"
            />
            <StatCard
              icon={DollarSign}
              label="צפי הכנסות חודש הבא"
              value={loadingQ ? null : quotes?.advanced?.forecastNextMonth ?? 0}
              sub="ממוצע 3 חודשים אחרונים"
              color="bg-emerald-600"
              currency
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-700 mb-4">הכנסה ממוצעת לפי יום בשבוע</h3>
              {loadingQ ? (
                <div className="h-56 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
              ) : (() => {
                const data = quotes?.advanced?.avgRevenueByDay ?? [];
                const maxVal = Math.max(...data.map(d => d.avgRevenue), 0);
                return (
                  <BRC width="100%" height={220}>
                    <BarChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                      <BGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <BXAxis
                        dataKey="_id"
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickFormatter={v => DAY_NAMES[v] ?? v}
                      />
                      <BYAxis tick={{ fontSize: 11, fill: "#9ca3af" }} allowDecimals={false} />
                      <BTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0]?.payload;
                          return (
                            <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-sm">
                              <p className="text-gray-500 mb-1">{DAY_NAMES[d?._id] ?? d?._id}</p>
                              <p className="font-semibold text-amber-600">₪{d?.avgRevenue?.toLocaleString("he-IL")}</p>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="avgRevenue" radius={[4, 4, 0, 0]}>
                        {data.map((entry, index) => (
                          <Cell key={index} fill={entry.avgRevenue === maxVal ? "#10b981" : "#f59e0b"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </BRC>
                );
              })()}
            </div>

            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-700 mb-4">סגירות לפי שעה ביום</h3>
              {loadingQ ? (
                <div className="h-56 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
              ) : (() => {
                const data = quotes?.advanced?.byHour ?? [];
                const maxVal = Math.max(...data.map(d => d.count), 0);
                return (
                  <BRC width="100%" height={220}>
                    <BarChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                      <BGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <BXAxis
                        dataKey="_id"
                        tick={{ fontSize: 11, fill: "#9ca3af" }}
                        tickFormatter={v => v + ":00"}
                      />
                      <BYAxis tick={{ fontSize: 11, fill: "#9ca3af" }} allowDecimals={false} />
                      <BTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0]?.payload;
                          return (
                            <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 shadow text-sm">
                              <p className="text-gray-500 mb-1">{d?._id}:00</p>
                              <p className="font-semibold text-violet-600">{d?.count} סגירות</p>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {data.map((entry, index) => (
                          <Cell key={index} fill={entry.count === maxVal ? "#f59e0b" : "#8b5cf6"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </BRC>
                );
              })()}
            </div>
          </div>

          {!loadingQ && (quotes?.advanced?.staleByAgent ?? []).length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
              <div className="px-5 py-4 border-b border-gray-100">
                <h3 className="font-semibold text-gray-700">הצעות קפואות לפי נציג</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                    <tr>
                      <th className="px-5 py-3 text-right font-medium">נציג</th>
                      <th className="px-4 py-3 text-center font-medium">הצעות קפואות (&gt;30 יום)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(quotes.advanced.staleByAgent).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50 transition-colors">
                        <td className="px-5 py-3 font-medium text-gray-800">{row.agentName}</td>
                        <td className="px-4 py-3 text-center text-red-500 font-semibold">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* טבלת נציגים */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-700">פירוט לפי נציג</h3>
          </div>
          {loadingQ ? (
            <div className="h-32 flex items-center justify-center text-gray-400 text-sm">טוען...</div>
          ) : !quotes?.byAgent?.length ? (
            <div className="h-32 flex items-center justify-center text-gray-400 text-sm">אין נתונים</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="px-5 py-3 text-right font-medium">נציג</th>
                    <th className="px-4 py-3 text-center font-medium">הצעות נשלחו</th>
                    <th className="px-4 py-3 text-center font-medium">נסגרו</th>
                    <th className="px-4 py-3 text-center font-medium">פתוחות</th>
                    <th className="px-4 py-3 text-center font-medium">לקוחות שקיבלו</th>
                    <th className="px-4 py-3 text-center font-medium">לקוחות שסגרו</th>
                    <th className="px-4 py-3 text-center font-medium">הכנסות</th>
                    <th className="px-4 py-3 text-center font-medium">המרה</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {quotes.byAgent.map(row => (
                    <tr key={row.agentId} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-800">{row.agentName}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{row.quotesTotal.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center text-green-600 font-medium">{row.quotesClosed.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center text-gray-400">{row.quotesOpen.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{row.clientsReached.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center text-teal-600 font-medium">{row.clientsClosed.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center text-yellow-600 font-medium">
                        ₪{(row.revenueTotal ?? 0).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                          row.conversionRate >= 0.5
                            ? "bg-green-100 text-green-700"
                            : row.conversionRate >= 0.25
                            ? "bg-amber-100 text-amber-700"
                            : "bg-red-100 text-red-600"
                        }`}>
                          {Math.round(row.conversionRate * 100)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {drillType && <MetricDetailModal type={drillType} onClose={() => setDrillType(null)} />}
    </div>
  );
}
