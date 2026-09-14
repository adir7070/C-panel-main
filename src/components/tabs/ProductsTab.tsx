import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BusinessProfile,
  type ClientPackage,
  type ClientPackageHistoryEntry,
  type PackageProducts,
  getCharacterization,
  getClientPackage,
  getClientPackageProducts,
  listClientPackages,
  resolveImgUrl,
  generateWowAds,
  generateWowOrganic,
  launchFacebookCampaign,
  isFbUnavailable,
} from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../context/ToastContext";
import { SectionHead } from "../ui/SectionHead";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Modal } from "../ui/Modal";
import { FeatureUnavailable } from "../ui/FeatureUnavailable";
import { WowAdsPanel }     from "./WowAdsPanel";
import { WowOrganicPanel } from "./WowOrganicPanel";
import { WowLpPanel }      from "./WowLpPanel";
import { WowLogoPanel }    from "./WowLogoPanel";
import { WowVideoPanel }   from "./WowVideoPanel";
import { ProductStatusTable } from "../client-detail/ProductStatusTable";

interface Props {
  phone: string;
  onGotoCharacterization: () => void;
  onGotoPersonalCatalog: () => void;
  /** Bumped by ClientDetailPage when a purchase lands — refresh the package in place. */
  syncTick?: number;
}

/* View-only fallback package. Personal-catalog packages were lost on the closed
   AWS server, so clients show as "no package" even though they have real
   deliverables (ads/posts/LPs) in storage. When there is no active package we
   substitute this so all product sections open and the manager can SEE the
   client's existing content. It grants no real quota — it's for viewing. */
const VIEW_ONLY_PKG = {
  name: "צפייה בתוצרים (ללא חבילה)",
  purchasedAt: "",
  items: { paidAds: 1, organicAds: 1, lps: 1, videos: 1, logos: 1, campaignTraffic: 1, campaignLeads: 1, saleWebsite: 1 },
  coins: 0, coinsUsed: 0, coinsRemaining: 0, coinRedemptions: [],
  viewOnly: true,
} as unknown as ClientPackage;

export function ProductsTab({ phone, onGotoCharacterization, onGotoPersonalCatalog, syncTick = 0 }: Props) {
  const fetcher = useCallback(() => getCharacterization(phone), [phone]);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);
  const toast = useToast();

  const [pkg, setPkg] = useState<ClientPackage | null>(null);
  const [pkgLoading, setPkgLoading] = useState(true);
  const [pkgError, setPkgError] = useState<string | null>(null);
  const [refreshKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [resending, setResending] = useState(false);
  const [genResults, setGenResults] = useState<GeneratedAd[] | null>(null);
  /* Full purchase history — every completed package the client has
     bought. The newest one is the same as `pkg` above (active), older
     ones render as read-only history cards. */
  const [history, setHistory] = useState<ClientPackageHistoryEntry[]>([]);

  const reloadPackage = useCallback(() => {
    let cancelled = false;
    setPkgLoading(true);
    setPkgError(null);
    Promise.all([
      getClientPackage(phone),
      listClientPackages(phone).then(r => r.packages).catch(() => []),
    ])
      .then(([p, h]) => {
        if (cancelled) return;
        setPkg(p ?? VIEW_ONLY_PKG); // no purchased package → view-only fallback so products still show
        setHistory(h);
      })
      .catch(e => { if (!cancelled) setPkgError(e instanceof Error ? e.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setPkgLoading(false); });
    return () => { cancelled = true; };
  }, [phone]);

  useEffect(reloadPackage, [reloadPackage]);

  /* A purchase for this client refreshes the package in place — no spinner,
     so open WOW panels keep whatever the manager was doing. */
  useEffect(() => {
    if (!syncTick) return;
    let cancelled = false;
    Promise.all([
      getClientPackage(phone),
      listClientPackages(phone).then(r => r.packages).catch(() => []),
    ])
      .then(([p, h]) => {
        if (cancelled) return;
        setPkg(p ?? VIEW_ONLY_PKG);
        setHistory(h);
        setPkgError(null);
      })
      .catch(() => { /* keep what is on screen; the next purchase event retries */ });
    return () => { cancelled = true; };
  }, [syncTick, phone]);

  const completeness = useMemo(() => assessCompleteness(data?.businessProfile ?? null), [data]);

  /* ── Loading ── */
  if (loading || pkgLoading) return <Spinner label="טוען..." />;
  if (error)   return <ErrorBlock message={error}    onRetry={reload} />;
  if (pkgError) return <ErrorBlock message={pkgError} onRetry={reloadPackage} />;

  const bp = data?.businessProfile;

  /* ── Gate 1: Characterization must be complete ── */
  if (!bp || !completeness.complete) {
    return (
      <section className="section" style={{ marginTop: 0 }}>
        <SectionHead eyebrow="Locked" title="האיפיון לא הושלם" />
        <EmptyState
          title="לא ניתן ליצור מוצרים עדיין"
          meta={
            "ליצירת מוצרים דרושים לפחות הפרטים הבסיסיים: שם עסק, קטגוריה, " +
            "שירות אחד, סגנון עיצוב, קהל יעד ומטרת דף. " +
            "השלם את האיפיון בטאב 'איפיון' ותחזור לכאן."
          }
          action={<Button onClick={onGotoCharacterization}>פתח את טאב האיפיון</Button>}
        />

        <div
          className="card"
          style={{ marginTop: "var(--s-5)", borderTop: "3px solid var(--warning)" }}
        >
          <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>פערים נוכחיים</p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {completeness.missing.map(m => (
              <li
                key={m}
                className="t-body"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  borderBottom: "1px solid var(--rule)",
                  padding: "10px 0",
                  minHeight: 40,
                }}
              >
                <span>{m}</span>
                <Badge variant="warning">חסר</Badge>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  /* ── Gate 2: Active package required ──
     This is NOT a server error even though the underlying API returned 404 —
     it's the expected pre-purchase state. We show a calm empty state with
     the unified guidance message and a button straight to the personal
     catalog tab (where all package purchases now happen). */
  if (!pkg) {
    return (
      <section className="section" style={{ marginTop: 0 }}>
        <SectionHead eyebrow="Locked" title="עדיין אין מוצרים זמינים" />
        <EmptyState
          title="על מנת ליצור מוצרים חייב לרכוש חבילה ולמלא את האיפיון"
          meta="לאחר רכישת חבילה והשלמת האיפיון, המוצרים הכלולים בחבילה ייפתחו כאן אוטומטית."
          action={<Button onClick={onGotoPersonalCatalog}>פתח את טאב הקטלוג האישי</Button>}
        />
      </section>
    );
  }

  /* Runs the ad-generation prompts (campaign.md) locally against Gemini —
     no more Make.com hop. The endpoint is synchronous: it returns the
     finished ad copy + images directly, so results are shown here for
     review instead of the old fire-and-forget "Make will handle it"
     toast. Generating N images takes real time (real model calls), so
     this can run for a while — the button shows a loading state. */
  async function resetAndGenerate() {
    const ok = window.confirm("פעולה זו תיצור מחדש מודעות עבור הלקוח (קריאה ל-AI, לוקאלית). להמשיך?");
    if (!ok) return;
    setRegenerating(true);
    try {
      const cleanBp = bp ? {
        ...bp,
        logoUrl: undefined,
        images: undefined,
        avatar: undefined,
        services: bp.services?.map(s => ({ ...s, images: undefined, imageUrl: undefined })),
      } : null;
      const payload = {
        ANSWERS: { ...data, businessProfile: cleanBp },
        LOGO: null,
        AVATAR: null,
        BRAND_COLORS: bp!.preferredColors ?? null,
        NUM_ADS: (pkg!.items.paidAds ?? 0) * 2,
      };
      const res = await fetch("/api/local-ads/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("cpanel_token") ?? ""}`,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `שגיאת שרת ${res.status}`);
      setGenResults(json.ads ?? []);
      toast.ok(`נוצרו ${json.ads?.length ?? 0} מודעות חדשות`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה ביצירת המודעות");
    } finally {
      setRegenerating(false);
    }
  }

  async function resendToProduction() {
    const ok = window.confirm("פעולה זו תאפס ותייצר מחדש את כל הפוסטים והמודעות בכל הקמפיינים. להמשיך?");
    if (!ok) return;
    setResending(true);
    try {
      const calls: Promise<unknown>[] = [];
      const items = pkg!.items;
      if (items.organicAds > 0) calls.push(generateWowOrganic(phone));
      for (let i = 0; i < (items.campaignTraffic ?? 0); i++)
        calls.push(generateWowAds(phone, `campaign_traffic_${i}`));
      for (let i = 0; i < (items.campaignLeads ?? 0); i++)
        calls.push(generateWowAds(phone, `campaign_leads_${i}`));
      if (items.paidAds > 0 && (items.campaignTraffic ?? 0) === 0 && (items.campaignLeads ?? 0) === 0)
        calls.push(generateWowAds(phone));
      await Promise.all(calls);
      toast.ok("נשלח לייצור — כל הפוסטים והמודעות מתחילים להיווצר מחדש");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשליחה לייצור");
    } finally {
      setResending(false);
    }
  }

  /* ── Active package + history of older packages ──
     The new layout stacks one card per package the client has ever
     bought. The most recent (active) one is expanded with the full
     live panels; older ones are read-only summary cards that can be
     expanded to show their items breakdown. */
  const logoUrl = resolveImgUrl(bp.logoUrl);

  /* Filter out the active one from history (it's already shown above
     as the live card) — match by purchasedAt since the active package
     is computed from the latest pending row. */
  const olderPackages = history.filter(h => !h.isActive);

  return (
    <div style={{ display: "grid", gap: "var(--s-7)" }}>

      {/* Per-product lifecycle status table — sits above the active card.
          Pass items so only purchased products render (no point showing
          'מודעות ממומנות' on a package that only includes organic posts). */}
      <ProductStatusTable phone={phone} items={pkg.items} />

      {/* Generate Again — wipes old sessions and fires fresh pipelines */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button
          onClick={resendToProduction}
          loading={resending}
          style={{ background: "linear-gradient(135deg, #0EA5E9 0%, #0284C7 100%)", color: "#fff", border: "none" }}
        >
          {resending ? "שולח לייצור…" : "🚀 שלח שוב לייצור"}
        </Button>
        <Button
          onClick={resetAndGenerate}
          loading={regenerating}
          style={{ background: "var(--warning)", color: "#fff", border: "none" }}
        >
          {regenerating ? "מייצר מחדש…" : "⟳ גנרט מחדש"}
        </Button>
      </div>

      {/* ── ACTIVE PACKAGE CARD — full live panels ── */}
      <ActivePackageCard
        key={refreshKey}
        pkg={pkg}
        phone={phone}
        logoUrl={logoUrl}
        reloadPackage={reloadPackage}
      />

      {/* ── HISTORY OF OLDER PACKAGES ── */}
      {olderPackages.length > 0 && (
        <div style={{ display: "grid", gap: "var(--s-4)" }}>
          <SectionHead
            eyebrow="History"
            title={`חבילות קודמות · ${olderPackages.length}`}
            meta="חבילות שהלקוח רכש לפני החבילה הנוכחית"
          />
          {olderPackages.map(h => (
            <OlderPackageCard key={h.purchaseId} pkg={h} phone={phone} />
          ))}
        </div>
      )}

      {/* ── Freshly-generated ads review (from the local AI pipeline) ── */}
      <Modal
        open={!!genResults}
        onClose={() => setGenResults(null)}
        size="xl"
        eyebrow="נוצר עכשיו · לוקאלית"
        title={`מודעות חדשות · ${genResults?.length ?? 0}`}
      >
        {genResults && <GeneratedAdsReview ads={genResults} />}
      </Modal>

    </div>
  );
}

interface GeneratedAd {
  prompt: string;
  title: string;
  body: string;
  cta: string;
  address: string;
  imageUrl: string;
}

/* Read-only review grid for ads the local pipeline just generated.
   No approve/regenerate here — those actions belong to the existing
   WowAdsPanel once the client's package products are wired to them;
   this is purely "here's what came out, download what you want". */
function GeneratedAdsReview({ ads }: { ads: GeneratedAd[] }) {
  if (ads.length === 0) {
    return <p className="t-meta">לא נוצרו מודעות — בדוק את לוגים של השרת המקומי.</p>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "var(--s-4)" }}>
      {ads.map((ad, i) => (
        <div key={i} className="card" style={{ padding: "var(--s-3)", display: "grid", gap: "var(--s-2)" }}>
          <div style={{ aspectRatio: "1 / 1", background: "var(--bg-tint)", borderRadius: "var(--r-2)", overflow: "hidden" }}>
            {ad.imageUrl ? (
              <img src={ad.imageUrl} alt={ad.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--ink-3)" }}>
                נכשל ביצירת תמונה
              </div>
            )}
          </div>
          <p style={{ fontWeight: 800, fontSize: 14, margin: 0 }}>{ad.title}</p>
          <p className="t-body" style={{ fontSize: 13, margin: 0 }}>{ad.body}</p>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Badge>{ad.cta}</Badge>
            {ad.imageUrl && (
              <a href={ad.imageUrl} download target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm bare">
                הורד תמונה
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Active package card ─────────────────────────────────────────────
   Renders the package banner + a section per purchased product type.
   Same content as the old flat layout, just wrapped in a card with a
   "פעילה" badge so the manager knows this is the live one. */
function ActivePackageCard({ pkg, phone, logoUrl, reloadPackage }: {
  pkg: ClientPackage;
  phone: string;
  logoUrl: string | undefined;
  reloadPackage: () => void;
}) {
  const items = pkg.items;
  /* Per-slot approval: slotKey → at least one ad in that panel is approved.
     Used to show the inline launch button below each campaign section.
     The launch backend uploads only approved ads, so a partial set is OK. */
  const toast = useToast();
  const [slotApprovalMap, setSlotApprovalMap] = useState<Record<string, boolean>>({});
  const [launchModal, setLaunchModal] = useState<{ type: "TRAFFIC" | "LEADS"; slotKey: string } | null>(null);
  const [resendingSlot, setResendingSlot] = useState<Record<string, boolean>>({});

  async function resendSlot(key: string, call: () => Promise<unknown>) {
    if (resendingSlot[key]) return;
    setResendingSlot(prev => ({ ...prev, [key]: true }));
    try {
      await call();
      toast.ok("נשלח לייצור מחדש");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setResendingSlot(prev => ({ ...prev, [key]: false }));
    }
  }

  const resendBtn = (key: string, call: () => Promise<unknown>) => (
    <Button
      onClick={() => resendSlot(key, call)}
      loading={!!resendingSlot[key]}
      style={{ fontSize: 12, padding: "4px 10px" }}
    >
      {resendingSlot[key] ? "שולח…" : "🔄 שלח לייצור מחדש"}
    </Button>
  );
  /* Collapse persists per-client so toggling on one client doesn't bleed
     into another. Default = expanded; once collapsed, the manager only
     sees the package "plan line" until they click again. */
  const storageKey = `cpanel.activePkg.collapsed.${phone}`;
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) !== "1"; } catch { return true; }
  });
  const toggle = () => {
    setExpanded(e => {
      const next = !e;
      try { localStorage.setItem(storageKey, next ? "0" : "1"); } catch { /* ignore */ }
      return next;
    });
  };

  /* One-line summary shown in the header so the manager has enough
     context when the card is collapsed (purchase date + items). */
  const itemSummary = [
    items.paidAds    > 0 && `${items.paidAds} מודעות`,
    items.organicAds > 0 && `${items.organicAds} פוסטים`,
    items.lps        > 0 && `${items.lps} דף נחיתה`,
    items.videos     > 0 && `${items.videos} וידאו`,
    items.logos      > 0 && `${items.logos} לוגו`,
  ].filter(Boolean).join(" · ");

  return (
    /* Package WRAPPER — the whole active package is always rendered
       inside an outlined "window" so the manager always sees the
       package as a discrete container, even when there's only one. */
    <div
      className="card-static"
      style={{
        background: "var(--paper)",
        border: "2px solid var(--positive)",
        borderRadius: "var(--r-3)",
        padding: 0,
        overflow: "hidden",
        boxShadow: "var(--sh-2)",
      }}
    >
      {/* WINDOW HEADER — clickable to collapse/expand. Acts as the
          "plan line" the manager sees when the body is hidden. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={`active-pkg-body-${phone}`}
        style={{
          width: "100%",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: "var(--s-3)", flexWrap: "wrap",
          padding: "var(--s-4) var(--s-5)",
          background: "var(--positive-bg)",
          borderBottom: expanded ? "1px solid var(--positive)" : "0",
          border: 0, cursor: "pointer", textAlign: "right",
          transition: "background 150ms var(--ease-out)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", minWidth: 0, flex: 1 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, borderRadius: 8,
            background: "var(--positive)", color: "#fff",
            flexShrink: 0,
          }} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="18" height="14" rx="2" />
              <path d="M3 10h18" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="t-eyebrow" style={{ color: "var(--positive)", margin: 0 }}>
              חבילה פעילה · עבודה כעת
            </p>
            <h2 style={{
              fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)",
              margin: "2px 0 0", letterSpacing: "-0.01em",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{pkg.name}</h2>
            {!expanded && itemSummary && (
              <p className="t-meta" style={{ marginTop: 4, fontSize: 12 }}>
                נרכשה ב-{formatDate(pkg.purchasedAt)} · {itemSummary} · {pkg.coinsRemaining.toLocaleString("he-IL")}/{pkg.coins.toLocaleString("he-IL")} מטבעות
              </p>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flexShrink: 0 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 12px",
            background: "var(--positive)", color: "#fff",
            borderRadius: 99,
            fontSize: 12, fontWeight: 700,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: 99, background: "#fff",
              animation: "pulse-soft 2s ease-in-out infinite",
            }} />
            פעילה
          </span>
          <span aria-hidden="true" style={{
            fontSize: 18, color: "var(--positive)",
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 200ms var(--ease-out)",
          }}>▾</span>
        </div>
      </button>

      {/* WINDOW BODY — banner + product sections (hidden when collapsed) */}
      {launchModal && (
        <LaunchCampaignModal
          phone={phone}
          type={launchModal.type}
          slotKey={launchModal.slotKey}
          onClose={() => setLaunchModal(null)}
        />
      )}

      {expanded && (
      <div id={`active-pkg-body-${phone}`} style={{ padding: "var(--s-5)", display: "grid", gap: "var(--s-5)" }}>
        {items.organicAds > 0 && (
          <ProductSection
            eyebrow="Organic"
            title={`מודעות אורגניות · ${items.organicAds} מתוך החבילה`}
            action={resendBtn("organic", () => generateWowOrganic(phone))}
          >
            <WowOrganicPanel phone={phone} quota={items.organicAds} coinsRemaining={pkg.coinsRemaining} onCoinsChanged={reloadPackage} />
          </ProductSection>
        )}

        {/* Campaign-type sections — one independent WowAdsPanel per purchased slot.
            Each slot gets its own slotKey so sessions are fully isolated.
            The launch button appears inline as soon as ≥1 ad in that slot is
            approved — the campaign launches with whatever subset is approved. */}
        {Array.from({ length: items.campaignTraffic ?? 0 }).map((_, idx) => {
          const slotKey = `campaign_traffic_${idx}`;
          const hasAnyApproved = !!slotApprovalMap[slotKey];
          return (
            <ProductSection
              key={slotKey}
              eyebrow="ADS"
              title={(items.campaignTraffic ?? 0) === 1 ? "קמפיין אתר" : `קמפיין אתר #${idx + 1}`}
              action={resendBtn(slotKey, () => generateWowAds(phone, slotKey))}
            >
              <WowAdsPanel
                phone={phone}
                logoUrl={logoUrl}
                quota={items.paidAds || 10}
                coinsRemaining={pkg.coinsRemaining}
                onCoinsChanged={reloadPackage}
                slotKey={slotKey}
                onHasAnyApprovedChanged={v => setSlotApprovalMap(prev => prev[slotKey] === v ? prev : ({ ...prev, [slotKey]: v }))}
              />
              {hasAnyApproved && (
                <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: "var(--s-3)" }}>
                  <Button
                    onClick={() => setLaunchModal({ type: "TRAFFIC", slotKey })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    📣 {(items.campaignTraffic ?? 0) === 1 ? "הקמת קמפיין אתר" : `הקמת קמפיין אתר #${idx + 1}`}
                  </Button>
                </div>
              )}
            </ProductSection>
          );
        })}
        {Array.from({ length: items.campaignLeads ?? 0 }).map((_, idx) => {
          const slotKey = `campaign_leads_${idx}`;
          const hasAnyApproved = !!slotApprovalMap[slotKey];
          return (
            <ProductSection
              key={slotKey}
              eyebrow="ADS"
              title={(items.campaignLeads ?? 0) === 1 ? "קמפיין לידים" : `קמפיין לידים #${idx + 1}`}
              action={resendBtn(slotKey, () => generateWowAds(phone, slotKey))}
            >
              <WowAdsPanel
                phone={phone}
                logoUrl={logoUrl}
                quota={items.paidAds || 10}
                coinsRemaining={pkg.coinsRemaining}
                onCoinsChanged={reloadPackage}
                slotKey={slotKey}
                onHasAnyApprovedChanged={v => setSlotApprovalMap(prev => prev[slotKey] === v ? prev : ({ ...prev, [slotKey]: v }))}
              />
              {hasAnyApproved && (
                <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: "var(--s-3)" }}>
                  <Button
                    onClick={() => setLaunchModal({ type: "LEADS", slotKey })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    📣 {(items.campaignLeads ?? 0) === 1 ? "הקמת קמפיין לידים" : `הקמת קמפיין לידים #${idx + 1}`}
                  </Button>
                </div>
              )}
            </ProductSection>
          );
        })}
        {/* Generic paid-ads section — covers legacy packages bought
            before the campaign_traffic / campaign_leads splits were
            added to the items map. Without this, a customer who paid
            for "10 ads" pre-update can't launch a Facebook campaign
            at all because their items map has no campaign_* key.
            We expose BOTH launch buttons once the ads are approved
            so the manager can pick the right campaign type per
            client without needing a DB migration. */}
        {items.paidAds > 0 && (items.campaignTraffic ?? 0) === 0 && (items.campaignLeads ?? 0) === 0 && (() => {
          const slotKey = "legacy_paid_ads";
          const hasAnyApproved = !!slotApprovalMap[slotKey];
          return (
            <ProductSection
              eyebrow="ADS"
              title={`מודעות ממומנות · ${items.paidAds} מתוך החבילה`}
              action={resendBtn("generic_ads", () => generateWowAds(phone))}
            >
              <WowAdsPanel
                phone={phone}
                logoUrl={logoUrl}
                quota={items.paidAds}
                coinsRemaining={pkg.coinsRemaining}
                onCoinsChanged={reloadPackage}
                onHasAnyApprovedChanged={v => setSlotApprovalMap(prev => prev[slotKey] === v ? prev : ({ ...prev, [slotKey]: v }))}
              />
              {hasAnyApproved && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", paddingTop: "var(--s-3)" }}>
                  <Button
                    onClick={() => setLaunchModal({ type: "TRAFFIC", slotKey: "" })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    הקמת קמפיין אתר
                  </Button>
                  <Button
                    onClick={() => setLaunchModal({ type: "LEADS", slotKey: "" })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    הקמת קמפיין לידים
                  </Button>
                </div>
              )}
            </ProductSection>
          );
        })()}

        {/* קמפיין מיוחד — independent panel for one-off promo campaigns.
            Always rendered (not gated by package items count) since this is
            an always-available action, not a quota-bound product. The slot
            key is fixed so the panel always shows the latest campaign. */}
        {(() => {
          const csSlotKey = "campaign_special_0";
          const hasAnyApproved = !!slotApprovalMap[csSlotKey];
          return (
            <ProductSection eyebrow="🎯 ADS" title="קמפיין מיוחד">
              <WowAdsPanel
                phone={phone}
                logoUrl={logoUrl}
                quota={10}
                coinsRemaining={pkg.coinsRemaining}
                onCoinsChanged={reloadPackage}
                slotKey={csSlotKey}
                enableCampaignSpecialFlow
                onHasAnyApprovedChanged={v => setSlotApprovalMap(prev => prev[csSlotKey] === v ? prev : ({ ...prev, [csSlotKey]: v }))}
              />
              {hasAnyApproved && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", paddingTop: "var(--s-3)" }}>
                  <Button
                    onClick={() => setLaunchModal({ type: "TRAFFIC", slotKey: csSlotKey })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    📣 הקמת קמפיין אתר
                  </Button>
                  <Button
                    onClick={() => setLaunchModal({ type: "LEADS", slotKey: csSlotKey })}
                    style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
                  >
                    📣 הקמת קמפיין לידים
                  </Button>
                </div>
              )}
            </ProductSection>
          );
        })()}

        {items.logos > 0 && (
          <ProductSection
            eyebrow="Logo"
            title={`לוגו · ${items.logos} מתוך החבילה`}
          >
            <WowLogoPanel phone={phone} logoUrl={logoUrl} quota={items.logos} />
          </ProductSection>
        )}

        {items.videos > 0 && (
          <ProductSection
            eyebrow="Video"
            title={`וידאו · ${items.videos} מתוך החבילה`}
          >
            <WowVideoPanel phone={phone} quota={items.videos} />
          </ProductSection>
        )}

        {items.lps > 0 && (
          <ProductSection
            eyebrow="Landing Page"
            title={`דף נחיתה · ${items.lps} מתוך החבילה`}
          >
            <WowLpPanel phone={phone} logoUrl={logoUrl} quota={items.lps} coinsRemaining={pkg.coinsRemaining} onCoinsChanged={reloadPackage} />
          </ProductSection>
        )}

        {/* If after running through all item types nothing rendered, the
            customer bought a package whose items map is all-zero (bundle
            expansion missed something, or the package has no creative
            items at all). Surface this clearly instead of an empty card. */}
        {(items.organicAds || 0) === 0 &&
         (items.paidAds || 0) === 0 &&
         (items.lps || 0) === 0 &&
         (items.logos || 0) === 0 &&
         (items.videos || 0) === 0 &&
         (items.campaignTraffic ?? 0) === 0 &&
         (items.campaignLeads ?? 0) === 0 && (
          <EmptyPackageDiagnose phone={phone} pkgKey={pkg.id} />
        )}
      </div>
      )}
    </div>
  );
}

/* ─── Empty-package diagnose card ─────────────────────────────────────
   Surfaces when the active package has all-zero items. Fires the
   diagnose endpoint directly and shows the response inline so the
   manager doesn't need to open DevTools or paste anything. */
function EmptyPackageDiagnose({ phone, pkgKey }: { phone: string; pkgKey?: string }) {
  const toast = useToast();
  const [diag, setDiag] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const token = localStorage.getItem("cpanel_token") || "";
      const r = await fetch(`/api/cpanel/clients/${encodeURIComponent(phone)}/personal-catalog/diagnose`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setDiag(d?.activePackage ?? d);
      try { await navigator.clipboard.writeText(JSON.stringify(d?.activePackage ?? d, null, 2)); } catch { /* ignore */ }
      toast.ok("האבחנה הועתקה ללוח");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "אבחנה נכשלה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      padding: "var(--s-5)",
      background: "var(--warning-bg, #fffbeb)",
      border: "1px solid var(--warning, #f59e0b)",
      borderRadius: "var(--r-2)",
      display: "grid",
      gap: "var(--s-3)",
    }}>
      <p style={{ fontWeight: 800, color: "var(--warning, #b45309)", margin: 0 }}>
        אין מוצרים בחבילה הזו ליצירה
      </p>
      <p className="t-body" style={{ margin: 0 }}>
        החבילה שנרכשה מכילה <strong>0</strong> פריטים מכל סוג (מודעות / פוסטים / דפי נחיתה / לוגו / וידאו / קמפיינים).
        זה קורה כאשר הפריטים בקטלוג לא מוגדרים עם items map תקין — או שהחבילה אכן ריקה.
      </p>
      {pkgKey && (
        <p className="t-meta" style={{ margin: 0, fontSize: 12 }}>
          מפתח חבילה: <code dir="ltr" style={{ fontSize: 11 }}>{pkgKey}</code>
        </p>
      )}
      <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        <Button onClick={run} loading={busy}>
          {busy ? "מאבחן…" : "הרץ אבחנה"}
        </Button>
      </div>
      {diag !== null && (
        <pre dir="ltr" style={{
          margin: 0, padding: "var(--s-3)",
          background: "#0b1430", color: "#e6edf3",
          borderRadius: "var(--r-2)",
          fontSize: 11, lineHeight: 1.4,
          overflow: "auto", maxHeight: 320,
        }}>
{JSON.stringify(diag, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ─── Older package card ──────────────────────────────────────────────
   Read-only summary of a package the client bought in the past. Click
   to expand a breakdown of what was included AND the actual products
   generated under that package. Server resolves the products either by
   exact packageId match (forward-compat) or by purchasedAt time window
   (legacy untagged sessions). */
function OlderPackageCard({ pkg, phone }: { pkg: ClientPackageHistoryEntry; phone: string }) {
  const [expanded, setExpanded] = useState(false);
  const date = new Date(pkg.purchasedAt);
  const dateStr = isNaN(date.getTime())
    ? pkg.purchasedAt
    : date.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
  const itemSummary = [
    pkg.items.paidAds    > 0 && `${pkg.items.paidAds} מודעות`,
    pkg.items.organicAds > 0 && `${pkg.items.organicAds} פוסטים`,
    pkg.items.lps        > 0 && `${pkg.items.lps} דף נחיתה`,
    pkg.items.videos     > 0 && `${pkg.items.videos} וידאו`,
    pkg.items.logos      > 0 && `${pkg.items.logos} לוגו`,
  ].filter(Boolean).join(" + ") || "ללא פריטים";

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        style={{
          width: "100%",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: "var(--s-4)",
          padding: "var(--s-4) var(--s-5)",
          background: "transparent", border: 0,
          cursor: "pointer", textAlign: "right",
          transition: "background 150ms var(--ease-out)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: "var(--t-md)", fontWeight: 700, color: "var(--ink)", margin: 0 }}>
              {pkg.name}
            </h3>
            <span className="t-meta" style={{ fontSize: 11 }}>· {dateStr}</span>
            <span className="num" dir="ltr" style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 700 }}>
              ₪{pkg.totalAmount.toLocaleString("he-IL")}
            </span>
          </div>
          <p className="t-meta" style={{ marginTop: 4, fontSize: 12 }}>{itemSummary}</p>
        </div>
        <span style={{
          flexShrink: 0,
          fontSize: 18, color: "var(--ink-3)",
          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 200ms var(--ease-out)",
        }}>▾</span>
      </button>

      {expanded && (
        <div style={{
          padding: "var(--s-4) var(--s-5) var(--s-5)",
          borderTop: "1px solid var(--rule)",
          background: "var(--bg-tint)",
          display: "grid",
          gap: "var(--s-4)",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "var(--s-3)",
          }}>
            {pkg.items.paidAds > 0    && <ItemStat label="מודעות ממומנות" value={pkg.items.paidAds} />}
            {pkg.items.organicAds > 0 && <ItemStat label="פוסטים אורגניים" value={pkg.items.organicAds} />}
            {pkg.items.lps > 0        && <ItemStat label="דפי נחיתה"         value={pkg.items.lps} />}
            {pkg.items.videos > 0     && <ItemStat label="סרטונים"            value={pkg.items.videos} />}
            {pkg.items.logos > 0      && <ItemStat label="לוגו"                value={pkg.items.logos} />}
            {pkg.coins > 0            && <ItemStat label="טוקנים"             value={pkg.coins} />}
          </div>

          <OlderPackageProducts phone={phone} pkgId={pkg.pkgId} />
        </div>
      )}
    </div>
  );
}

/* ─── Older package: read-only products grid ──────────────────────────
   Lazily fetches the historical products for this package the first
   time the user expands the card. Renders compact thumbnail grids — no
   regenerate / approve / SMS buttons since the package is no longer
   active. Clicking a thumbnail opens the image full-size in a new tab. */
function OlderPackageProducts({ phone, pkgId }: { phone: string; pkgId: string }) {
  const [data, setData] = useState<PackageProducts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    getClientPackageProducts(phone, pkgId)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "שגיאה"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [phone, pkgId]);

  if (loading) return <div style={{ padding: "var(--s-3) 0" }}><Spinner label="טוען תוצרים..." /></div>;
  if (error) {
    return (
      <p className="t-meta" style={{ fontSize: 12, color: "var(--negative)" }}>
        שגיאה בטעינת התוצרים: {error}
      </p>
    );
  }

  const hasAny = Boolean(data?.ads || data?.organic || data?.lp);
  if (!hasAny) {
    return (
      <p className="t-meta" style={{ fontSize: 12, lineHeight: 1.5 }}>
        לא נמצאו תוצרים שיוצרו תחת חבילה זו. ייתכן שהלקוח לא ייצר תוצרים בזמן שהחבילה הייתה פעילה.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-4)" }}>
      {data?.ads && data.ads.generatedAds.length > 0 && (
        <HistoricalSection
          title={`מודעות ממומנות · ${data.ads.completedCount}/${data.ads.totalAds}`}
        >
          <ThumbnailGrid
            items={data.ads.generatedAds.map(a => ({
              id: String(a.id),
              imageUrl: typeof a.imageUrl === "string" ? a.imageUrl : null,
              caption: a.headline || a.primaryText || a.description || "",
              headline:    a.headline,
              description: a.description,
              primaryText: a.primaryText,
            }))}
          />
        </HistoricalSection>
      )}

      {data?.organic && data.organic.generatedPosts.length > 0 && (
        <HistoricalSection
          title={`פוסטים אורגניים · ${data.organic.completedCount}/${data.organic.totalPosts}`}
        >
          <ThumbnailGrid
            items={data.organic.generatedPosts.map(p => ({
              id: String(p.id),
              imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : null,
              caption: p.caption || "",
              /* Organic historical posts only carry a caption — show
                 it as the description in the rich-detail modal. */
              description: p.caption,
            }))}
          />
        </HistoricalSection>
      )}

      {data?.lp && data.lp.lp && (
        <HistoricalSection title="דף נחיתה">
          <HistoricalLpCard lp={data.lp} />
        </HistoricalSection>
      )}
    </div>
  );
}

function HistoricalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="t-eyebrow" style={{ marginBottom: "var(--s-2)" }}>{title}</p>
      {children}
    </section>
  );
}

interface Thumb {
  id:       string;
  imageUrl: string | null;
  caption:  string;
  /* Rich-detail fields shown in the lightbox modal alongside the image.
     Historical data is read-only — no edit/regen/approve buttons. */
  headline?:    string;
  description?: string;
  primaryText?: string;
}

function ThumbnailGrid({ items }: { items: Thumb[] }) {
  /* Click → open the image in a lightbox Modal instead of new tab. Matches
     the active-package thumbnail UX (WowOrganicPanel). The active tile is
     remembered as an id so the modal always renders against fresh items. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? items.find(t => t.id === activeId) ?? null : null;

  if (items.length === 0) {
    return <p className="t-meta" style={{ fontSize: 12 }}>אין תוצרים לחבילה זו</p>;
  }
  return (
    <>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: "var(--s-3)",
      }}>
        {items.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => { if (t.imageUrl) setActiveId(t.id); }}
            disabled={!t.imageUrl}
            title={t.caption}
            style={{
              display: "block",
              aspectRatio: "1 / 1",
              background: "var(--paper)",
              border: "1px solid var(--rule)",
              borderRadius: "var(--r-2)",
              overflow: "hidden",
              padding: 0,
              cursor: t.imageUrl ? "zoom-in" : "default",
              position: "relative",
              transition: "transform 150ms var(--ease-out), box-shadow 150ms var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (!t.imageUrl) return;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = "0 8px 24px rgba(11,20,48,0.12)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.boxShadow = "";
            }}
          >
            {t.imageUrl ? (
              <img
                src={resolveImgUrl(t.imageUrl)}
                alt={t.caption}
                loading="lazy"
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            ) : (
              <div style={{
                width: "100%", height: "100%",
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "var(--s-2)",
                fontSize: 11, color: "var(--ink-3)", textAlign: "center",
              }}>
                ללא תמונה
              </div>
            )}
          </button>
        ))}
      </div>

      <Modal
        open={!!active}
        onClose={() => setActiveId(null)}
        size="xl"
        eyebrow="היסטוריה"
        title={active?.headline || active?.caption || "תוצר ארכיוני"}
      >
        {active && <HistoricalItemDetail item={active} />}
      </Modal>
    </>
  );
}

/**
 * Read-only rich detail view for historical (archived) ads / posts.
 * Mirrors the active PostCard layout (image left, text + download right)
 * so the experience is visually consistent. No edit/regenerate/approve
 * buttons — those endpoints don't apply to past purchases.
 */
function HistoricalItemDetail({ item }: { item: Thumb }) {
  const imgUrl = item.imageUrl ? resolveImgUrl(item.imageUrl) : null;
  const hasAnyText = !!(item.headline || item.description || item.primaryText);
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
      gap: "var(--s-4)",
      alignItems: "stretch",
    }}>
      {/* Left — image at full size, capped by the modal height */}
      <div style={{
        background: "var(--bg-tint)",
        borderRadius: "var(--r-2)",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        maxHeight: "70vh",
        minHeight: 280,
      }}>
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={item.caption}
            style={{
              maxWidth: "100%", maxHeight: "70vh",
              objectFit: "contain", display: "block",
            }}
          />
        ) : (
          <span className="t-meta">ללא תמונה</span>
        )}
      </div>

      {/* Right — texts + download */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
        padding: "var(--s-2)",
      }}>
        {item.headline && (
          <div>
            <p className="t-eyebrow" style={{ marginBottom: 4 }}>כותרת</p>
            <p style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", lineHeight: 1.3, margin: 0 }}>
              {item.headline}
            </p>
          </div>
        )}

        {item.primaryText && item.primaryText !== item.headline && (
          <div>
            <p className="t-eyebrow" style={{ marginBottom: 4 }}>טקסט ראשי</p>
            <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {item.primaryText}
            </p>
          </div>
        )}

        {item.description && item.description !== item.primaryText && (
          <div>
            <p className="t-eyebrow" style={{ marginBottom: 4 }}>תיאור</p>
            <p className="t-body" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {item.description}
            </p>
          </div>
        )}

        {!hasAnyText && (
          <p className="t-meta">לתוצר הזה אין מטא־דאטה טקסטואלית שמורה.</p>
        )}

        <div style={{ marginTop: "auto", display: "flex", gap: "var(--s-2)" }}>
          {imgUrl && (
            <a
              href={imgUrl}
              download
              target="_blank"
              rel="noreferrer"
              className="btn"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "8px 14px",
                background: "var(--blue)", color: "#fff",
                border: 0,
                borderRadius: "var(--r-2)",
                fontWeight: 700, fontSize: 13,
                textDecoration: "none",
                cursor: "pointer",
              }}
            >
              הורד תמונה
            </a>
          )}
        </div>

        <p className="t-meta" style={{ marginTop: "var(--s-2)", fontSize: 11, color: "var(--ink-4)" }}>
          תצוגה לקריאה בלבד — תוצר מארכיון חבילה קודמת.
        </p>
      </div>
    </div>
  );
}

function HistoricalLpCard({ lp }: { lp: PackageProducts["lp"] }) {
  if (!lp) return null;
  const lpDoc = lp.lp as Record<string, unknown> | null;
  const heroImage = lpDoc && typeof lpDoc === "object"
    ? (typeof (lpDoc as Record<string, unknown>).heroImageUrl === "string"
        ? (lpDoc as Record<string, string>).heroImageUrl
        : null)
    : null;
  const title = lpDoc && typeof (lpDoc as Record<string, unknown>).title === "string"
    ? (lpDoc as Record<string, string>).title
    : "דף נחיתה";

  return (
    <div style={{
      display: "flex",
      gap: "var(--s-3)",
      padding: "var(--s-3)",
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-2)",
      alignItems: "center",
    }}>
      {heroImage ? (
        <img
          src={resolveImgUrl(heroImage)}
          alt={title}
          style={{
            width: 96, height: 96, objectFit: "cover", borderRadius: "var(--r-1)",
            flexShrink: 0,
          }}
        />
      ) : (
        <div style={{
          width: 96, height: 96, borderRadius: "var(--r-1)", background: "var(--bg-tint)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, color: "var(--ink-3)", flexShrink: 0,
        }}>ללא תמונה</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontWeight: 700, color: "var(--ink)", margin: 0, fontSize: 14 }}>{title}</p>
        {lp.previewUrl && (
          <a
            href={lp.previewUrl}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            style={{
              fontSize: 12, color: "var(--blue)", textDecoration: "underline",
              marginTop: 4, display: "inline-block",
            }}
          >פתח דף נחיתה</a>
        )}
      </div>
    </div>
  );
}

function ItemStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-2)",
      padding: "10px 12px",
    }}>
      <p style={{
        margin: 0, fontSize: 10, fontWeight: 700,
        color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase",
      }}>{label}</p>
      <p className="tabular" style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, color: "var(--ink)" }}>
        {value.toLocaleString("he-IL")}
      </p>
    </div>
  );
}

/* ── Launch Campaign Modal ─────────────────────────────────────────── */

function LaunchCampaignModal({ phone, type, slotKey, onClose }: {
  phone: string;
  type: "TRAFFIC" | "LEADS";
  slotKey?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<{ campaignId: string; adCount: number; campaignUrl?: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (type === "TRAFFIC") inputRef.current?.focus();
  }, [type]);

  const isValidUrl = (u: string) => {
    try { return Boolean(new URL(u)); } catch { return false; }
  };

  async function launch() {
    if (type === "TRAFFIC" && !isValidUrl(websiteUrl)) {
      toast.warn("יש להזין כתובת אתר תקינה (https://...)");
      return;
    }
    setLaunching(true);
    try {
      const r = await launchFacebookCampaign(phone, type, type === "TRAFFIC" ? websiteUrl : undefined, slotKey);
      setResult({ campaignId: r.campaignId, adCount: r.adCount, campaignUrl: r.campaignUrl });
      toast.ok(`הקמפיין הוקם בהצלחה — ${r.adCount} מודעות הועלו לפייסבוק`);
    } catch (err: unknown) {
      if (isFbUnavailable(err)) setUnavailable(true);
      else toast.error(err instanceof Error ? err.message : "שגיאה בהקמת הקמפיין");
    } finally {
      setLaunching(false);
    }
  }

  const overlayStyle: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 1000,
    background: "rgba(0,0,0,0.5)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "var(--s-4)",
  };
  const boxStyle: React.CSSProperties = {
    background: "var(--paper)", borderRadius: "var(--r-3)",
    padding: "var(--s-6)", width: "100%", maxWidth: 480,
    boxShadow: "var(--sh-3)",
    display: "grid", gap: "var(--s-4)",
  };

  return (
    <div style={overlayStyle} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={boxStyle}>
        <div>
          <p className="t-eyebrow" style={{ color: "var(--positive)" }}>
            {type === "TRAFFIC" ? "קמפיין תנועה לאתר" : "קמפיין לידים"}
          </p>
          <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, margin: "4px 0 0" }}>
            הקמת קמפיין פייסבוק
          </h3>
        </div>

        {unavailable ? (
          <>
            <FeatureUnavailable title="הקמת קמפיין לא זמינה" meta="הקמת קמפיין מעלה מודעות ישירות לחשבון המודעות של הלקוח ודורשת חיבור פייסבוק, שכבוי כרגע." />
            <Button onClick={onClose} style={{ width: "100%" }}>סגור</Button>
          </>
        ) : !result ? (
          <>
            {type === "TRAFFIC" ? (
              <div>
                <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  כתובת האתר לקמפיין
                </label>
                <input
                  ref={inputRef}
                  type="url"
                  placeholder="https://www.example.co.il"
                  value={websiteUrl}
                  onChange={e => setWebsiteUrl(e.target.value)}
                  dir="ltr"
                  style={{
                    width: "100%", padding: "10px 12px",
                    border: "1px solid var(--rule)", borderRadius: "var(--r-2)",
                    fontSize: 14, background: "var(--surface)",
                    outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>
            ) : (
              <div style={{
                padding: "var(--s-3)", background: "var(--bg-tint)",
                borderRadius: "var(--r-2)", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6,
              }}>
                ייצור קמפיין לידים עם טופס סטנדרטי — שם מלא, טלפון, עיר.
                לאחר ההקמה תוכל לערוך את הטופס ב-Ads Manager.
              </div>
            )}

            <div style={{ padding: "var(--s-3)", background: "var(--bg-tint)", borderRadius: "var(--r-2)", fontSize: 12, color: "var(--ink-3)" }}>
              תקציב: 20₪/יום · קמפיין + אדסט: פעיל · כל המודעות: כבויות
            </div>

            <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end" }}>
              <Button onClick={onClose} disabled={launching} style={{ background: "var(--surface)", color: "var(--ink)" }}>ביטול</Button>
              <Button
                onClick={launch}
                loading={launching}
                /* CRITICAL: must include `launching` in disabled, not just the
                   URL-validity check. The launch endpoint creates an entire
                   campaign + adset + 10 ads on each call — a manager who
                   clicks twice ends up with 2 separate FB campaigns and 20
                   duplicate ads (and 3 clicks → 30, which is exactly what one
                   manager hit in production). loading={launching} only swaps
                   the button text; without disabled, the button stays
                   clickable mid-request. */
                disabled={launching || (type === "TRAFFIC" && !isValidUrl(websiteUrl))}
                style={{ background: "linear-gradient(135deg, #16a34a 0%, #15803d 100%)", color: "#fff", border: "none" }}
              >
                {launching ? "מקים קמפיין…" : "הקם קמפיין"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div style={{ textAlign: "center", padding: "var(--s-4)" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
              <p style={{ fontWeight: 700, fontSize: 16 }}>הקמפיין הוקם בהצלחה!</p>
              <p className="t-meta" style={{ marginTop: 4 }}>{result.adCount} מודעות הועלו · כל המודעות כבויות</p>
            </div>
            {result.campaignUrl && (
              <a
                href={result.campaignUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "block", textAlign: "center",
                  padding: "10px", borderRadius: "var(--r-2)",
                  background: "#1877f2", color: "#fff",
                  fontWeight: 700, textDecoration: "none", fontSize: 14,
                }}
              >
                פתח ב-Ads Manager
              </a>
            )}
            <Button onClick={onClose} style={{ width: "100%" }}>סגור</Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Product section wrapper ──────────────────────────────────────── */

function ProductSection({ eyebrow, title, children, action }: { eyebrow: string; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="section" style={{ marginTop: 0 }}>
      <SectionHead eyebrow={eyebrow} title={title} action={action} />
      {children}
    </section>
  );
}


/* ── Helpers ───────────────────────────────────────────────────────── */

function assessCompleteness(bp: BusinessProfile | null): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!bp) return { complete: false, missing: ["טרם הוזן איפיון"] };
  if (!bp.businessName?.trim())                    missing.push("שם העסק");
  if (!bp.categoryKey)                             missing.push("קטגוריה ראשית");
  if (!bp.subCategoryKeys || bp.subCategoryKeys.filter(k => k !== "other_input").length === 0)
                                                   missing.push("תת-קטגוריה");
  if (!bp.services || bp.services.length === 0)    missing.push("שירות אחד לפחות");
  if (!bp.targetAudience || bp.targetAudience.length === 0) missing.push("קהל יעד");
  if (!bp.pageGoal)                                missing.push("מטרת דף");
  return { complete: missing.length === 0, missing };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card" style={{ borderTop: "3px solid var(--negative)" }}>
      <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
      <p className="t-body" style={{ marginTop: "var(--s-3)", color: "var(--ink)" }}>{message}</p>
      <div style={{ marginTop: "var(--s-5)" }}>
        <Button onClick={onRetry}>נסה שוב</Button>
      </div>
    </div>
  );
}

