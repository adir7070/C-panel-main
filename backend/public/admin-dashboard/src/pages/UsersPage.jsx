import { useState, useEffect, useCallback } from "react";
import { ExternalLink, FolderOpen } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

const FILTER_OPTIONS = [
  { value: "", label: "All users" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "has_data", label: "With profile" },
  { value: "has_website", label: "Has website" },
  { value: "has_drive", label: "Has Drive" },
];

export default function UsersPage() {
  const [data, setData] = useState({ users: [], page: 1, totalPages: 1, total: 0 });
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState("clientName");
  const [sortDir, setSortDir] = useState("asc");
  const [statusFilter, setStatusFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get("/api/admin/users", {
        params: {
          page,
          limit: 25,
          search: search || undefined,
          sort: `${sortKey}_${sortDir}`,
          filter: statusFilter || undefined,
        },
      });
      setData(d);
    } catch (err) {
      console.error("Users load error:", err);
    } finally {
      setLoading(false);
    }
  }, [page, search, sortKey, sortDir, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search, sortKey, sortDir, statusFilter]);

  const handleSort = (key, dir) => {
    setSortKey(key);
    setSortDir(dir);
  };

  const columns = [
    {
      key: "clientName",
      label: "Client",
      sortable: true,
      render: (v, row) => (
        <div className="flex items-center gap-2.5">
          {row.logoUrl ? (
            <img src={row.logoUrl} alt="" className="w-8 h-8 rounded-full object-cover bg-gray-100" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500">
              {(v || row.phone)?.[0] || "?"}
            </div>
          )}
          <div>
            <p className="font-medium text-gray-900">{v || "—"}</p>
            <p className="text-xs text-gray-400">{row.phone}</p>
          </div>
        </div>
      ),
    },
    { key: "businessName", label: "Business", sortable: true, render: (v) => v || "—" },
    {
      key: "websiteUrl",
      label: "Website",
      render: (v) =>
        v ? (
          <a
            href={v}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline text-xs"
          >
            {v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            <ExternalLink size={11} />
          </a>
        ) : (
          "—"
        ),
    },
    {
      key: "driveUrl",
      label: "Drive",
      render: (v) =>
        v ? (
          <a
            href={v}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-green-600 hover:text-green-800"
            title="Google Drive"
          >
            <FolderOpen size={15} />
          </a>
        ) : (
          "—"
        ),
    },
    {
      key: "appActive",
      label: "Status",
      sortable: true,
      defaultDir: "desc",
      render: (v) => (
        <Badge variant={v ? "success" : "neutral"}>
          {v ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    {
      key: "coins",
      label: "Coins",
      sortable: true,
      defaultDir: "desc",
      render: (v) => v?.toLocaleString() ?? "0",
    },
    {
      key: "lastActivity",
      label: "Last Active",
      sortable: true,
      defaultDir: "desc",
      render: (v, row) => {
        if (!row.appActive) return "—";
        return v ? format(new Date(v), "MMM d, HH:mm") : "—";
      },
    },
  ];

  return (
    <div>
      <PageHeader title="Users" subtitle={`${data.total} total users`} />

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {FILTER_OPTIONS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              statusFilter === f.value
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={data.users}
        loading={loading}
        page={data.page}
        totalPages={data.totalPages}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by phone, name, or business..."
        emptyMessage="No users found"
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={handleSort}
      />
    </div>
  );
}
