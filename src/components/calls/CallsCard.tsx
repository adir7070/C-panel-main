import { getCalls } from "../../api/calls";
import { useAuth } from "../../context/AuthContext";
import { useApi } from "../../hooks/useApi";
import { CallsList } from "./CallsList";

/** The recorded calls with one phone number — on the lead screen and the
 *  client page. Admins only; renders nothing for anyone else. */
export function CallsCard({ phone }: { phone: string }) {
  const { agent } = useAuth();
  if (agent?.role !== "admin" || !phone) return null;
  return <CallsCardInner phone={phone} />;
}

function CallsCardInner({ phone }: { phone: string }) {
  const { data, loading, error } = useApi(signal => getCalls({ phone, limit: 20 }, signal), [phone]);
  return (
    <section className="card" style={{ padding: "var(--s-4) var(--s-5)", display: "grid", gap: "var(--s-3)", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>📞 שיחות מוקלטות</h3>
        {data && <span className="badge">{data.length}</span>}
        <span className="t-meta" style={{ fontSize: 11, marginInlineStart: "auto" }}>רק מנהלי מערכת</span>
      </div>
      {loading && <p className="t-meta" style={{ fontSize: 12, margin: 0 }}>טוען…</p>}
      {error && <p style={{ fontSize: 12, color: "#B91C1C", margin: 0 }}>{error}</p>}
      {data && data.length === 0 && <p className="t-meta" style={{ fontSize: 12, margin: 0 }}>אין שיחות מוקלטות עם המספר הזה.</p>}
      {data && data.length > 0 && <CallsList calls={data} showParty={false} />}
    </section>
  );
}
