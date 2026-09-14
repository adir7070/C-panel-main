import { useState, useEffect } from "react";
import { Server, Database, Clock, Cpu, Loader2 } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import Badge from "../components/shared/Badge";

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

export default function SystemPage() {
  const [health, setHealth] = useState(null);
  const [collections, setCollections] = useState([]);
  const [settings, setSettings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [h, c, s] = await Promise.all([
          api.get("/api/admin/system/health"),
          api.get("/api/admin/system/collections"),
          api.get("/api/admin/system/settings"),
        ]);
        setHealth(h.data);
        setCollections(c.data.collections);
        setSettings(s.data.settings);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  const h = health || {};

  return (
    <div>
      <PageHeader
        title="System"
        subtitle="Health, collections & settings"
        actions={
          <Badge variant={h.dbConnected ? "success" : "danger"}>
            DB {h.dbConnected ? "Connected" : "Disconnected"}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Status" value={h.status === "ok" ? "Healthy" : "Error"} icon={Server} color={h.status === "ok" ? "green" : "red"} />
        <StatCard title="Uptime" value={h.uptime ? formatUptime(h.uptime) : "—"} icon={Clock} color="blue" />
        <StatCard title="Heap Used" value={h.memory ? `${h.memory.heapUsed} MB` : "—"} icon={Cpu} color="purple" />
        <StatCard title="Node.js" value={h.nodeVersion || "—"} icon={Server} color="cyan" />
      </div>

      {/* Collections */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">MongoDB Collections</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {collections.map((c) => (
            <div key={c.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-gray-400" />
                <span className="text-sm text-gray-700 font-mono">{c.name}</span>
              </div>
              <span className="text-sm font-semibold text-gray-900">{c.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Settings */}
      {settings.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Settings</h3>
          <div className="space-y-2">
            {settings.map((s) => (
              <div key={s._id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <span className="text-sm font-medium text-gray-600">{s.key}</span>
                <span className="text-xs text-gray-400 font-mono max-w-xs truncate">
                  {typeof s.value === "object" ? JSON.stringify(s.value).slice(0, 60) : String(s.value).slice(0, 60)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
