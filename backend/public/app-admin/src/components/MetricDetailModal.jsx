import { useEffect, useState, useMemo } from "react";
import { X, Search, Download } from "lucide-react";
import api from "../api/client";

function formatCell(value, type) {
  if (value === null || value === undefined) return "—";
  if (type === "date") {
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return "—";
      return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch { return "—"; }
  }
  if (type === "currency") {
    return "₪" + Number(value).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  if (type === "status") {
    const ok = value === true;
    return (
      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ok ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
        {ok ? "נסגרה" : "פתוחה"}
      </span>
    );
  }
  if (typeof value === "number") return value.toLocaleString("he-IL");
  return String(value);
}

function toCSV(columns, rows) {
  const head = columns.map(c => `"${c.label}"`).join(",");
  const body = rows.map(r =>
    columns.map(c => {
      let v = r[c.key];
      if (v === null || v === undefined) v = "";
      if (c.type === "date" && v) v = new Date(v).toISOString();
      if (c.type === "status") v = v === true ? "נסגרה" : "פתוחה";
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(",")
  ).join("\n");
  return head + "\n" + body;
}

export default function MetricDetailModal({ type, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!type) return;
    setLoading(true);
    setError(null);
    api.get(`/api/appinfo/metrics/details/${encodeURIComponent(type)}`)
      .then(r => setData(r.data))
      .catch(e => setError(e?.response?.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [type]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!data?.rows) return [];
    if (!search.trim()) return data.rows;
    const q = search.trim().toLowerCase();
    return data.rows.filter(r =>
      data.columns.some(c => {
        const v = r[c.key];
        if (v == null) return false;
        return String(v).toLowerCase().includes(q);
      })
    );
  }, [data, search]);

  function downloadCSV() {
    if (!data) return;
    const csv = toCSV(data.columns, filtered);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!type) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      dir="rtl"
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-800">
            {loading ? "טוען..." : data?.title || "פירוט"}
          </h2>
          <div className="flex items-center gap-2">
            {!loading && data?.rows?.length > 0 && (
              <button
                onClick={downloadCSV}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition"
                title="ייצוא CSV"
              >
                <Download size={14} />
                CSV
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
              aria-label="סגור"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {!loading && !error && data?.rows?.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="חיפוש..."
                className="w-full bg-gray-50 border border-gray-200 rounded-lg pr-9 pl-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
              />
            </div>
            <p className="text-xs text-gray-500">
              {filtered.length === data.rows.length
                ? `${data.rows.length.toLocaleString("he-IL")} שורות`
                : `${filtered.length.toLocaleString("he-IL")} מתוך ${data.rows.length.toLocaleString("he-IL")}`}
            </p>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="h-64 flex items-center justify-center text-gray-400 text-sm">טוען נתונים...</div>
          ) : error ? (
            <div className="h-64 flex items-center justify-center text-red-500 text-sm">{error}</div>
          ) : !data?.rows?.length ? (
            <div className="h-64 flex items-center justify-center text-gray-400 text-sm">אין נתונים</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase sticky top-0 z-10">
                <tr>
                  {data.columns.map(c => (
                    <th key={c.key} className="px-4 py-2.5 text-right font-medium whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50 transition">
                    {data.columns.map(c => (
                      <td key={c.key} className="px-4 py-2.5 text-gray-700 whitespace-nowrap">
                        {formatCell(row[c.key], c.type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
