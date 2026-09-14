import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Target, MessageCircle, Calendar, Star, Loader2, Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import api from "../api/client";
import Badge from "../components/shared/Badge";
import { localizeEvent } from "../utils/labels";

export default function UserDetailPage() {
  const { phone } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await api.get(`/api/appinfo/users/${phone}`);
        setData(res.data);
      } catch (err) {
        console.error("User detail error:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [phone]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (!data?.customer) {
    return <div className="text-center text-gray-400 py-12">המשתמש לא נמצא</div>;
  }

  const { customer, brief, leads, chat, appointments, gallery, smsLogs, ratings, recentActivity } = data;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate("/users")} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-4">
          {customer.logoUrl && (
            <img src={customer.logoUrl} alt="" className="w-12 h-12 rounded-full object-cover border border-gray-200" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{customer.firstname || customer.accountname || phone}</h1>
            <p className="text-sm text-gray-500">{customer.bizname || phone}</p>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1"><Target size={16} /> לידים</div>
          <p className="text-xl font-bold">{leads.totalLeads}</p>
          <p className="text-xs text-gray-400">{leads.formCount} טפסים</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1"><MessageCircle size={16} /> צ'אט</div>
          <p className="text-xl font-bold">{chat.totalMessages}</p>
          <p className="text-xs text-gray-400">{chat.userMessages} משתמש / {chat.agentMessages} סוכן</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1"><Calendar size={16} /> פגישות</div>
          <p className="text-xl font-bold">{appointments.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1"><Star size={16} /> דירוגים</div>
          <p className="text-xl font-bold">{ratings.length}</p>
          {ratings.length > 0 && (
            <p className="text-xs text-gray-400">
              ממוצע: {(ratings.reduce((s, r) => s + r.rating, 0) / ratings.length).toFixed(1)}/5
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Profile info */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">פרופיל</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">טלפון</dt>
              <dd className="font-medium">{customer.phone}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">אימייל</dt>
              <dd className="font-medium">{customer.email || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">עסק</dt>
              <dd className="font-medium">{customer.bizname || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">תדריך</dt>
              <dd className="font-medium">{brief ? `שלב ${brief.currentStep}/${brief.totalSteps}` : "טרם החל"}</dd>
            </div>
            {customer.websiteUrl && (
              <div className="flex justify-between">
                <dt className="text-gray-500">אתר</dt>
                <dd><a href={customer.websiteUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs">צפייה</a></dd>
              </div>
            )}
            {customer.driveUrl && (
              <div className="flex justify-between">
                <dt className="text-gray-500">דרייב</dt>
                <dd><a href={customer.driveUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs">פתיחה</a></dd>
              </div>
            )}
          </dl>
        </div>

        {/* Lead forms */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">טפסי לידים ({leads.formCount})</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {leads.forms.map((f) => (
              <div key={f.formId} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                <span className="text-gray-700 truncate flex-1 text-xs">{f.formName}</span>
                <Badge variant="info">{f.leadsCount} לידים</Badge>
              </div>
            ))}
            {leads.forms.length === 0 && <p className="text-gray-400 text-sm">אין טפסים</p>}
          </div>
        </div>

        {/* Gallery */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">גלריה ({gallery.length})</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {gallery.map((g, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
                <span className="text-gray-600 text-xs truncate flex-1">{g.imageUrl?.split("/").pop()}</span>
                <Badge variant={g.status === "approved" ? "success" : "neutral"}>{g.status}</Badge>
              </div>
            ))}
            {gallery.length === 0 && <p className="text-gray-400 text-sm">אין תמונות</p>}
          </div>
        </div>
      </div>

      {/* Appointments */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">פגישות</h3>
        <div className="max-h-64 overflow-y-auto space-y-2">
          {appointments.map((a) => (
            <div key={a._id} className="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
              <div>
                <span className="text-gray-700">{a.subject || a.callPurpose || "פגישה"}</span>
                {a.notes && <p className="text-xs text-gray-400">{a.notes}</p>}
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={a.status === "active" ? "success" : a.status === "cancelled" ? "danger" : "neutral"}>
                  {a.status === "active" ? "פעיל" : a.status === "cancelled" ? "בוטל" : a.status}
                </Badge>
                <span className="text-xs text-gray-400">
                  {a.scheduledStart ? format(new Date(a.scheduledStart), "d/M, HH:mm") : "—"}
                </span>
              </div>
            </div>
          ))}
          {appointments.length === 0 && <p className="text-gray-400 text-sm text-center py-4">אין פגישות</p>}
        </div>
      </div>

      {/* SMS logs */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">לוגי SMS</h3>
        <div className="max-h-48 overflow-y-auto space-y-2">
          {smsLogs.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-50 last:border-0">
              <Badge variant={s.success ? "success" : "danger"}>{s.success ? "נשלח" : "נכשל"}</Badge>
              <span className="text-xs text-gray-400">
                {s.created_at ? format(new Date(s.created_at), "d/M, HH:mm") : "—"}
              </span>
            </div>
          ))}
          {smsLogs.length === 0 && <p className="text-gray-400 text-sm text-center py-4">אין לוגי SMS</p>}
        </div>
      </div>

      {/* App Activity */}
      <div className="bg-white rounded-xl border p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Activity size={16} className="text-blue-500" /> פעילות אחרונה באפליקציה
          </h3>
          <Link to={`/users/${phone}/activity`} className="text-xs text-blue-500 hover:underline">צפייה בהכל ←</Link>
        </div>
        <div className="space-y-2">
          {recentActivity?.map((ev, i) => (
            <div key={ev._id || i} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <div className="flex items-center gap-2">
                <Badge color={ev.type === "action" ? "green" : ev.type === "screen_view" ? "blue" : ev.type === "api_call" ? "purple" : "gray"}>
                  {ev.type === "screen_view" ? "מסך" : ev.type === "action" ? "פעולה" : ev.type === "api_call" ? "API" : ev.type}
                </Badge>
                <span className="text-sm text-gray-700 truncate max-w-[250px]">{localizeEvent(ev.type, ev.name)}</span>
              </div>
              <span className="text-xs text-gray-400 whitespace-nowrap">
                {ev.createdAt ? format(new Date(ev.createdAt), "d/M, HH:mm:ss") : "—"}
              </span>
            </div>
          ))}
          {(!recentActivity || recentActivity.length === 0) && (
            <p className="text-gray-400 text-sm text-center py-4">אין עדיין פעילות באפליקציה</p>
          )}
        </div>
      </div>
    </div>
  );
}
