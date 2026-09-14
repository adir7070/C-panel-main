import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Campaign, type AggregatedCampaign, type FbTokenStatus,
  getClientCampaigns, toggleCampaignStatus, getClientFbTokenStatus,
} from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../context/ToastContext";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { FeatureUnavailable } from "../ui/FeatureUnavailable";
import { Button } from "../ui/Button";
import { CampaignCard, CampaignDetailPanel } from "../../pages/CampaignsPage";
import { IcoTarget, IcoCoin, IcoTrendUp, IcoUsers } from "../icons/Icons";

interface Props {
  phone: string;
  clientName?: string;
}

/* Per-client Campaigns view — same rich UI as the global CampaignsPage,
   scoped to a single client. Uses CampaignCard + CampaignDetailPanel exports. */

export function CampaignsTab({ phone, clientName }: Props) {
  const toast = useToast();

  const fetcher = useCallback(() => getClientCampaigns(phone), [phone]);
  const { data, loading, error, errorCode, reload } = useApi(fetcher, [fetcher]);

  const [toggling, setToggling] = useState<string | null>(null);
  const [selected, setSelected] = useState<AggregatedCampaign | null>(null);
  const [tokenStatus, setTokenStatus] = useState<FbTokenStatus | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);

  useEffect(() => {
    setTokenLoading(true);
    getClientFbTokenStatus(phone)
      .then(setTokenStatus)
      .catch(() => setTokenStatus(null))
      .finally(() => setTokenLoading(false));
  }, [phone]);

  /* Convert per-client Campaign[] → AggregatedCampaign[] by adding clientPhone+clientName */
  const campaigns: AggregatedCampaign[] = useMemo(() => {
    const list = data?.campaigns ?? [];
    return list.map((c: Campaign) => ({
      ...c,
      clientPhone: phone,
      clientName: clientName || phone,
    }));
  }, [data, phone, clientName]);

  async function handleToggle(c: AggregatedCampaign) {
    const next = c.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setToggling(c.id);
    try {
      await toggleCampaignStatus(phone, c.id, next);
      toast.ok(next === "ACTIVE" ? `הופעל: ${c.name}` : `הושהה: ${c.name}`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setToggling(null);
    }
  }

  /* Derive the display error — backend may return 200 with data.error set */
  const displayError = error ?? (data?.campaigns?.length === 0 && (data as any)?.error ? (data as any).error : null);

  if (loading) return <Spinner label="טוען קמפיינים" />;
  if (errorCode === "fb_unavailable") {
    return <FeatureUnavailable title="קמפיינים לא זמינים" meta="ניהול הקמפיינים דורש חיבור פייסבוק, שכבוי כרגע." />;
  }
  if (displayError) return (
    <div style={{ display: "grid", gap: "var(--s-5)" }}>
      <TokenStatusBadge status={tokenStatus} loading={tokenLoading} />
      <div className="card">
        <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאת פייסבוק</p>
        <p className="t-body" style={{ marginTop: "var(--s-3)", fontFamily: "monospace", fontSize: "var(--t-sm)", wordBreak: "break-all" }}>{displayError}</p>
        <div style={{ marginTop: "var(--s-5)" }}><Button onClick={reload}>נסה שוב</Button></div>
      </div>
    </div>
  );

  const totalSpend  = campaigns.reduce((s, c) => s + (c.spendToday  ?? 0), 0);
  const totalLeads  = campaigns.reduce((s, c) => s + (c.leadsToday  ?? 0), 0);
  const totalBudget = campaigns.reduce((s, c) => s + (c.dailyBudget ?? 0), 0);
  const activeCount = campaigns.filter(c => c.effectiveStatus === "ACTIVE").length;

  return (
    <div style={{ display: "grid", gap: "var(--s-7)" }}>
      <TokenStatusBadge status={tokenStatus} loading={tokenLoading} />
      {/* Snapshot KPIs — flat cards with top-border accent, Monday.com style */}
      <section className="section" style={{ marginTop: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--s-4)" }}>
          <MiniStat label="קמפיינים פעילים" value={activeCount}                                           icon={<IcoTarget size={17} />}  accentColor="var(--blue)"     />
          <MiniStat label="הוצאה היום"       value={`₪${totalSpend.toLocaleString("he-IL")}`}            icon={<IcoCoin size={17} />}    accentColor="#9B59B6"         />
          <MiniStat label="לידים היום"        value={totalLeads}                                          icon={<IcoTrendUp size={17} />} accentColor="var(--positive)" />
          <MiniStat label="תקציב יומי כולל"   value={`₪${(totalBudget / 100).toLocaleString("he-IL")}`}   icon={<IcoUsers size={17} />}   accentColor="#00B5D8"         />
        </div>
      </section>

      {/* Campaign cards grid — full rich preview like CampaignsPage */}
      <section className="section">
        {campaigns.length === 0 ? (
          <EmptyState
            title="אין קמפיינים"
            meta="הלקוח לא מקושר לקמפיינים פעילים, או שעדיין לא הוקצה לו חשבון מודעות."
            action={<Button onClick={reload}>רענן</Button>}
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--s-5)" }}>
            {campaigns.map(c => (
              <CampaignCard
                key={c.id}
                campaign={c}
                toggling={toggling === c.id}
                onToggle={() => handleToggle(c)}
                onClickClient={() => {}}
                onOpenDetail={() => setSelected(c)}
                hideClientLink   /* per-client view — no need to link to self */
              />
            ))}
          </div>
        )}
      </section>

      {/* Detail panel — slide-in with all ads + per-ad management */}
      {selected && (
        <CampaignDetailPanel
          campaign={selected}
          onClose={() => setSelected(null)}
          onNavigateClient={() => {}}
          hideClientLink
        />
      )}
    </div>
  );
}

/* Token status banner — shown at the top of CampaignsTab */
function TokenStatusBadge({ status, loading }: { status: FbTokenStatus | null; loading: boolean }) {
  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "var(--s-3) var(--s-4)", borderRadius: 8, background: "var(--bg-tint)", fontSize: "var(--t-sm)", color: "var(--ink-3)" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ink-4)", display: "inline-block" }} />
      בודק סטטוס טוקן פייסבוק...
    </div>
  );
  if (!status) return null;

  const cfg = {
    valid:   { dot: "var(--positive)", bg: "color-mix(in srgb, var(--positive) 10%, transparent)", label: "טוקן תקין", detail: status.name ? `מחובר כ: ${status.name}` : "" },
    expired: { dot: "var(--negative)", bg: "color-mix(in srgb, var(--negative) 10%, transparent)", label: "טוקן פג תוקף", detail: status.message || "" },
    missing: { dot: "#F59E0B",         bg: "color-mix(in srgb, #F59E0B 10%, transparent)",        label: "אין טוקן", detail: status.message || "הלקוח לא חיבר חשבון פייסבוק" },
  }[status.status];

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "var(--s-3) var(--s-4)", borderRadius: 8, background: cfg.bg, fontSize: "var(--t-sm)" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: cfg.dot, flexShrink: 0, marginTop: 4 }} />
      <div>
        <span style={{ fontWeight: 700, color: "var(--ink)" }}>טוקן פייסבוק: {cfg.label}</span>
        {cfg.detail && <p style={{ margin: "2px 0 0", color: "var(--ink-3)", fontFamily: status.status !== "valid" ? "monospace" : undefined, wordBreak: "break-all" }}>{cfg.detail}</p>}
      </div>
    </div>
  );
}

/* Flat Monday.com KPI card: solid background, top-border color accent, no gradients/glows */
function MiniStat({
  label, value, icon, accentColor,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  accentColor: string;
}) {
  return (
    <div
      className="card"
      style={{
        borderTop: `3px solid ${accentColor}`,
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        padding: "var(--s-4)",
        boxShadow: "var(--sh-1)",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          background: "var(--bg-tint)",
          color: accentColor,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <p style={{
          fontSize: "var(--t-xs)",
          fontWeight: 700,
          color: "var(--ink-3)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}>
          {label}
        </p>
        <p style={{
          fontSize: "var(--t-lg)",
          fontWeight: 800,
          color: "var(--ink)",
          lineHeight: 1,
          marginTop: 3,
          fontFeatureSettings: '"tnum" 1',
        }}>
          {value}
        </p>
      </div>
    </div>
  );
}
