import { useState, useEffect, useCallback, useRef } from "react";
import {
  Upload, UserCircle, CheckCircle, AlertCircle,
  RefreshCw, Pencil, Trash2, X, Save,
} from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";

const ROLE_LABELS = {
  account_manager: "מנהל תיק",
  admin:           "מנהל מערכת",
  supervisor:      "סופרוויזר",
  finance:         "כספים",
};

const ROLE_OPTIONS = [
  { value: "account_manager", label: "מנהל תיק" },
  { value: "supervisor",      label: "סופרוויזר" },
  { value: "finance",         label: "כספים" },
  { value: "admin",           label: "מנהל מערכת" },
];

const TABS = [
  { key: "portfolio", label: "מנהלי תיקים" },
  { key: "all",       label: "כולם" },
  { key: "inactive",  label: "לא פעילים" },
];

/* ── helpers ─────────────────────────────────────────────────────────── */

function filterManagers(managers, tab) {
  if (tab === "portfolio") return managers.filter((m) => m.role === "account_manager" && m.active);
  if (tab === "inactive")  return managers.filter((m) => !m.active);
  return managers;
}

/* ── Toast ───────────────────────────────────────────────────────────── */

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-white text-sm font-medium ${
        toast.type === "success" ? "bg-green-600" : "bg-red-600"
      }`}
    >
      {toast.type === "success" ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
      {toast.message}
    </div>
  );
}

/* ── Edit Modal ──────────────────────────────────────────────────────── */

function EditModal({ manager, onClose, onSave }) {
  const [form, setForm] = useState({
    nickname: manager.nickname || "",
    name:     manager.name || "",
    phone:    manager.phone || "",
    role:     manager.role || "account_manager",
    active:   manager.active !== false,
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/appinfo/managers/${manager.id}`, {
        nickname: form.nickname || null,
        name:     form.name || undefined,
        phone:    form.phone || null,
        role:     form.role,
        active:   form.active,
      });
      onSave();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-96 p-6 mx-4"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold text-gray-800">עריכת מנהל</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="שם תצוגה (כינוי)">
            <input
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.nickname}
              onChange={(e) => set("nickname", e.target.value)}
              placeholder="כינוי שיופיע ללקוחות"
            />
          </Field>

          <Field label="שם מלא">
            <input
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>

          <Field label="טלפון (פנימי בלבד)">
            <input
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="05X-XXXXXXX"
              dir="ltr"
            />
          </Field>

          <Field label="תפקיד">
            <select
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Field>

          <Field label="סטטוס">
            <label className="flex items-center gap-2 cursor-pointer">
              <div
                className={`w-10 h-6 rounded-full transition-colors ${form.active ? "bg-blue-600" : "bg-gray-300"}`}
                onClick={() => set("active", !form.active)}
              >
                <div className={`w-4 h-4 rounded-full bg-white shadow mt-1 transition-transform ${form.active ? "translate-x-5" : "translate-x-1"}`} />
              </div>
              <span className="text-sm text-gray-700">{form.active ? "פעיל" : "לא פעיל"}</span>
            </label>
          </Field>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
            שמור
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-100 rounded-xl"
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

/* ── Manager Card ────────────────────────────────────────────────────── */

function ManagerCard({ manager, onEdit, onDelete, onUpload, uploading }) {
  const fileRef = useRef(null);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-col items-center gap-3 hover:shadow-md transition-shadow relative">
      {/* Action buttons */}
      <div className="absolute top-2 left-2 flex gap-1">
        <button
          onClick={() => onEdit(manager)}
          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          title="עריכה"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={() => onDelete(manager)}
          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          title="מחיקה"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Role badge */}
      <span className={`absolute top-2 right-2 text-xs px-2 py-0.5 rounded-full font-medium ${
        manager.role === "account_manager"
          ? "bg-blue-50 text-blue-700"
          : "bg-gray-100 text-gray-500"
      }`}>
        {ROLE_LABELS[manager.role] || manager.role}
      </span>

      {/* Avatar */}
      <div className="w-20 h-20 mt-4 relative">
        {manager.avatarUrl ? (
          <img
            src={manager.avatarUrl}
            alt={manager.nickname || manager.name}
            className="w-20 h-20 rounded-full object-cover border-2 border-gray-100"
          />
        ) : (
          <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center">
            <UserCircle size={44} className="text-gray-300" />
          </div>
        )}
      </div>

      {/* Name */}
      <div className="text-center">
        <p className="font-semibold text-gray-800 text-sm leading-tight">
          {manager.nickname || manager.name || "ללא שם"}
        </p>
        {manager.nickname && manager.name && (
          <p className="text-xs text-gray-400 mt-0.5">{manager.name}</p>
        )}
      </div>

      {/* Upload button */}
      <label className="w-full cursor-pointer">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          ref={fileRef}
          onChange={(e) => {
            onUpload(manager, e.target.files[0]);
            if (fileRef.current) fileRef.current.value = "";
          }}
          disabled={uploading === manager.id}
        />
        <div
          className={`flex items-center justify-center gap-1.5 w-full py-1.5 px-3 rounded-lg text-xs font-medium transition-colors ${
            uploading === manager.id
              ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : "bg-blue-50 text-blue-700 hover:bg-blue-100"
          }`}
        >
          <Upload size={13} />
          {uploading === manager.id ? "מעלה..." : "העלה תמונה"}
        </div>
      </label>
    </div>
  );
}

/* ── Main Page ───────────────────────────────────────────────────────── */

export default function ManagersPage() {
  const [managers, setManagers] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState("portfolio");
  const [uploading, setUploading] = useState(null);
  const [editing, setEditing]   = useState(null);
  const [toast, setToast]       = useState(null);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/appinfo/managers");
      setManagers(data.agents || []);
    } catch (err) {
      console.error("Managers load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (manager, file) => {
    if (!file) return;
    setUploading(manager.id);
    try {
      const form = new FormData();
      form.append("avatar", file);
      await api.post(`/api/appinfo/managers/${manager.id}/avatar`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      showToast("success", `תמונה עודכנה עבור ${manager.nickname || manager.name}`);
      await load();
    } catch {
      showToast("error", "שגיאה בהעלאת התמונה — נסה שוב");
    } finally {
      setUploading(null);
    }
  };

  const handleDelete = async (manager) => {
    if (!window.confirm(`להסיר את ${manager.nickname || manager.name}?`)) return;
    try {
      await api.delete(`/api/appinfo/managers/${manager.id}`);
      showToast("success", `${manager.nickname || manager.name} הוסר`);
      await load();
    } catch {
      showToast("error", "שגיאה במחיקה");
    }
  };

  const handleEditSave = async () => {
    setEditing(null);
    showToast("success", "השינויים נשמרו");
    await load();
  };

  const visible = filterManagers(managers, tab);

  const counts = {
    portfolio: managers.filter((m) => m.role === "account_manager" && m.active).length,
    all:       managers.length,
    inactive:  managers.filter((m) => !m.active).length,
  };

  return (
    <div dir="rtl">
      <PageHeader
        title="מנהלי תיקים"
        subtitle="ניהול תמונות ופרטים"
        actions={
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw size={16} />
            רענן
          </button>
        }
      />

      <Toast toast={toast} />

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
            <span className={`mr-1.5 text-xs ${tab === t.key ? "text-blue-600" : "text-gray-400"}`}>
              {counts[t.key]}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-gray-400">
          <RefreshCw size={24} className="animate-spin ml-2" />
          טוען...
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-24 text-gray-400">אין מנהלים להצגה</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {visible.map((m) => (
            <ManagerCard
              key={m.id}
              manager={m}
              onEdit={setEditing}
              onDelete={handleDelete}
              onUpload={handleUpload}
              uploading={uploading}
            />
          ))}
        </div>
      )}

      {editing && (
        <EditModal
          manager={editing}
          onClose={() => setEditing(null)}
          onSave={handleEditSave}
        />
      )}
    </div>
  );
}
