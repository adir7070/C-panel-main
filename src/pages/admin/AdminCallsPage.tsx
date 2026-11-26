import { useState } from "react";
import { Layout } from "../../components/shell/Layout";
import { Header } from "../../components/shell/Header";
import { Spinner } from "../../components/ui/Spinner";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { CallsList } from "../../components/calls/CallsList";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../context/ToastContext";
import { getCalls, getCallsStatus, syncCalls, type CallRecord } from "../../api/calls";

function stamp(iso: string | null | undefined) {
  if (!iso) return "עוד לא";
  return new Date(iso).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** /admin/calls — every recorded call of the sales line (Extra Mobile), newest
 *  first, with an inline player. Admins only. */
export function AdminCallsPage() {
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [query, setQuery] = useState("");
  const [more, setMore] = useState<CallRecord[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [done, setDone] = useState(false);

  const { data, loading, error, reload } = useApi(signal => getCalls({ phone: query, limit: 50 }, signal), [query]);
  const { data: status, reload: reloadStatus } = useApi(signal => getCallsStatus(signal), []);
  const calls = [...(data ?? []), ...more];

  function search(e?: React.FormEvent) {
    e?.preventDefault();
    setMore([]);
    setDone(false);
    setQuery(phone.trim());
  }

  async function loadMore() {
    const last = calls[calls.length - 1];
    if (!last?.startedAt) return;
    setLoadingMore(true);
    try {
      const page = await getCalls({ phone: query, before: last.startedAt, limit: 50 });
      setMore(m => [...m, ...page]);
      if (page.length < 50) setDone(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "טעינה נכשלה");
    } finally {
      setLoadingMore(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const r = await syncCalls(30);
      if (r.error) toast.error(`הסנכרון עם אקסטרה נכשל: ${r.error}`);
      else if (r.skipped === "no_api_key") toast.warn("מפתח ה-API של אקסטרה עוד לא הוגדר בשרת");
      else toast.ok(`סונכרנו ${r.saved ?? 0} שיחות מ-30 הימים האחרונים`);
      setMore([]);
      setDone(false);
      reload();
      reloadStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "הסנכרון נכשל");
    } finally {
      setSyncing(false);
    }
  }

  const keyBad = status && status.key !== "valid";

  return (
    <Layout
      header={
        <Header
          eyebrow="ניהול ראשי"
          title="הקלטות שיחות"
          meta={status ? `קו המכירות באקסטרה · שיחה אחרונה שהתקבלה ב-webhook: ${stamp(status.lastWebhookAt)} · סנכרון אחרון: ${stamp(status.lastSyncAt)}` : undefined}
          trailing={<Button size="sm" variant="ghost" onClick={syncNow} loading={syncing}>⟳ סנכרן מאקסטרה</Button>}
        />
      }
    >
      <div style={{ display: "grid", gap: "var(--s-4)" }}>
        {keyBad && (
          <div className="card" style={{ padding: "var(--s-3) var(--s-4)", background: "#FEF2F2", color: "#991B1B", fontSize: 13 }}>
            {status.key === "missing"
              ? "החיבור לאקסטרה עוד לא הוגדר: חסר EXTRA_API_KEY בשרת (ראו docs/EXTRA-CALLS-SETUP.md)."
              : status.key === "rejected"
                ? "אקסטרה דחו את מפתח ה-API — צריך ליצור מפתח חדש באזור האישי ולעדכן את EXTRA_API_KEY."
                : "לא ניתן להגיע לאקסטרה כרגע."}
          </div>
        )}
        {status?.lastSyncError && (
          <div className="card" style={{ padding: "var(--s-3) var(--s-4)", background: "#FFF3CF", color: "#8A5A00", fontSize: 13 }}>
            הסנכרון האחרון נכשל: {status.lastSyncError}
          </div>
        )}

        <form onSubmit={search} className="card" style={{ padding: "var(--s-3) var(--s-4)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="חיפוש לפי מספר טלפון" inputMode="tel" dir="ltr" style={{ maxWidth: 220 }} />
          <Button size="sm" type="submit">חפש</Button>
          {query && <Button size="sm" variant="ghost" type="button" onClick={() => { setPhone(""); setMore([]); setDone(false); setQuery(""); }}>נקה</Button>}
          <span className="t-meta" style={{ marginInlineStart: "auto", fontSize: 12 }}>רק מנהלי מערכת רואים את המסך הזה</span>
        </form>

        {loading && <Spinner label="טוען שיחות" />}
        {error && <EmptyState title="שגיאה" meta={error} />}
        {data && calls.length === 0 && (
          <EmptyState title={query ? "אין שיחות עם המספר הזה" : "עוד אין שיחות"} meta={query ? undefined : "שיחות מהקו של גלי יופיעו כאן כמה שניות אחרי שהן מסתיימות."} />
        )}
        {calls.length > 0 && (
          <div className="card" style={{ padding: "var(--s-3)" }}>
            <CallsList calls={calls} />
            {!done && calls.length >= 50 && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 10 }}>
                <Button size="sm" variant="ghost" onClick={loadMore} loading={loadingMore}>טען עוד</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
