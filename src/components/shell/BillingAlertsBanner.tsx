import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBillingAlerts, type BillingAlert } from "../../api/quotes";
import { useAuth } from "../../context/AuthContext";

/** Monthly quote charges that need a person: a declined charge (it retries
 *  daily, 3 tries), past due, or no saved card. Admins see every client,
 *  managers only their own (the server scopes it). Hidden when empty. */
export function BillingAlertsBanner() {
  const { agent } = useAuth();
  const [alerts, setAlerts] = useState<BillingAlert[]>([]);

  useEffect(() => {
    if (!agent) return;
    let ctrl: AbortController | null = null;
    const load = () => {
      ctrl?.abort();
      ctrl = new AbortController();
      getBillingAlerts(ctrl.signal).then(setAlerts).catch(() => { /* keep the last list */ });
    };
    load();
    const timer = window.setInterval(load, 5 * 60_000);
    window.addEventListener("focus", load);
    return () => {
      ctrl?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [agent]);

  if (alerts.length === 0) return null;

  return (
    <div role="alert" style={{
      margin: "var(--s-3) var(--s-5) 0", padding: "10px 14px", borderRadius: "var(--r-3)",
      background: "#FEF2F2", border: "1px solid #FECACA", color: "#991B1B", fontSize: 13,
      display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap",
    }}>
      <strong style={{ whiteSpace: "nowrap" }}>⚠️ {alerts.length === 1 ? "חיוב חודשי אחד דורש טיפול" : `${alerts.length} חיובים חודשיים דורשים טיפול`}:</strong>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {alerts.map(a => (
          <Link key={a.quoteId} to={`/clients/${encodeURIComponent(a.phone)}/personal_catalog`}
            style={{ color: "#991B1B", background: "#fff", border: "1px solid #FECACA", borderRadius: 999, padding: "1px 10px", textDecoration: "none" }}
            title={a.lastError || undefined}>
            {a.clientName} · הצעה {a.quoteNo} · {a.status === "past_due" ? "נעצר אחרי 3 ניסיונות" : a.status === "needs_card" ? "אין כרטיס שמור" : `נכשל ${a.failedAttempts}/${a.maxTries}`}
          </Link>
        ))}
      </span>
    </div>
  );
}
