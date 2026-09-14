import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Coins, TrendingUp, Receipt, CreditCard } from "lucide-react";
import api from "../api/client";
import PageHeader from "../components/shared/PageHeader";
import StatCard from "../components/shared/StatCard";
import DataTable from "../components/shared/DataTable";
import Badge from "../components/shared/Badge";
import { format } from "date-fns";

export default function FinancePage() {
  const [overview, setOverview] = useState(null);
  const [txData, setTxData] = useState({ transactions: [], page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/api/admin/finance/overview")
      .then(({ data }) => setOverview(data))
      .catch(console.error);
  }, []);

  const loadTx = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/finance/transactions", {
        params: { page, limit: 25, phone: search || undefined },
      });
      setTxData(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => { loadTx(); }, [loadTx]);
  useEffect(() => { setPage(1); }, [search]);

  const columns = [
    { key: "phone", label: "Phone" },
    {
      key: "type",
      label: "Type",
      render: (v) => <Badge variant={v === "add" ? "success" : "danger"}>{v}</Badge>,
    },
    { key: "amount", label: "Amount", render: (v) => v?.toLocaleString() },
    { key: "action", label: "Action", render: (v) => v || "—" },
    {
      key: "created_at",
      label: "Date",
      render: (v) => (v ? format(new Date(v), "MMM d, HH:mm") : "—"),
    },
  ];

  const o = overview || {};

  return (
    <div>
      <PageHeader title="Finance" subtitle="Coin transactions & revenue" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Total Coins Added" value={o.totalCoinsAdded?.toLocaleString()} icon={Coins} color="green" />
        <StatCard title="Total Coins Used" value={o.totalCoinsUsed?.toLocaleString()} icon={Coins} color="orange" />
        <StatCard title="This Month" value={o.thisMonthRevenue?.toLocaleString()} icon={TrendingUp} trend={o.revenueTrend} trendLabel="vs last month" color="blue" />
        <StatCard title="Invoices" value={o.totalInvoices} icon={Receipt} color="purple" />
      </div>

      {/* Spend by Action */}
      {o.spendByAction?.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Coins Spent by Action</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={o.spendByAction} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis dataKey="_id" type="category" width={120} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="total" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <DataTable
        columns={columns}
        data={txData.transactions}
        loading={loading}
        page={txData.page}
        totalPages={txData.totalPages}
        onPageChange={setPage}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Filter by phone..."
        emptyMessage="No transactions found"
      />
    </div>
  );
}
