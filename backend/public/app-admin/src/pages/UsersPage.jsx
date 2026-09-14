import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";

export default function UsersPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/appinfo/users", {
        params: { page, limit: 25, search },
      });
      setUsers(data.users);
      setTotalPages(data.totalPages);
    } catch (err) {
      console.error("Users load error:", err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [search]);

  const columns = [
    {
      key: "phone",
      label: "טלפון",
      render: (_, row) => (
        <div>
          <div className="font-medium text-gray-900">{row.phone}</div>
          {row.name && <div className="text-xs text-gray-400">{row.name}</div>}
        </div>
      ),
    },
    { key: "bizname", label: "עסק", render: (v) => v || "—" },
    {
      key: "totalLeads",
      label: "לידים",
      sortable: true,
      render: (v) => <span className="font-medium">{v || 0}</span>,
    },
    {
      key: "chatMessages",
      label: "הודעות צ'אט",
      render: (v) => v || 0,
    },
    {
      key: "appointments",
      label: "פגישות",
      render: (v) => v || 0,
    },
    {
      key: "briefProgress",
      label: "תדריך",
      render: (v) => v ? <Badge variant="info">{v}</Badge> : <span className="text-gray-400">—</span>,
    },
    {
      key: "hasLogo",
      label: "לוגו",
      render: (v, row) =>
        row.logoUrl ? (
          <img src={row.logoUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader title="משתמשים" subtitle={`${users.length > 0 ? totalPages * 25 + "+" : "0"} לקוחות רשומים`} />

      <DataTable
        columns={columns}
        data={users}
        loading={loading}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="חיפוש לפי טלפון, שם, עסק..."
        onRowClick={(row) => navigate(`/users/${row.phone}`)}
      />
    </div>
  );
}
