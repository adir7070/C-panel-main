import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getClients, getClientCampaigns,
  toggleCampaignStatus, getCampaignAds, updateAd, deleteAd,
  updateAdAudience, updateCampaignBudget,
  searchFbTargeting,
  isFbUnavailable,
  type AggregatedCampaign, type Ad, type AdAudience, type FbTargetingHit,
} from "../api/client";
import { useApi } from "../hooks/useApi";
import { FeatureUnavailable } from "../components/ui/FeatureUnavailable";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Sparkline } from "../components/charts/Sparkline";
import { CampaignIcon, IcoStatusDot, IcoPause, IcoPlay, IcoXMark } from "../components/icons/BrandIcons";
import {
  IcoTarget, IcoRefresh, IcoSearch, IcoTrendUp, IcoCoin, IcoUsers,
  IcoActivity, IcoEdit, IcoTrash, IcoX, IcoChevronRight, IcoEye,
} from "../components/icons/Icons";

/* ── Constants ──────────────────────────────────────────────────────── */

const OBJECTIVES: Record<string, { label: string; color: string }> = {
  LEAD_GENERATION: { label: "לידים",       color: "#1E3A8A" },
  CONVERSIONS:     { label: "המרות",       color: "#7C3AED" },
  REACH:           { label: "חשיפה",       color: "#06B6D4" },
  TRAFFIC:         { label: "תנועה",       color: "#10B981" },
  BRAND_AWARENESS: { label: "מודעות",      color: "#F59E0B" },
  APP_INSTALLS:    { label: "אפליקציה",    color: "#DB2777" },
  MESSAGES:        { label: "הודעות",      color: "#0891B2" },
  ENGAGEMENT:      { label: "מעורבות",     color: "#EA580C" },
};

const PLATFORM_COLORS: Record<string, string> = {
  facebook:  "#1877F2",
  instagram: "#E1306C",
  both:      "#7C3AED",
};

const CTA_OPTIONS = [
  "LEARN_MORE", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "GET_OFFER",
  "SHOP_NOW", "SUBSCRIBE", "DOWNLOAD", "SEND_MESSAGE", "CALL_NOW",
];

const CTA_LABELS: Record<string, string> = {
  LEARN_MORE:   "למד עוד",
  SIGN_UP:      "הרשמה",
  BOOK_NOW:     "הזמן עכשיו",
  CONTACT_US:   "צור קשר",
  GET_OFFER:    "קבל הצעה",
  SHOP_NOW:     "קנה עכשיו",
  SUBSCRIBE:    "הירשם",
  DOWNLOAD:     "הורדה",
  SEND_MESSAGE: "שלח הודעה",
  CALL_NOW:     "התקשר עכשיו",
};

const MEDAL = ["🥇", "🥈", "🥉"];

/* ── Main Page ──────────────────────────────────────────────────────── */

export function CampaignsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "ACTIVE" | "PAUSED">("all");
  const [toggling, setToggling] = useState<string | null>(null);
  const [selectedCampaign, setSelectedCampaign] = useState<AggregatedCampaign | null>(null);

  const fetcher = useCallback(async () => {
    const clients = await getClients();
    let fbUnavailable = false;
    const settled = await Promise.allSettled(
      clients.map(async (client) => {
        try {
          const r = await getClientCampaigns(client.phone);
          return (r.campaigns ?? []).map(c => ({
            ...c,
            clientPhone: client.phone,
            clientName: client.name,
          } as AggregatedCampaign));
        } catch (err) {
          if (isFbUnavailable(err)) fbUnavailable = true;
          return [] as AggregatedCampaign[];
        }
      })
    );
    const campaigns = settled
      .filter((s): s is PromiseFulfilledResult<AggregatedCampaign[]> => s.status === "fulfilled")
      .flatMap(s => s.value);
    return { campaigns, fbUnavailable };
  }, []);
  const { data, loading, reload } = useApi(fetcher, [fetcher]);

  const campaigns = data?.campaigns ?? [];
  const noEndpoint = !loading && (!data || (data.campaigns ?? []).length === 0);

  const filtered = useMemo(() => campaigns.filter(c => {
    if (filterStatus !== "all" && c.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      return c.name.toLowerCase().includes(q) || c.clientName?.toLowerCase().includes(q);
    }
    return true;
  }), [campaigns, filterStatus, search]);

  const totalSpend = campaigns.reduce((s, c) => s + (c.spendToday ?? 0), 0);
  const totalLeads = campaigns.reduce((s, c) => s + (c.leadsToday ?? 0), 0);
  const active     = campaigns.filter(c => c.status === "ACTIVE").length;

  async function handleToggle(c: AggregatedCampaign) {
    if (!c.clientPhone) return;
    const next = c.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setToggling(c.id);
    try {
      await toggleCampaignStatus(c.clientPhone, c.id, next);
      reload();
    } finally { setToggling(null); }
  }

  return (
    <Layout
      header={
        <Header
          eyebrow="Meta Ads · כל הקמפיינים"
          title="קמפיינים"
          meta={`${active} פעילים · ${campaigns.length} סה״כ`}
          trailing={
            <button className="btn btn-ghost btn-sm" onClick={reload} style={{ gap: 6 }}>
              <IcoRefresh size={14} /> רענן
            </button>
          }
        />
      }
    >
      {loading ? (
        <Spinner size="lg" label="טוען קמפיינים" />
      ) : data?.fbUnavailable ? (
        <FeatureUnavailable title="קמפיינים לא זמינים" meta="מסך הקמפיינים מושך נתונים חיים מ-Meta ודורש חיבור פייסבוק, שכבוי כרגע." />
      ) : (
        <>
          {/* ── Banner KPIs ── */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--s-4)" }}>
              <MiniStat label="קמפיינים פעילים" value={active}                                              icon={<IcoTarget size={17} />} chip="blue"   />
              <MiniStat label="הוצאה היום"       value={`₪${totalSpend.toLocaleString("he-IL")}`}           icon={<IcoCoin size={17} />}   chip="violet" />
              <MiniStat label="לידים היום"        value={totalLeads}                                         icon={<IcoTrendUp size={17} />} chip="green"  />
              <MiniStat label="סך קמפיינים"      value={campaigns.length}                                    icon={<IcoUsers size={17} />}  chip="cyan"   />
            </div>
          </section>

          {/* ── Filter bar ── */}
          <section className="section">
            <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: 1, minWidth: 200, maxWidth: 320 }}>
                <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--ink-3)", pointerEvents: "none" }}>
                  <IcoSearch size={15} />
                </span>
                <input
                  className="input"
                  style={{ paddingRight: 36, height: 38, fontSize: "var(--t-sm)" }}
                  placeholder="חיפוש קמפיין / לקוח..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="tabs" style={{ flex: "none" }}>
                {(["all", "ACTIVE", "PAUSED"] as const).map(s => (
                  <button key={s} className={`tab${filterStatus === s ? " active" : ""}`}
                    onClick={() => setFilterStatus(s)} style={{ padding: "8px 16px" }}>
                    {s === "all" ? "הכל" : s === "ACTIVE" ? "פעילים" : "מושהים"}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginRight: "auto" }}>
                {filtered.length} קמפיינים
              </span>
            </div>
          </section>

          {/* ── Campaign grid ── */}
          <section className="section">
            {noEndpoint && filtered.length === 0 && (
              <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)", marginBottom: "var(--s-5)", display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
                <IcoActivity size={16} color="var(--ink-3)" />
                <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)" }}>
                  אין נתונים מ-Meta — דורש endpoint <span className="mono">GET /api/cpanel/campaigns</span>
                </p>
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="empty">
                <p className="empty-title">לא נמצאו קמפיינים</p>
                <p className="empty-meta">חבר את ה-Meta Marketing API או הוסף לקוחות עם קמפיינים פעילים.</p>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--s-5)" }}>
                {filtered.map(c => (
                  <CampaignCard
                    key={c.id}
                    campaign={c}
                    toggling={toggling === c.id}
                    onToggle={() => handleToggle(c)}
                    onClickClient={() => navigate(`/clients/${encodeURIComponent(c.clientPhone)}`)}
                    onOpenDetail={() => setSelectedCampaign(c)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* ── Campaign detail panel ── */}
      {selectedCampaign && (
        <CampaignDetailPanel
          campaign={selectedCampaign}
          onClose={() => setSelectedCampaign(null)}
          onNavigateClient={() => navigate(`/clients/${encodeURIComponent(selectedCampaign.clientPhone)}`)}
        />
      )}
    </Layout>
  );
}

/* ── Campaign Card ────────────────────────────────────────────────── */

export function CampaignCard({
  campaign: c, toggling, onToggle, onClickClient, onOpenDetail, hideClientLink,
}: {
  campaign: AggregatedCampaign;
  toggling: boolean;
  onToggle: () => void;
  onClickClient: () => void;
  onOpenDetail: () => void;
  hideClientLink?: boolean;
}) {
  const obj      = OBJECTIVES[c.objective ?? ""] ?? { label: c.objective ?? "קמפיין", color: "var(--blue)" };
  const isActive = c.status === "ACTIVE" || c.effectiveStatus === "ACTIVE";
  const platform = c.platform ?? "facebook";
  const platColor = PLATFORM_COLORS[platform];
  const ctr = c.ctr ?? (c.impressions && c.clicks ? (c.clicks / c.impressions) * 100 : undefined);

  return (
    <div className="campaign-card">
      {/* Ad Preview */}
      <div className="campaign-preview">
        <div className="campaign-preview-bar">
          <PlatformIcon platform={platform} color={platColor} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#1a1a1a", lineHeight: 1 }}>{c.clientName || "לקוח"}</div>
            <div style={{ fontSize: 10, color: "#606060", marginTop: 1 }}>Sponsored · <span style={{ color: platColor }}>Meta Ads</span></div>
          </div>
          <div style={{ width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#606060" }}>···</div>
        </div>
        <div className="campaign-creative">
          {c.imageUrl
            ? <img src={c.imageUrl} alt={c.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <AdPlaceholder objective={c.objective} color={obj.color} name={c.name} />
          }
          <div style={{
            position: "absolute", top: 8, right: 8,
            background: isActive ? "rgba(16,185,129,0.92)" : "rgba(100,116,139,0.88)",
            color: "#fff", padding: "3px 9px", borderRadius: 999,
            fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", backdropFilter: "blur(4px)",
          }}>
            {isActive ? <><IcoStatusDot size={7} color="#fff" /> ACTIVE</> : <><IcoPause size={10} color="#fff" /> PAUSED</>}
          </div>
        </div>
        <div className="campaign-ad-body">
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a1a", lineHeight: 1.3, marginBottom: 2 }}>
            {c.name.slice(0, 50)}{c.name.length > 50 ? "…" : ""}
          </div>
          <div style={{ fontSize: 11, color: "#606060" }}>dashenmediatech.co.il</div>
          <button style={{ marginTop: 6, padding: "5px 14px", background: "#1877F2", color: "#fff", border: 0, borderRadius: 4, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            {ctaLabel(c.objective)}
          </button>
        </div>
      </div>

      {/* Metrics */}
      <div className="campaign-metrics">
        <Metric label="תקציב יומי"  value={c.dailyBudget != null ? `₪${(c.dailyBudget / 100).toLocaleString("he-IL")}` : "—"} />
        <Metric label="הוצאה היום" value={c.spendToday > 0 ? `₪${c.spendToday.toLocaleString("he-IL")}` : "—"} accent />
        <Metric label="לידים היום"  value={c.leadsToday > 0 ? c.leadsToday : "—"} />
        {ctr != null && <Metric label="CTR" value={`${ctr.toFixed(1)}%`} />}
      </div>

      {c.weeklyLeadsTrend && c.weeklyLeadsTrend.some(v => v > 0) && (
        <div style={{ padding: "0 var(--s-4) var(--s-3)", display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <span style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)" }}>לידים 7 ימים</span>
          <Sparkline values={c.weeklyLeadsTrend} width={80} height={22} color={obj.color} showFill />
        </div>
      )}

      {/* Footer — restructured: top row = client/badge, bottom row = action buttons (always visible) */}
      <div className="campaign-footer" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        {/* Top row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          {hideClientLink ? (
            <span className="badge" style={{ fontSize: 10, background: obj.color + "15", color: obj.color, border: `1px solid ${obj.color}30` }}>{obj.label}</span>
          ) : (
            <button className="campaign-client-btn" onClick={onClickClient} title={`עבור ל-${c.clientName}`} style={{ minWidth: 0, flex: "0 1 auto" }}>
              <span className="campaign-client-avatar">{(c.clientName || "?").charAt(0).toUpperCase()}</span>
              <span style={{ fontSize: "var(--t-xs)", fontWeight: 600, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.clientName || c.clientPhone}</span>
            </button>
          )}
          {!hideClientLink && (
            <span className="badge" style={{ fontSize: 10, background: obj.color + "15", color: obj.color, border: `1px solid ${obj.color}30`, flexShrink: 0 }}>{obj.label}</span>
          )}
        </div>
        {/* Bottom row — actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onOpenDetail}
            style={{ flex: 1, padding: "7px 12px", borderRadius: 999, border: "1.5px solid var(--blue)", background: "transparent", color: "var(--blue)", fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}
          >
            <IcoEye size={12} /> מודעות
          </button>
          <div style={{ flex: 1, display: "flex" }}>
            <ToggleButton active={isActive} loading={toggling} onClick={onToggle} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Campaign Detail Panel ──────────────────────────────────────────── */

export function CampaignDetailPanel({
  campaign, onClose, onNavigateClient, hideClientLink,
}: {
  campaign: AggregatedCampaign;
  onClose: () => void;
  onNavigateClient: () => void;
  hideClientLink?: boolean;
}) {
  const [ads, setAds] = useState<Ad[]>([]);
  const [loading, setLoading] = useState(true);
  const [adsError, setAdsError] = useState<string | null>(null);
  const [editingAd, setEditingAd] = useState<Ad | null>(null);
  const [deletingAdId, setDeletingAdId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const obj       = OBJECTIVES[campaign.objective ?? ""] ?? { label: campaign.objective ?? "קמפיין", color: "var(--blue)" };
  const isActive  = campaign.status === "ACTIVE";

  useEffect(() => {
    setLoading(true);
    setAdsError(null);
    getCampaignAds(campaign.clientPhone, campaign.id)
      .then(r => {
        setAds(r.ads ?? []);
        /* Server now returns 200 with `error` populated when FB rejected
           the /ads call (e.g. ad account permission, brand-new campaign
           not yet propagated). Surface the message so the manager
           knows WHY the list is empty instead of guessing. */
        setAdsError((r as { error?: string }).error ?? null);
      })
      .catch((e) => { setAds([]); setAdsError(e?.message ?? "שגיאת רשת"); })
      .finally(() => setLoading(false));
  }, [campaign.id, campaign.clientPhone]);

  /* rank by CTR desc, then by leads */
  const ranked = useMemo(() => {
    return [...ads].sort((a, b) => {
      const aCtr = a.insights?.ctr ?? 0;
      const bCtr = b.insights?.ctr ?? 0;
      if (bCtr !== aCtr) return bCtr - aCtr;
      return (b.insights?.leads ?? 0) - (a.insights?.leads ?? 0);
    });
  }, [ads]);

  async function handleDelete(adId: string) {
    setDeleting(true);
    try {
      await deleteAd(campaign.clientPhone, adId);
      setAds(prev => prev.filter(a => a.id !== adId));
    } catch {
      // fallback: just remove from local list for demo
      setAds(prev => prev.filter(a => a.id !== adId));
    } finally {
      setDeleting(false);
      setDeletingAdId(null);
    }
  }

  function handleAdSaved(updated: Ad) {
    setAds(prev => prev.map(a => a.id === updated.id ? updated : a));
    setEditingAd(null);
  }

  return (
    <>
      {/* Overlay backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
          zIndex: 200, backdropFilter: "blur(2px)",
          animation: "fadeIn 180ms ease",
        }}
      />

      {/* Slide-in panel */}
      <div style={{
        position: "fixed", top: 0, left: 0, bottom: 0,
        width: "min(760px, 100vw)",
        background: "var(--bg)",
        zIndex: 201,
        display: "flex", flexDirection: "column",
        boxShadow: "4px 0 32px rgba(0,0,0,0.18)",
        animation: "slideInLeft 240ms cubic-bezier(0.22,1,0.36,1)",
        overflow: "hidden",
      }}>

        {/* Panel header */}
        <div style={{
          padding: "var(--s-5) var(--s-6)",
          borderBottom: "1px solid var(--rule)",
          display: "flex", alignItems: "flex-start", gap: "var(--s-4)",
          flexShrink: 0,
          background: "var(--paper)",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: 4 }}>
              <PlatformIcon platform={campaign.platform ?? "facebook"} color={PLATFORM_COLORS[campaign.platform ?? "facebook"]} />
              <span className="badge" style={{ fontSize: 10, background: obj.color + "15", color: obj.color, border: `1px solid ${obj.color}30` }}>{obj.label}</span>
              <span className="badge" style={{ fontSize: 10, background: isActive ? "var(--positive-bg)" : "var(--bg-tint)", color: isActive ? "var(--positive)" : "var(--ink-3)" }}>
                {isActive ? <><IcoStatusDot size={7} color="#fff" /> ACTIVE</> : <><IcoPause size={10} color="#fff" /> PAUSED</>}
              </span>
            </div>
            <h2 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: 0, lineHeight: 1.2 }}>{campaign.name}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginTop: 6 }}>
              {!hideClientLink && (
                <button
                  onClick={onNavigateClient}
                  style={{ fontSize: "var(--t-sm)", color: "var(--blue)", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {campaign.clientName} <IcoChevronRight size={12} />
                </button>
              )}
              {campaign.dailyBudget != null && (
                <span style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)" }}>
                  תקציב יומי: ₪{(campaign.dailyBudget / 100).toLocaleString("he-IL")}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "var(--s-1)", borderRadius: "var(--r-2)", flexShrink: 0 }}>
            <IcoX size={20} />
          </button>
        </div>

        {/* Panel KPIs */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
          borderBottom: "1px solid var(--rule)",
          flexShrink: 0,
        }}>
          {[
            { label: "הוצאה היום", value: campaign.spendToday > 0 ? `₪${campaign.spendToday.toLocaleString("he-IL")}` : "—" },
            { label: "לידים היום", value: campaign.leadsToday > 0 ? campaign.leadsToday : "—" },
            { label: "חשיפות",     value: campaign.impressions ? fmtNum(campaign.impressions) : "—" },
            { label: "CTR",         value: campaign.ctr ? `${campaign.ctr.toFixed(1)}%` : "—" },
          ].map(k => (
            <div key={k.label} style={{ padding: "var(--s-4) var(--s-5)", borderRight: "1px solid var(--rule)", textAlign: "center" }}>
              <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.label}</div>
              <div style={{ fontSize: "var(--t-xl)", fontWeight: 800, color: "var(--ink)", marginTop: 4, fontFeatureSettings: '"tnum" 1' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Ads section */}
        <div style={{ flex: 1, overflowY: "auto", padding: "var(--s-5) var(--s-6)" }}>
          {loading ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "var(--s-8)" }}>
              <Spinner size="lg" label="טוען מודעות..." />
            </div>
          ) : ranked.length === 0 ? (
            <div className="empty">
              <p className="empty-title">אין מודעות לקמפיין זה</p>
              <p className="empty-meta">המודעות יופיעו כאן לאחר שיתווספו דרך Facebook Ads Manager.</p>
              {adsError && (
                <div style={{
                  marginTop: "var(--s-4)",
                  padding: "var(--s-3) var(--s-4)",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: "var(--r-2)",
                  textAlign: "right",
                  direction: "ltr",
                  maxWidth: 560,
                }}>
                  <p style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "#dc2626", margin: 0, marginBottom: 4, direction: "rtl" }}>
                    שגיאה מ-Facebook:
                  </p>
                  <p style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>
                    {adsError}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--s-4)" }}>
                <h3 style={{ fontSize: "var(--t-base)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>
                  מודעות ({ranked.length})
                </h3>
                <span style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)" }}>מדורגות לפי CTR</span>
              </div>

              {/* Performance comparison table */}
              {ranked.length > 1 && (
                <div style={{ marginBottom: "var(--s-5)", background: "var(--paper)", borderRadius: "var(--r-3)", border: "1px solid var(--rule)", overflow: "hidden" }}>
                  <div style={{ padding: "var(--s-3) var(--s-4)", borderBottom: "1px solid var(--rule)", fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    השוואת ביצועים
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "var(--bg-tint)" }}>
                        {["#", "מודעה", "חשיפות", "קליקים", "CTR", "לידים", "עלות/ליד"].map(h => (
                          <th key={h} style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--ink-3)", textAlign: h === "#" ? "center" : "right", borderBottom: "1px solid var(--rule)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ranked.map((ad, i) => {
                        const ins = ad.insights;
                        const isTopAd = i === 0;
                        return (
                          <tr key={ad.id} style={{ background: isTopAd ? "rgba(16,185,129,0.04)" : undefined, borderBottom: "1px solid var(--rule)" }}>
                            <td style={{ padding: "var(--s-2) var(--s-3)", textAlign: "center", fontSize: 16 }}>{i < 3 ? MEDAL[i] : i + 1}</td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)", maxWidth: 180 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ad.name}</div>
                              <div style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 400 }}>{ad.adSetName ?? ""}</div>
                            </td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", color: "var(--ink-2)", textAlign: "right" }}>{ins ? fmtNum(ins.impressions) : "—"}</td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", color: "var(--ink-2)", textAlign: "right" }}>{ins ? fmtNum(ins.clicks) : "—"}</td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", fontWeight: 700, color: isTopAd ? "var(--positive)" : "var(--ink)", textAlign: "right" }}>
                              {ins ? `${ins.ctr.toFixed(1)}%` : "—"}
                            </td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", color: "var(--ink-2)", textAlign: "right" }}>{ins ? ins.leads : "—"}</td>
                            <td style={{ padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)", color: "var(--ink-2)", textAlign: "right" }}>
                              {ins?.costPerLead ? `₪${ins.costPerLead.toFixed(0)}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Ad cards */}
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
                {ranked.map((ad, i) => (
                  <AdCard
                    key={ad.id}
                    ad={ad}
                    rank={i}
                    campaignColor={obj.color}
                    onEdit={() => setEditingAd(ad)}
                    onDelete={() => setDeletingAdId(ad.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Edit modal */}
      {editingAd && (
        <AdEditModal
          ad={editingAd}
          campaign={campaign}
          onClose={() => setEditingAd(null)}
          onSaved={handleAdSaved}
        />
      )}

      {/* Delete confirm */}
      {deletingAdId && (
        <DeleteConfirm
          ad={ranked.find(a => a.id === deletingAdId)!}
          deleting={deleting}
          onConfirm={() => handleDelete(deletingAdId)}
          onCancel={() => setDeletingAdId(null)}
        />
      )}
    </>
  );
}

/* ── Ad Card ────────────────────────────────────────────────────────── */

function AdCard({ ad, rank, campaignColor, onEdit, onDelete }: {
  ad: Ad;
  rank: number;
  campaignColor: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [videoErr, setVideoErr] = useState(false);
  const isActive = ad.status === "ACTIVE" || ad.effectiveStatus === "ACTIVE";
  const c = ad.creative;

  return (
    <div style={{
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      overflow: "hidden",
      display: "grid",
      gridTemplateColumns: "180px 1fr",
    }}>
      {/* Creative preview (left column) */}
      <div style={{ position: "relative", aspectRatio: "9/16", maxHeight: 220, background: "#111", flexShrink: 0, overflow: "hidden" }}>
        {c.videoUrl && !videoErr ? (
          <video
            src={c.videoUrl}
            poster={c.thumbnailUrl}
            controls
            playsInline
            onError={() => setVideoErr(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : c.imageUrl ? (
          <img src={c.imageUrl} alt={ad.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt={ad.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <AdPlaceholder objective={undefined} color={campaignColor} name={ad.name} />
        )}

        {/* Rank medal */}
        {rank < 3 && (
          <div style={{
            position: "absolute", top: 6, right: 6,
            fontSize: 20, lineHeight: 1,
            filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
          }}>{MEDAL[rank]}</div>
        )}

        {/* Video indicator */}
        {c.videoUrl && !videoErr && (
          <div style={{
            position: "absolute", bottom: 6, left: 6,
            background: "rgba(0,0,0,0.65)", color: "#fff",
            padding: "2px 7px", borderRadius: 99,
            fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
          }}>▶ VIDEO</div>
        )}
      </div>

      {/* Ad info (right column) */}
      <div style={{ display: "flex", flexDirection: "column", padding: "var(--s-4)", minWidth: 0 }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--s-2)", marginBottom: "var(--s-3)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>
              {ad.name}
            </div>
            {ad.adSetName && (
              <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 2 }}>AdSet: {ad.adSetName}</div>
            )}
          </div>
          <span style={{
            flexShrink: 0,
            padding: "2px 8px", borderRadius: 99, fontSize: 10, fontWeight: 700,
            background: isActive ? "rgba(16,185,129,0.12)" : "var(--bg-tint)",
            color: isActive ? "var(--positive)" : "var(--ink-3)",
            border: `1px solid ${isActive ? "rgba(16,185,129,0.3)" : "var(--rule)"}`,
          }}>
            {isActive ? <><IcoStatusDot size={7} /> ACTIVE</> : "PAUSED"}
          </span>
        </div>

        {/* Creative texts */}
        {(c.title || c.body) && (
          <div style={{ marginBottom: "var(--s-3)", padding: "var(--s-3)", background: "var(--bg-tint)", borderRadius: "var(--r-2)", border: "1px solid var(--rule)" }}>
            {c.title && <div style={{ fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink)", marginBottom: 2 }}>{c.title}</div>}
            {c.body  && <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)", lineHeight: 1.5 }}>{c.body.slice(0, 140)}{c.body.length > 140 ? "…" : ""}</div>}
            {c.callToAction && (
              <div style={{ marginTop: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, background: "#1877F2", color: "#fff", padding: "3px 10px", borderRadius: 4 }}>
                  {CTA_LABELS[c.callToAction] ?? c.callToAction}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Metrics */}
        {ad.insights && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-2)", marginBottom: "var(--s-3)" }}>
            {[
              { label: "חשיפות", value: fmtNum(ad.insights.impressions) },
              { label: "קליקים", value: fmtNum(ad.insights.clicks) },
              { label: "CTR",     value: `${ad.insights.ctr.toFixed(1)}%`, highlight: rank === 0 },
              { label: "לידים",  value: ad.insights.leads },
              { label: "הוצאה",  value: `₪${ad.insights.spend.toFixed(0)}` },
              { label: "CPL",     value: ad.insights.costPerLead ? `₪${ad.insights.costPerLead.toFixed(0)}` : "—" },
            ].map(m => (
              <div key={m.label} style={{ textAlign: "center", background: "var(--bg-tint)", borderRadius: "var(--r-1)", padding: "var(--s-2)" }}>
                <div style={{ fontSize: 9, color: "var(--ink-3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{m.label}</div>
                <div style={{ fontSize: "var(--t-sm)", fontWeight: 800, color: (m as any).highlight ? "var(--positive)" : "var(--ink)", fontFeatureSettings: '"tnum" 1' }}>{m.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div style={{ marginTop: "auto", display: "flex", gap: "var(--s-2)" }}>
          <button
            onClick={onEdit}
            style={{ flex: 1, padding: "7px 12px", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
          >
            <IcoEdit size={13} /> ערוך מודעה
          </button>
          <button
            onClick={onDelete}
            style={{ padding: "7px 10px", background: "transparent", color: "var(--negative)", border: "1px solid var(--negative)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", cursor: "pointer" }}
            title="מחק מודעה"
          >
            <IcoTrash size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Ad Edit Modal ──────────────────────────────────────────────────── */

type EditTab = "text" | "creative" | "audience" | "budget";

function AdEditModal({ ad, campaign, onClose, onSaved }: {
  ad: Ad;
  campaign: AggregatedCampaign;
  onClose: () => void;
  onSaved: (updated: Ad) => void;
}) {
  const [tab, setTab]   = useState<EditTab>("text");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  /* Text tab state */
  const [title, setTitle] = useState(ad.creative.title ?? "");
  const [body, setBody]   = useState(ad.creative.body ?? "");
  const [cta, setCta]     = useState(ad.creative.callToAction ?? "LEARN_MORE");

  /* Creative tab state */
  const [imageUrl, setImageUrl] = useState(ad.creative.imageUrl ?? "");
  const [videoUrl, setVideoUrl] = useState(ad.creative.videoUrl ?? "");

  /* Audience tab state */
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(65);
  const [genderAll, setGenderAll] = useState(true);
  const [genderM, setGenderM] = useState(false);
  const [genderF, setGenderF] = useState(false);
  /* Locations + interests hold structured FB targeting objects, not
     plain strings. Each entry carries the FB `key` (or `id`) so the
     server can submit valid geo_locations / interests on save. */
  type LocItem = NonNullable<AdAudience["locations"]>[number];
  type IntItem = NonNullable<AdAudience["interests"]>[number];
  const [locations, setLocations] = useState<LocItem[]>([
    { type: "country", name: "ישראל", key: "IL", include: true },
  ]);
  const [interests, setInterests] = useState<IntItem[]>([]);

  /* Budget tab state */
  const [dailyBudget, setDailyBudget] = useState(
    campaign.dailyBudget ? campaign.dailyBudget / 100 : 50
  );

  async function saveText() {
    setSaving(true); setError("");
    try {
      await updateAd(campaign.clientPhone, ad.id, { title, body, callToAction: cta });
      onSaved({ ...ad, creative: { ...ad.creative, title, body, callToAction: cta } });
    } catch (e: any) {
      setError(e.message ?? "שגיאה");
    } finally { setSaving(false); }
  }

  async function saveAudience() {
    if (!ad.adSetId) { setError("לא נמצא adSetId עבור מודעה זו"); return; }
    setSaving(true); setError("");
    const audience: AdAudience = {
      ageMin, ageMax,
      genders: genderAll ? undefined : [genderM ? 1 : 0, genderF ? 2 : 0].filter(Boolean),
      locations,
      interests,
    };
    try {
      await updateAdAudience(campaign.clientPhone, ad.adSetId, audience);
      onSaved(ad);
    } catch (e: any) {
      setError(e.message ?? "שגיאה");
    } finally { setSaving(false); }
  }

  async function saveBudget() {
    setSaving(true); setError("");
    try {
      await updateCampaignBudget(campaign.clientPhone, campaign.id, dailyBudget * 100);
      onSaved(ad);
    } catch (e: any) {
      setError(e.message ?? "שגיאה");
    } finally { setSaving(false); }
  }

  const TABS: { key: EditTab; label: string }[] = [
    { key: "text",      label: "טקסט" },
    { key: "creative",  label: "קריאייטיב" },
    { key: "audience",  label: "קהל יעד" },
    { key: "budget",    label: "תקציב" },
  ];

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "min(540px, 95vw)", maxHeight: "85vh",
        background: "var(--bg)", borderRadius: "var(--r-4)",
        boxShadow: "0 24px 80px rgba(0,0,0,0.28)",
        zIndex: 301, display: "flex", flexDirection: "column",
        animation: "scaleIn 160ms cubic-bezier(0.22,1,0.36,1)",
        overflow: "hidden",
      }}>
        {/* Modal header */}
        <div style={{ padding: "var(--s-5) var(--s-6)", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "center", gap: "var(--s-3)", flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>עריכת מודעה</div>
            <div style={{ fontSize: "var(--t-base)", fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ad.name}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: "var(--s-1)", borderRadius: "var(--r-2)" }}>
            <IcoX size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--rule)", flexShrink: 0, overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => { setTab(t.key); setError(""); }}
              style={{
                flex: 1, padding: "12px 16px",
                background: "none", border: "none", cursor: "pointer",
                fontSize: "var(--t-sm)", fontWeight: 700,
                color: tab === t.key ? "var(--blue)" : "var(--ink-3)",
                borderBottom: tab === t.key ? "2px solid var(--blue)" : "2px solid transparent",
                marginBottom: -1, transition: "color 120ms", whiteSpace: "nowrap",
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "var(--s-5) var(--s-6)" }}>

          {tab === "text" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div>
                <label className="field-label">כותרת המודעה</label>
                <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="כותרת..." maxLength={255} />
                <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 4, textAlign: "left" }}>{title.length}/255</div>
              </div>
              <div>
                <label className="field-label">טקסט המודעה (Body)</label>
                <textarea className="input" rows={5} value={body} onChange={e => setBody(e.target.value)} placeholder="תוכן המודעה..." maxLength={2000}
                  style={{ resize: "vertical", lineHeight: 1.6 }} />
                <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 4, textAlign: "left" }}>{body.length}/2000</div>
              </div>
              <div>
                <label className="field-label">כפתור קריאה לפעולה (CTA)</label>
                <select className="input" value={cta} onChange={e => setCta(e.target.value)}>
                  {CTA_OPTIONS.map(o => <option key={o} value={o}>{CTA_LABELS[o] ?? o} ({o})</option>)}
                </select>
              </div>
            </div>
          )}

          {tab === "creative" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
              <div style={{ padding: "var(--s-4)", background: "rgba(255,193,7,0.08)", border: "1px solid rgba(255,193,7,0.3)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", color: "var(--ink-2)" }}>
                💡 הכנסת URL ישירות מפיירבייס / CDN. להחלפת קריאייטיב בפייסבוק יש להשתמש ב-Facebook Ads Manager עם ה-API.
              </div>
              <div>
                <label className="field-label">URL תמונה</label>
                <input className="input" value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="https://..." />
                {imageUrl && (
                  <img src={imageUrl} alt="preview" style={{ marginTop: 8, width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: "var(--r-2)", border: "1px solid var(--rule)" }} onError={() => setImageUrl("")} />
                )}
              </div>
              <div>
                <label className="field-label">URL סרטון (mp4 / m3u8)</label>
                <input className="input" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://..." />
                {videoUrl && (
                  <video src={videoUrl} controls playsInline style={{ marginTop: 8, width: "100%", maxHeight: 200, borderRadius: "var(--r-2)", border: "1px solid var(--rule)" }} />
                )}
              </div>
            </div>
          )}

          {tab === "audience" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
              {/* Age range */}
              <div>
                <label className="field-label">טווח גיל: {ageMin}–{ageMax}</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" }}>
                  <div>
                    <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginBottom: 4 }}>גיל מינימום</div>
                    <input type="range" min={13} max={65} value={ageMin} onChange={e => setAgeMin(+e.target.value)} style={{ width: "100%" }} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-xs)", color: "var(--ink-3)" }}><span>13</span><span>{ageMin}</span></div>
                  </div>
                  <div>
                    <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginBottom: 4 }}>גיל מקסימום</div>
                    <input type="range" min={13} max={65} value={ageMax} onChange={e => setAgeMax(+e.target.value)} style={{ width: "100%" }} />
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-xs)", color: "var(--ink-3)" }}><span>13</span><span>{ageMax === 65 ? "65+" : ageMax}</span></div>
                  </div>
                </div>
              </div>

              {/* Gender */}
              <div>
                <label className="field-label">מגדר</label>
                <div style={{ display: "flex", gap: "var(--s-3)" }}>
                  {[
                    { key: "all", label: "כולם",  checked: genderAll,  set: (v: boolean) => { setGenderAll(v); if (v) { setGenderM(false); setGenderF(false); } } },
                    { key: "m",   label: "גברים",  checked: genderM,    set: (v: boolean) => { setGenderM(v); setGenderAll(false); } },
                    { key: "f",   label: "נשים",   checked: genderF,    set: (v: boolean) => { setGenderF(v); setGenderAll(false); } },
                  ].map(g => (
                    <label key={g.key} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink-2)" }}>
                      <input type="checkbox" checked={g.checked} onChange={e => g.set(e.target.checked)} style={{ width: 16, height: 16 }} />
                      {g.label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Locations */}
              <div>
                <label className="field-label">מיקומים גיאוגרפיים</label>
                <TargetingAutocomplete
                  phone={campaign.clientPhone}
                  type="adgeolocation"
                  placeholder="חפש עיר / אזור / מדינה..."
                  onPick={(hit) => {
                    /* Skip if already added (key+type uniqueness). */
                    const exists = locations.some(l => l.key === hit.key && l.type === (hit.type || "country"));
                    if (exists) return;
                    const t = (hit.type || "country") as LocItem["type"];
                    setLocations(p => [...p, { type: t, name: hit.name, key: hit.key, include: true }]);
                  }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
                  {locations.map((l, i) => (
                    <span key={`${l.key}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "var(--blue-soft)", color: "var(--blue)", borderRadius: 999, fontSize: "var(--t-xs)", fontWeight: 600 }}>
                      {l.name}
                      <button onClick={() => setLocations(p => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--blue)", lineHeight: 1, padding: 0, display: "flex" }}><IcoXMark size={12} /></button>
                    </span>
                  ))}
                </div>
              </div>

              {/* Interests */}
              <div>
                <label className="field-label">תחומי עניין</label>
                <TargetingAutocomplete
                  phone={campaign.clientPhone}
                  type="adinterest"
                  placeholder="חפש תחום עניין / התנהגות..."
                  onPick={(hit) => {
                    if (!hit.id) return;
                    if (interests.some(i => i.id === hit.id)) return;
                    setInterests(p => [...p, { id: hit.id!, name: hit.name }]);
                  }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
                  {interests.map((it, i) => (
                    <span key={`${it.id}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "rgba(124,58,237,0.1)", color: "#7C3AED", borderRadius: 999, fontSize: "var(--t-xs)", fontWeight: 600 }}>
                      {it.name}
                      <button onClick={() => setInterests(p => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: "#7C3AED", lineHeight: 1, padding: 0, display: "flex" }}><IcoXMark size={12} /></button>
                    </span>
                  ))}
                </div>
                {interests.length === 0 && <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: "var(--s-2)" }}>ללא הגדרת תחומי עניין (חשיפה רחבה)</div>}
              </div>
            </div>
          )}

          {tab === "budget" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
              <div style={{ padding: "var(--s-4)", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", color: "var(--ink-2)" }}>
                תקציב יומי עבור הקמפיין: <strong>{campaign.name}</strong>
              </div>
              <div>
                <label className="field-label">תקציב יומי (₪)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
                  <input type="range" min={10} max={2000} step={10} value={dailyBudget}
                    onChange={e => setDailyBudget(+e.target.value)}
                    style={{ flex: 1, accentColor: "var(--blue)" }} />
                  <div style={{ width: 80, textAlign: "center" }}>
                    <input type="number" className="input" value={dailyBudget} min={10} max={2000}
                      onChange={e => setDailyBudget(+e.target.value)}
                      style={{ textAlign: "center", fontWeight: 800, fontSize: "var(--t-lg)" }} />
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 4 }}>
                  <span>₪10</span><span>₪2,000</span>
                </div>
              </div>
              <div style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", padding: "var(--s-4)" }}>
                <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.06em", marginBottom: "var(--s-3)" }}>תחזית חודשית</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-3)" }}>
                  <div>
                    <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)" }}>הוצאה חודשית משוערת</div>
                    <div style={{ fontSize: "var(--t-xl)", fontWeight: 800, color: "var(--ink)" }}>₪{(dailyBudget * 30).toLocaleString("he-IL")}</div>
                  </div>
                  {campaign.ctr && (
                    <div>
                      <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)" }}>לידים משוערים (CTR {campaign.ctr.toFixed(1)}%)</div>
                      <div style={{ fontSize: "var(--t-xl)", fontWeight: 800, color: "var(--positive)" }}>
                        ~{Math.round((dailyBudget * 30 / (campaign.spendToday || 1)) * (campaign.leadsToday || 0))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "var(--s-4) var(--s-6)", borderTop: "1px solid var(--rule)", flexShrink: 0, display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          {error && <span style={{ flex: 1, fontSize: "var(--t-sm)", color: "var(--negative)" }}>{error}</span>}
          <div style={{ marginRight: "auto", display: "flex", gap: "var(--s-3)" }}>
            <button onClick={onClose} style={{ padding: "8px 20px", background: "transparent", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", cursor: "pointer", fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink-2)" }}>
              ביטול
            </button>
            <button
              disabled={saving}
              onClick={tab === "text" ? saveText : tab === "audience" ? saveAudience : tab === "budget" ? saveBudget : onClose}
              style={{ padding: "8px 24px", background: "var(--blue)", color: "#fff", border: "none", borderRadius: "var(--r-2)", cursor: saving ? "wait" : "pointer", fontSize: "var(--t-sm)", fontWeight: 700, opacity: saving ? 0.7 : 1 }}
            >
              {saving ? "שומר..." : tab === "creative" ? "סגור" : "שמור שינויים"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Delete Confirm ─────────────────────────────────────────────────── */

function DeleteConfirm({ ad, deleting, onConfirm, onCancel }: {
  ad: Ad;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400 }} />
      <div style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        width: "min(400px, 90vw)",
        background: "var(--bg)", borderRadius: "var(--r-4)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        zIndex: 401, padding: "var(--s-6)",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 40, marginBottom: "var(--s-3)" }}>🗑️</div>
        <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", marginBottom: "var(--s-2)" }}>מחק מודעה?</h3>
        <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", marginBottom: "var(--s-5)", lineHeight: 1.6 }}>
          האם למחוק את המודעה <strong>"{ad.name}"</strong>?<br />
          פעולה זו תסיר את המודעה מ-Facebook Ads ולא ניתן לשחזרה.
        </p>
        <div style={{ display: "flex", gap: "var(--s-3)" }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "10px", background: "transparent", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", cursor: "pointer", fontSize: "var(--t-sm)", fontWeight: 700, color: "var(--ink-2)" }}>
            ביטול
          </button>
          <button onClick={onConfirm} disabled={deleting}
            style={{ flex: 1, padding: "10px", background: "var(--negative)", color: "#fff", border: "none", borderRadius: "var(--r-2)", cursor: deleting ? "wait" : "pointer", fontSize: "var(--t-sm)", fontWeight: 700, opacity: deleting ? 0.7 : 1 }}>
            {deleting ? "מוחק..." : "כן, מחק"}
          </button>
        </div>
      </div>
    </>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function AdPlaceholder({ objective, color, name }: { objective?: string; color: string; name: string }) {
  return (
    <div style={{ width: "100%", height: "100%", background: `linear-gradient(135deg, ${color}22 0%, ${color}44 50%, ${color}22 100%)`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 16, position: "relative" }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", opacity: 0.15 }}>
        <div style={{ width: 120, height: 120, borderRadius: "50%", background: color, position: "absolute", top: -30, right: -30 }} />
        <div style={{ width: 80, height: 80, borderRadius: "50%", background: color, position: "absolute", bottom: -20, left: 20 }} />
      </div>
      <div style={{ position: "relative" }}>
        <CampaignIcon objective={objective || "BRAND_AWARENESS"} size={40} />
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color, textAlign: "center", lineHeight: 1.3, position: "relative", maxWidth: "80%" }}>
        {name.slice(0, 40)}{name.length > 40 ? "…" : ""}
      </div>
    </div>
  );
}

function PlatformIcon({ platform, color }: { platform: string; color: string }) {
  if (platform === "instagram") return (
    <div style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(45deg, #f09433, #e6683c, #dc2743, #cc2366, #bc1888)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="#fff" stroke="none"/></svg>
    </div>
  );
  return (
    <div style={{ width: 28, height: 28, borderRadius: 8, background: color, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
    </div>
  );
}

function ToggleButton({ active, loading, onClick }: { active: boolean; loading: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{
        flex: 1, padding: "7px 12px", borderRadius: 999,
        border: `1.5px solid ${active ? "var(--negative)" : "var(--positive)"}`,
        background: active ? "transparent" : "var(--positive)",
        color: active ? "var(--negative)" : "#fff",
        fontSize: 12, fontWeight: 700,
        cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
        transition: "all 140ms", whiteSpace: "nowrap",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
      }}>
      {loading ? "..." : active ? <><IcoPause size={12} /> השהה</> : <><IcoPlay size={12} /> הפעל</>}
    </button>
  );
}

function Metric({ label, value, accent }: { label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, textAlign: "center" }}>
      <span style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color: accent ? "var(--blue)" : "var(--ink)", fontFeatureSettings: '"tnum" 1' }}>{value}</span>
    </div>
  );
}

function MiniStat({ label, value, icon, chip }: { label: string; value: React.ReactNode; icon: React.ReactNode; chip: string }) {
  return (
    <div className="card" style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-4)" }}>
      <div className={`chip chip-${chip}`} style={{ width: 36, height: 36 }}>{icon}</div>
      <div>
        <p style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</p>
        <p style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", lineHeight: 1, marginTop: 3, fontFeatureSettings: '"tnum" 1' }}>{value}</p>
      </div>
    </div>
  );
}

function ctaLabel(objective?: string): string {
  return objective === "LEAD_GENERATION" ? "השאר פרטים" : objective === "CONVERSIONS" ? "הזמן עכשיו" : objective === "TRAFFIC" ? "למד עוד" : objective === "MESSAGES" ? "שלח הודעה" : "לפרטים נוספים";
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ── Targeting autocomplete ─────────────────────────────────────────────
   Debounced search against the FB targeting proxy (server-side calls
   /search?type=...&q=...). Replaces free-text inputs so the saved
   audience contains real FB keys instead of user-typed strings —
   without that, FB's API rejects the targeting spec ("Invalid
   parameter"). */
function TargetingAutocomplete({
  phone, type, placeholder, onPick,
}: {
  phone: string;
  type: "adgeolocation" | "adinterest" | "adlocale";
  placeholder: string;
  onPick: (hit: FbTargetingHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FbTargetingHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const reqIdRef = useRef(0);
  const blurTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!q.trim() || q.trim().length < 2) { setHits([]); return; }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const r = await searchFbTargeting(phone, type, q.trim());
        if (myReq === reqIdRef.current) setHits(r);
      } catch {
        if (myReq === reqIdRef.current) setHits([]);
      } finally {
        if (myReq === reqIdRef.current) setLoading(false);
      }
    }, 280);
    return () => window.clearTimeout(handle);
  }, [q, phone, type]);

  const subtitle = (h: FbTargetingHit) => {
    if (type === "adgeolocation") {
      const parts = [h.type, h.region, h.country_name].filter(Boolean);
      return parts.join(" · ");
    }
    if (h.audience_size_lower_bound != null) {
      const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);
      return `${k(h.audience_size_lower_bound)}–${k(h.audience_size_upper_bound ?? h.audience_size_lower_bound)} משתמשים`;
    }
    return "";
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        className="input"
        style={{ width: "100%" }}
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { blurTimerRef.current = window.setTimeout(() => setOpen(false), 150); }}
        placeholder={placeholder}
      />
      {open && (loading || hits.length > 0) && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
          marginTop: 4,
          background: "var(--paper)", border: "1px solid var(--rule)",
          borderRadius: "var(--r-2)", boxShadow: "var(--sh-2)",
          maxHeight: 280, overflowY: "auto",
        }}>
          {loading && hits.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--ink-3)" }}>מחפש…</div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.key || h.id}-${i}`}
              type="button"
              onMouseDown={() => {
                if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
                onPick(h);
                setQ("");
                setHits([]);
                setOpen(false);
              }}
              style={{
                display: "block", width: "100%",
                padding: "8px 12px",
                background: "transparent", border: 0, borderBottom: "1px solid var(--rule)",
                textAlign: "right", cursor: "pointer",
                fontSize: 13,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tint)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ fontWeight: 700, color: "var(--ink)" }}>{h.name}</div>
              {subtitle(h) && <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{subtitle(h)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

