import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateWowAds, getWowAds, regenerateWowAd, approveWowAd, updateWowAdText,
  uploadWowAdImage,
  uploadCampaignSpecialImage,
  generateAdPromotionDescription,
  getClients, resolveImgUrl,
  COIN_COSTS,
  type WowAdItem, type WowAdsSession, type WowAdsStatus,
  type WowAdsCampaignOverrides,
} from "../../api/client";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { IcoRefresh, IcoDownload, IcoAI, IcoAlert, IcoX, IcoEdit, IcoCheck, IcoActivity } from "../icons/Icons";

interface Props {
  phone: string;
  logoUrl?: string;
  /** Quota purchased in the active package — null = unlimited / unknown */
  quota?: number | null;
  /** Current coin balance — used to disable generate when balance < cost. */
  coinsRemaining?: number;
  /** Called after a coin-spending action so the parent can refresh the
   *  package banner's balance display. */
  onCoinsChanged?: () => void;
  /** Called whenever the has-any-approved state changes — parent uses this
   *  to show/hide the "הקמת קמפיין" launch buttons. The launch flow only
   *  uploads approved ads, so as soon as ≥1 ad is approved the manager can
   *  fire a partial campaign without having to approve the rest. */
  onHasAnyApprovedChanged?: (hasAnyApproved: boolean) => void;
  /** Scopes this panel to a specific campaign slot (e.g. "campaign_traffic_0").
   *  Omit for the default paid-ads session. */
  slotKey?: string;
  /** Turns the panel into the "🎯 קמפיין מיוחד" entry point: the modal
   *  is the primary action (no normal generate flow), submit fires a
   *  full 10-ad batch into THIS panel's slotKey (not a random one),
   *  and the modal includes a reference-image uploader. The marketing
   *  panels leave this off — they never display the campaign-מיוחד
   *  button at all. */
  enableCampaignSpecialFlow?: boolean;
}

const STATUS_LABELS: Record<WowAdsStatus, string> = {
  generating_texts:   "מייצר טקסטים (1/3)",
  generating_prompts: "מייצר promptים לתמונות (2/3)",
  generating_images:  "מייצר תמונות (3/3)",
  done:               "הושלם",
  error:              "שגיאה",
};

const TYPE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  regular:   { label: "רגיל",     color: "#1E3A8A", bg: "rgba(30,58,138,0.12)" },
  crazy:     { label: "מטורף",   color: "#DB2777", bg: "rgba(219,39,119,0.12)" },
  carousel:  { label: "קרוסלה",   color: "#7C3AED", bg: "rgba(124,58,237,0.12)" },
};

export function WowAdsPanel({ phone, logoUrl, quota, coinsRemaining, onCoinsChanged, onHasAnyApprovedChanged, slotKey, enableCampaignSpecialFlow }: Props) {
  const toast = useToast();
  const [session, setSession]         = useState<WowAdsSession | null>(null);
  const [loading, setLoading]         = useState(true);
  const [generating, setGenerating]   = useState(false);
  const [regenIds, setRegenIds]         = useState<Set<number>>(new Set());
  const [approveIds, setApproveIds]     = useState<Set<number>>(new Set());
  const [lightboxUrl, setLightboxUrl]   = useState<string | null>(null);
  /* Modal id — clicking a thumbnail opens the full AdSlide popup for that
     specific ad. Storing the id (not the snapshot) keeps the modal in
     sync with edits/regenerations as the session refreshes. */
  const [activeId, setActiveId] = useState<number | null>(null);
  const [resolvedLogoUrl, setResolvedLogoUrl] = useState<string | undefined>(logoUrl);

  // If no logoUrl prop, fetch from client record (server composites from there, not from bp.logoUrl)
  useEffect(() => {
    if (logoUrl) { setResolvedLogoUrl(logoUrl); return; }
    getClients(phone)
      .then(clients => {
        const c = clients.find(cl => cl.phone === phone);
        if (c?.logoUrl) setResolvedLogoUrl(resolveImgUrl(c.logoUrl));
      })
      .catch(() => {});
  }, [phone, logoUrl]);

  const load = useCallback(async () => {
    try {
      const r = await getWowAds(phone, slotKey);
      setSession(r.session);
    } catch (err) {
      console.error(err);
    } finally { setLoading(false); }
  }, [phone, slotKey]);

  useEffect(() => { load(); }, [load]);

  /* Poll while the pipeline is mid-flight OR while any individual ad is
     regenerating in the background (server marks ad.regenerating=true,
     clears it when the new image is ready or the regen errors out). */
  const hasRegeneratingAd = !!session?.generatedAds?.some(a => a.regenerating);
  const pipelineInFlight  = !!(session?.status && session.status !== "done" && session.status !== "error");
  const isInFlight        = pipelineInFlight || hasRegeneratingAd;
  useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(load, 3500);
    return () => clearInterval(id);
  }, [isInFlight, load]);

  /* Notify parent only when the has-any-approved value actually FLIPS.
     Previous version had the callback in the deps, so each parent re-render
     produced a new callback reference, the effect re-fired, the parent's
     setState ran with a new map object, parent re-rendered, and so on — an
     infinite render loop crashing React with error #185. Track the last
     reported value in a ref and call only on transition; keep callback OUT
     of the deps. The gate flips to true as soon as ≥1 ad is approved so the
     manager can launch a partial campaign without approving every slot. */
  const lastHasAnyApprovedRef = useRef<boolean | null>(null);
  useEffect(() => {
    const ads = session?.generatedAds ?? [];
    const hasAnyApproved = ads.some(a => !!a.managerApprovedAt);
    if (lastHasAnyApprovedRef.current !== hasAnyApproved) {
      lastHasAnyApprovedRef.current = hasAnyApproved;
      onHasAnyApprovedChanged?.(hasAnyApproved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /* Drop adIds from regenIds once the server confirms they finished. */
  useEffect(() => {
    if (!session) return;
    setRegenIds(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of Array.from(prev)) {
        const ad = session.generatedAds.find(a => a.id === id);
        if (!ad || !ad.regenerating) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [session]);

  async function start(opts?: {
    quota?: number;
    overrides?: WowAdsCampaignOverrides;
    campaignName?: string;
    slotKeyOverride?: string;
  }) {
    setGenerating(true);
    try {
      const effectiveSlot = opts?.slotKeyOverride ?? slotKey;
      await generateWowAds(phone, {
        slotKey:      effectiveSlot,
        quota:        opts?.quota,
        overrides:    opts?.overrides,
        campaignName: opts?.campaignName,
      });
      const previewMode = opts?.quota === 1;
      toast.ok(
        previewMode
          ? "מייצר מודעה אחת לתצוגה מוקדמת — ~30 שניות"
          : `מתחיל לייצר ${opts?.quota ?? 10} מודעות — תהליך AI ייקח 30–60 שניות`
      );
      await load();
      onCoinsChanged?.();
    } catch (err: any) {
      const msg = err?.message ?? "שגיאה";
      if (msg.includes("חסרים שדות") || msg.includes("INCOMPLETE_PROFILE")) {
        toast.error("האיפיון לא שלם — מלא את כל השדות בטאב 'איפיון'");
      } else if (msg.includes("NO_PACKAGE")) {
        toast.error("ללקוח אין חבילה פעילה — רכוש חבילה בטאב 'חיוב'");
      } else if (msg.includes("INSUFFICIENT_COINS")) {
        toast.error("אין מספיק מטבעות לפעולה זו");
      } else {
        toast.error(msg);
      }
    } finally { setGenerating(false); }
  }

  /* Custom-campaign launcher — opens a modal that collects campaign-
     specific overrides (different color / products / promo) and starts
     a preview run with quota=1. The manager approves the preview, then
     clicks "ייצר עוד 9" to generate the rest with the same overrides
     and slotKey. None of this touches the client's permanent
     characterization. */
  const [campaignOpen, setCampaignOpen] = useState(false);
  /* Form values persisted to localStorage per client so managers don't
     have to re-type the campaign brief every time they reopen the
     modal — especially painful when iterating after a failed preview. */
  const campaignFormStorageKey = `wow-ads-campaign-form:${phone}`;
  const [campaignForm, setCampaignForm] = useState<{
    name: string;
    color: string;
    services: string;
    promotion: string;
    designStyle: string;
    /** Reference photo URLs (already uploaded to B2 via the campaign-
     *  special upload endpoint). Passed to the wow-ads pipeline as
     *  overrides.images — first 3 are used by the controller. */
    images: string[];
  }>(() => {
    try {
      const raw = localStorage.getItem(campaignFormStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return {
            name:        typeof parsed.name === "string" ? parsed.name : "",
            color:       typeof parsed.color === "string" ? parsed.color : "",
            services:    typeof parsed.services === "string" ? parsed.services : "",
            promotion:   typeof parsed.promotion === "string" ? parsed.promotion : "",
            designStyle: typeof parsed.designStyle === "string" ? parsed.designStyle : "",
            images:      Array.isArray(parsed.images) ? parsed.images.filter((x: unknown) => typeof x === "string") : [],
          };
        }
      }
    } catch { /* malformed storage — fall through to defaults */ }
    return { name: "", color: "", services: "", promotion: "", designStyle: "", images: [] };
  });
  const [uploadingImage, setUploadingImage] = useState(false);

  /* Write-through to localStorage on every change so closing the modal
     mid-edit doesn't lose anything. Strips trailing whitespace on save
     so we don't persist accidental space-only edits. */
  useEffect(() => {
    try {
      localStorage.setItem(campaignFormStorageKey, JSON.stringify(campaignForm));
    } catch { /* storage full or denied — silently skip */ }
  }, [campaignForm, campaignFormStorageKey]);

  async function submitCampaignPreview() {
    if (!campaignForm.name.trim()) { toast.error("חסר שם קמפיין"); return; }
    if (!campaignForm.promotion.trim() && !campaignForm.services.trim()) {
      toast.error("חסר טקסט מבצע או רשימת מוצרים"); return;
    }
    const overrides: WowAdsCampaignOverrides = {};
    if (campaignForm.color)       overrides.preferredColors = { primary: campaignForm.color };
    if (campaignForm.services)    overrides.services        = campaignForm.services;
    if (campaignForm.promotion)   overrides.promotion       = campaignForm.promotion;
    if (campaignForm.designStyle) overrides.designStyle     = campaignForm.designStyle;
    if (campaignForm.images.length > 0) overrides.images    = campaignForm.images;

    /* Submit fires a FULL 10-ad batch into this panel's own slotKey —
       reuses the panel, overwriting any prior campaign-מיוחד session
       there. No preview/approve/generate-more split. */
    setCampaignOpen(false);
    await start({
      quota: 10,
      overrides,
      campaignName: campaignForm.name,
    });
  }

  /* Upload one reference photo to B2 and push its URL into the form.
     Limited to 3 total — anything more and the campaign images.edit
     call hangs past timeout (see wow-ads.controller image-ref cap). */
  async function handleCampaignImageUpload(file: File) {
    if (campaignForm.images.length >= 3) {
      toast.warn("מקסימום 3 תמונות לקמפיין");
      return;
    }
    setUploadingImage(true);
    try {
      const { url } = await uploadCampaignSpecialImage(phone, file);
      setCampaignForm(f => ({ ...f, images: [...f.images, url] }));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "העלאת התמונה נכשלה");
    } finally {
      setUploadingImage(false);
    }
  }

  function removeCampaignImage(idx: number) {
    setCampaignForm(f => ({ ...f, images: f.images.filter((_, i) => i !== idx) }));
  }


  async function toggleApprove(adId: number, currentlyApproved: boolean) {
    setApproveIds(prev => new Set(prev).add(adId));
    try {
      const r = await approveWowAd(phone, adId, !currentlyApproved, slotKey);
      setSession(prev => prev ? {
        ...prev,
        generatedAds: prev.generatedAds.map(a => a.id === adId ? r.ad : a),
      } : prev);
      toast.ok(!currentlyApproved ? "מודעה אושרה ✓" : "אישור בוטל");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה באישור");
    } finally {
      setApproveIds(prev => { const n = new Set(prev); n.delete(adId); return n; });
    }
  }

  async function saveEdit(adId: number, fields: Partial<{ headline: string; description: string; cta: string }>) {
    try {
      const r = await updateWowAdText(phone, adId, fields, slotKey);
      setSession(prev => prev ? {
        ...prev,
        generatedAds: prev.generatedAds.map(a => a.id === adId ? r.ad : a),
      } : prev);
      toast.ok("מודעה עודכנה");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בשמירה");
    }
  }

  async function uploadImage(adId: number, file: File) {
    try {
      const r = await uploadWowAdImage(phone, adId, file, slotKey);
      setSession(prev => prev ? {
        ...prev,
        generatedAds: prev.generatedAds.map(a => a.id === adId ? r.ad : a),
      } : prev);
      toast.ok("תמונה הועלתה בהצלחה");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה בהעלאת תמונה");
    }
  }

  async function generatePromotion(adId: number) {
    try {
      const r = await generateAdPromotionDescription(phone, adId, slotKey);
      setSession(prev => prev ? {
        ...prev,
        generatedAds: prev.generatedAds.map(a => a.id === adId ? r.ad : a),
      } : prev);
      toast.ok("תיאור הפרסום נוצר");
    } catch (err: any) {
      toast.error(err?.message ?? "שגיאה ביצירת תיאור");
      throw err;
    }
  }

  async function regenerate(adId: number, changeRequest?: string) {
    setRegenIds(prev => new Set(prev).add(adId));
    try {
      /* Server kicks off the work async (Heroku H12 = 30s) and returns 202.
         The polling effect picks up ad.regenerating from the session and
         clears regenIds when the server flips it back to false. */
      await regenerateWowAd(phone, adId, changeRequest, slotKey);
      await load();
      toast.ok(changeRequest ? "עריכה בתהליך — נטען בעוד מספר שניות" : "רענון בתהליך — נטען בעוד מספר שניות");
      onCoinsChanged?.();
    } catch (err: any) {
      setRegenIds(prev => { const n = new Set(prev); n.delete(adId); return n; });
      const msg = err?.message ?? "שגיאה ברענון";
      if (msg.includes("INSUFFICIENT_COINS")) toast.error("אין מספיק מטבעות לרענון");
      else toast.error(msg);
    }
  }

  const ads = session?.generatedAds ?? [];
  const activeAd = activeId !== null ? ads.find(a => a.id === activeId) ?? null : null;
  const ready = session?.status === "done";
  const errored = session?.status === "error";

  if (loading) {
    return (
      <div style={{ padding: "var(--s-7)", textAlign: "center", color: "var(--ink-3)" }}>
        טוען...
      </div>
    );
  }

  return (
    <section className="section" style={{ marginTop: 0 }}>

      {/* ── Header banner ── */}
      <div className="card" style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        borderTop: "3px solid var(--blue)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div style={{
            width: 48, height: 48, borderRadius: "var(--r-2)",
            background: "var(--blue)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <IcoAI size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--cyan-2)", letterSpacing: "0.14em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>WOW Ads · {quota != null ? `${quota} מודעות שיווקיות` : "10 מודעות שיווקיות"}</span>
              {quota != null && ads.length > 0 && (
                <span style={{
                  textTransform: "none",
                  letterSpacing: "normal",
                  color: ads.length >= quota ? "var(--negative)" : "var(--ink-3)",
                  fontSize: 11,
                  fontWeight: 700,
                }}>
                  · {ads.length}/{quota} בשימוש
                </span>
              )}
            </div>
            <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: "4px 0 0" }}>
              {session ? STATUS_LABELS[session.status] : `ייצור ${quota ?? 10} מודעות שיווקיות`}
            </h3>
            <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
              {!session && "OpenAI מייצר טקסטים מותאמים, וGemini מייצר תמונה 1080×1080 לכל אחד."}
              {session && isInFlight && `${session.completedCount}/${session.totalAds} מודעות מוכנות`}
              {ready && `${ads.filter(a => a.imageUrl).length}/${ads.length} מודעות הושלמו בהצלחה`}
              {errored && (session.error || "תקלה בייצור — נסה שוב")}
            </p>
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            {(!session || ready || errored) && (() => {
              const quotaFull   = quota != null && ads.length >= quota;
              const lowOnCoins  = coinsRemaining != null && coinsRemaining < COIN_COSTS.GENERATE_ADS;
              const label = quotaFull
                ? "מכסה מולאה"
                : lowOnCoins
                  ? `אין מספיק מטבעות (−${COIN_COSTS.GENERATE_ADS})`
                  : ready
                    ? `ייצר מחדש (−${COIN_COSTS.GENERATE_ADS})`
                    : `ייצר ${quota ?? 10} מודעות (−${COIN_COSTS.GENERATE_ADS})`;
              return (
                <Button
                  onClick={() => start()}
                  loading={generating}
                  size="lg"
                  disabled={quotaFull || lowOnCoins}
                  style={{ background: "var(--blue)", color: "#fff", border: "none" }}
                  title={`עלות: ${COIN_COSTS.GENERATE_ADS} מטבעות${coinsRemaining != null ? ` · יתרה: ${coinsRemaining}` : ""}`}
                >
                  {label}
                </Button>
              );
            })()}
            {/* "🎯 קמפיין מיוחד" launcher — visible ONLY when this
                panel is the dedicated campaign-מיוחד section. Opens
                the brief modal; submit fires a full 10-ad batch into
                this panel's own slotKey (overwrites prior campaign). */}
            {enableCampaignSpecialFlow && (!session || ready || errored) && (
              <Button
                onClick={() => setCampaignOpen(true)}
                size="lg"
                style={{ background: "linear-gradient(135deg, #db2777 0%, #be185d 100%)", color: "#fff", border: "none" }}
                title="קמפיין חד-פעמי בצבעים/מוצרים שונים מהאיפיון הקבוע"
              >
                🎯 קמפיין מיוחד
              </Button>
            )}
            {isInFlight && <span className="pulse-dot" style={{ alignSelf: "center" }} />}
          </div>
        </div>

        {isInFlight && (
          <div style={{ marginTop: "var(--s-4)" }}>
            <div style={{ height: 6, background: "var(--bg-tint)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${session ? Math.max(8, (session.completedCount / session.totalAds) * 100) : 0}%`,
                background: "var(--blue)",
                transition: "width 600ms var(--ease-out)",
                boxShadow: "0 0 12px rgba(6,182,212,0.5)",
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Ads as a thumbnail grid — click opens a Modal with the full AdSlide ── */}
      {ads.length > 0 && (
        <div
          role="list"
          aria-label="גלריית מודעות שיווקיות"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: "var(--s-3)",
          }}
        >
          {ads.map((ad, i) => (
            <AdThumbnail
              key={ad.id}
              ad={ad}
              index={i + 1}
              total={ads.length}
              regenerating={regenIds.has(ad.id) || !!ad.regenerating}
              onClick={() => setActiveId(ad.id)}
            />
          ))}
        </div>
      )}

      <Modal
        open={!!activeAd}
        onClose={() => setActiveId(null)}
        size="xl"
        eyebrow="מודעה"
        title={activeAd ? `מודעה ${ads.findIndex(a => a.id === activeAd.id) + 1} מתוך ${ads.length}` : ""}
      >
        {activeAd && (
          <AdSlide
            ad={activeAd}
            index={ads.findIndex(a => a.id === activeAd.id)}
            total={ads.length}
            logoUrl={resolvedLogoUrl}
            regenerating={regenIds.has(activeAd.id) || !!activeAd.regenerating}
            approving={approveIds.has(activeAd.id)}
            onRegenerate={() => regenerate(activeAd.id)}
            onRegenerateWithRequest={(req) => regenerate(activeAd.id, req)}
            onApprove={() => toggleApprove(activeAd.id, !!activeAd.managerApprovedAt)}
            onSaveEdit={(fields) => saveEdit(activeAd.id, fields)}
            onUploadImage={(file) => uploadImage(activeAd.id, file)}
            onGeneratePromotion={() => generatePromotion(activeAd.id)}
            disabled={isInFlight && !activeAd.imageUrl}
            onImageClick={setLightboxUrl}
          />
        )}
      </Modal>

      {/* ── Empty state ── */}
      {!session && (
        <div className="empty" style={{ marginTop: "var(--s-5)" }}>
          <p className="empty-title">עדיין לא יוצרו מודעות</p>
          <p className="empty-meta">
            לחץ "ייצר 10 מודעות" — ה-AI ינתח את האיפיון של הלקוח ויפיק 10 וריאציות בעברית עם תמונות 1080×1080.
          </p>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightboxUrl && (
        <div
          onClick={() => setLightboxUrl(null)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.88)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999, cursor: "zoom-out",
          }}
        >
          <img
            src={lightboxUrl}
            alt="מודעה"
            style={{
              maxWidth: "min(90vw, 600px)", maxHeight: "90vh",
              borderRadius: "var(--r-3)",
              boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
              objectFit: "contain",
            }}
          />
          <button
            onClick={e => { e.stopPropagation(); setLightboxUrl(null); }}
            style={{
              position: "absolute", top: 20, right: 20,
              width: 40, height: 40, borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "#fff", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <IcoX size={18} color="#fff" />
          </button>
        </div>
      )}

      {/* Campaign-launcher modal — collects the override fields and
          starts a preview run with quota=1. */}
      {campaignOpen && (
        <Modal open={campaignOpen} onClose={() => setCampaignOpen(false)} title="🎯 קמפיין מיוחד">
          <div style={{ display: "grid", gap: "var(--s-4)", padding: "var(--s-3)" }}>
            <p style={{ margin: 0, fontSize: "var(--t-sm)", color: "var(--ink-3)", lineHeight: 1.5 }}>
              קמפיין חד-פעמי לא משנה את האיפיון הקבוע של הלקוח. השדות שלמטה גוברים על האיפיון לסשן הזה בלבד. נייצר <strong>מודעה אחת</strong> לתצוגה מוקדמת — אחרי שאתה מאשר, כפתור "ייצר עוד 9" יייצר את היתר.
            </p>

            <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
              <span style={{ color: "var(--ink-2)" }}>שם הקמפיין</span>
              <input
                value={campaignForm.name}
                onChange={e => setCampaignForm(f => ({ ...f, name: e.target.value }))}
                placeholder="לדוגמה: מונדיאל לילי 22:00"
                style={{ padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)" }}
                autoFocus
              />
            </label>

            <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
              <span style={{ color: "var(--ink-2)" }}>צבע ראשי לקמפיין (HEX)</span>
              <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                <input
                  type="color"
                  value={campaignForm.color || "#0066CC"}
                  onChange={e => setCampaignForm(f => ({ ...f, color: e.target.value }))}
                  style={{ width: 48, height: 36, border: "1px solid var(--rule)", borderRadius: "var(--r-2)", padding: 2, background: "transparent" }}
                />
                <input
                  value={campaignForm.color}
                  onChange={e => setCampaignForm(f => ({ ...f, color: e.target.value }))}
                  placeholder="#0066CC (השאר ריק לצבע המותג)"
                  style={{ flex: 1, padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)" }}
                  dir="ltr"
                />
              </div>
            </label>

            <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
              <span style={{ color: "var(--ink-2)" }}>מוצרים / שירותים לקמפיין</span>
              <textarea
                value={campaignForm.services}
                onChange={e => setCampaignForm(f => ({ ...f, services: e.target.value }))}
                placeholder="לדוגמה: Art Burger / Old School / Chicken Sandwich + צ׳יפס + שתיה — 59₪"
                rows={3}
                style={{ padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", resize: "vertical", fontFamily: "inherit" }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
              <span style={{ color: "var(--ink-2)" }}>מבצע / קופי שיווקי</span>
              <textarea
                value={campaignForm.promotion}
                onChange={e => setCampaignForm(f => ({ ...f, promotion: e.target.value }))}
                placeholder='לדוגמה: "מונדיאל לילי 22:00 → סגירה. ראשון-חמישי. בירה מהחבית 1/3 ב-5₪ למזמיני ארוחות מיוחדות"'
                rows={3}
                style={{ padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)", resize: "vertical", fontFamily: "inherit" }}
              />
            </label>

            <label style={{ display: "grid", gap: 4, fontSize: "var(--t-sm)" }}>
              <span style={{ color: "var(--ink-2)" }}>סגנון עיצובי (אופציונלי)</span>
              <input
                value={campaignForm.designStyle}
                onChange={e => setCampaignForm(f => ({ ...f, designStyle: e.target.value }))}
                placeholder="לדוגמה: אנרגי לילי דרמטי, גוונים עמוקים"
                style={{ padding: "var(--s-2) var(--s-3)", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontSize: "var(--t-sm)" }}
              />
            </label>

            {/* Reference image upload — manager can attach up to 3 photos
                of the actual product/promo; these flow into the wow-ads
                pipeline as image refs (overrides.images) so gpt-image-2
                anchors the creative on the real subject instead of
                inventing one. JPG/PNG/WEBP, 20 MB cap per file. */}
            <div style={{ display: "grid", gap: "var(--s-2)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ color: "var(--ink-2)", fontSize: "var(--t-sm)" }}>
                  תמונות רפרנס לקמפיין ({campaignForm.images.length}/3)
                </span>
                <label style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "6px 12px", borderRadius: "var(--r-2)",
                  border: "1px dashed var(--blue)", color: "var(--blue)",
                  cursor: campaignForm.images.length >= 3 || uploadingImage ? "not-allowed" : "pointer",
                  fontSize: "var(--t-sm)", background: "transparent",
                  opacity: campaignForm.images.length >= 3 || uploadingImage ? 0.4 : 1,
                }}>
                  {uploadingImage ? "מעלה..." : "+ הוסף תמונה"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: "none" }}
                    disabled={campaignForm.images.length >= 3 || uploadingImage}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) handleCampaignImageUpload(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {campaignForm.images.length > 0 && (
                <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
                  {campaignForm.images.map((url, idx) => (
                    <div key={idx} style={{ position: "relative", width: 88, height: 88, borderRadius: "var(--r-2)", overflow: "hidden", border: "1px solid var(--rule)" }}>
                      <img src={resolveImgUrl(url)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      <button
                        type="button"
                        onClick={() => removeCampaignImage(idx)}
                        style={{
                          position: "absolute", top: 4, right: 4,
                          width: 22, height: 22, borderRadius: 99,
                          background: "rgba(0,0,0,0.7)", color: "#fff", border: "none",
                          cursor: "pointer", fontSize: 14, lineHeight: 1,
                        }}
                        title="מחק"
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
              <Button variant="ghost" onClick={() => setCampaignOpen(false)}>ביטול</Button>
              <Button
                onClick={submitCampaignPreview}
                loading={generating || uploadingImage}
                style={{ background: "var(--blue)", color: "#fff", border: "none" }}
              >
                ייצר 10 מודעות
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ── Ad Thumbnail ─────────────────────────────────────────────────────
   Square image tile shown in the grid above the modal. Mirrors the
   WowOrganicPanel's PostThumbnail so the two flows feel identical.
   Click opens the AdSlide in a Modal. */
function AdThumbnail({ ad, index, total, regenerating, onClick }: {
  ad: WowAdItem;
  index: number;
  total: number;
  regenerating: boolean;
  onClick: () => void;
}) {
  const isApproved = !!ad.managerApprovedAt;
  const imgUrl     = resolveImgUrl(ad.imageUrl);
  const hasImage   = !!imgUrl;
  return (
    <button
      type="button"
      role="listitem"
      onClick={onClick}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        border: isApproved ? "2px solid var(--positive)" : "1px solid var(--rule)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        cursor: "pointer",
        padding: 0,
        background: "var(--bg-tint)",
        transition: "transform 150ms var(--ease-out), box-shadow 150ms var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 8px 24px rgba(11,20,48,0.12)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "";
        e.currentTarget.style.boxShadow = "";
      }}
      aria-label={`מודעה ${index} מתוך ${total}${isApproved ? " — מאושרת" : ""}`}
    >
      {hasImage ? (
        <img
          src={imgUrl}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div style={{
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--ink-4)",
        }}>
          <IcoAI size={32} />
        </div>
      )}

      {/* Index badge — physical top-right */}
      <span style={{
        position: "absolute", top: 6, right: 6,
        background: "rgba(11,20,48,0.75)", color: "#fff",
        fontSize: 11, fontWeight: 700,
        padding: "2px 6px", borderRadius: 6,
        backdropFilter: "blur(4px)",
      }} dir="ltr">{index}/{total}</span>

      {/* Approved check — physical top-left */}
      {isApproved && (
        <span style={{
          position: "absolute", top: 6, left: 6,
          width: 24, height: 24,
          background: "var(--positive)", color: "#fff",
          borderRadius: 99,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
        }}>
          <IcoCheck size={14} />
        </span>
      )}

      {/* Status overlays */}
      {regenerating && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(255,255,255,0.7)", backdropFilter: "blur(2px)",
        }}>
          <IcoActivity size={28} />
        </div>
      )}
      {ad.error && !regenerating && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(254,243,199,0.85)", color: "var(--warning)",
        }}>
          <IcoAlert size={28} />
        </div>
      )}
    </button>
  );
}

/* ── Ad Slide ──────────────────────────────────────────────────────── */
function AdSlide({ ad, index, total, logoUrl, regenerating, approving, onRegenerate, onRegenerateWithRequest, onApprove, onSaveEdit, onUploadImage, onGeneratePromotion, disabled, onImageClick }: {
  ad: WowAdItem;
  index: number;
  total: number;
  logoUrl?: string;
  regenerating: boolean;
  approving: boolean;
  onRegenerate: () => void;
  onRegenerateWithRequest: (changeRequest: string) => void;
  onApprove: () => void;
  onSaveEdit: (fields: Partial<{ headline: string; description: string; cta: string }>) => void;
  onUploadImage: (file: File) => Promise<void>;
  onGeneratePromotion: () => Promise<void>;
  disabled?: boolean;
  onImageClick: (url: string) => void;
}) {
  const typeMeta        = TYPE_LABELS[ad.type] ?? { label: ad.type, color: "var(--ink-3)", bg: "var(--bg-tint)" };
  const resolvedImgUrl  = resolveImgUrl(ad.imageUrl);
  const hasImage        = !!resolvedImgUrl;
  const isApproved      = !!ad.managerApprovedAt;

  const [editing, setEditing]           = useState(false);
  const [headline, setHeadline]         = useState(ad.headline);
  const [description, setDescription]  = useState(ad.description);
  const [cta, setCta]                   = useState(ad.cta);
  const [promoBusy, setPromoBusy]       = useState(false);
  const [promoCopied, setPromoCopied]   = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [editImageMode, setEditImageMode] = useState(false);
  const [changeRequest, setChangeRequest] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleGeneratePromo() {
    if (promoBusy) return;
    setPromoBusy(true);
    try { await onGeneratePromotion(); }
    finally { setPromoBusy(false); }
  }
  async function copyPromo() {
    if (!ad.promotionDescription) return;
    try {
      await navigator.clipboard.writeText(ad.promotionDescription);
      setPromoCopied(true);
      setTimeout(() => setPromoCopied(false), 1800);
    } catch { /* clipboard rejected — ignore */ }
  }

  function cancelEdit() {
    setHeadline(ad.headline);
    setDescription(ad.description);
    setCta(ad.cta);
    setEditing(false);
  }

  function saveEdit() {
    onSaveEdit({ headline, description, cta });
    setEditing(false);
  }

  return (
    <div style={{
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      overflow: "hidden",
      display: "flex",
      minHeight: 320,
      boxShadow: "var(--sh-1)",
    }}>
      {/* ── Left: Image (or 2×2 carousel grid for carousel ads) ── */}
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          width: "min(340px, 42%)",
          background: "var(--bg-tint)",
          cursor: hasImage && !ad.slides ? "zoom-in" : "default",
        }}
        onClick={() => hasImage && !ad.slides && onImageClick(resolvedImgUrl!)}
      >
        {Array.isArray(ad.slides) && ad.slides.length > 0 ? (
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gridTemplateRows:    "1fr 1fr",
            gap: 2,
            width: "100%", height: "100%",
            background: "var(--bg-tint)",
          }}>
            {ad.slides.map((slide, sIdx) => {
              const url = resolveImgUrl(slide.imageUrl);
              return (
                <div
                  key={slide.id}
                  onClick={(e) => { e.stopPropagation(); if (url) onImageClick(url); }}
                  style={{
                    position: "relative",
                    background: "var(--bg-tint)",
                    cursor: url ? "zoom-in" : "default",
                    overflow: "hidden",
                  }}
                >
                  {url ? (
                    <img
                      src={url}
                      alt={`Slide ${slide.id}`}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      loading="lazy"
                    />
                  ) : slide.error ? (
                    <div style={{
                      width: "100%", height: "100%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "var(--negative)", fontSize: 10, padding: 6, textAlign: "center",
                    }}>{slide.error}</div>
                  ) : (
                    <div className="skeleton" style={{ width: "100%", height: "100%" }} />
                  )}
                  <span style={{
                    position: "absolute", top: 4, insetInlineStart: 4,
                    fontSize: 9, fontWeight: 800,
                    padding: "1px 6px",
                    background: "rgba(0,0,0,0.55)", color: "#fff",
                    borderRadius: 999,
                    backdropFilter: "blur(6px)",
                  }}>{sIdx + 1}/{ad.slides!.length}</span>
                </div>
              );
            })}
          </div>
        ) : hasImage ? (
          <img
            src={resolvedImgUrl}
            alt={`Ad ${ad.id}`}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            loading="lazy"
          />
        ) : ad.error ? (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 8, padding: 24, color: "var(--negative)",
          }}>
            <IcoAlert size={32} />
            <p style={{ fontSize: 12, textAlign: "center", color: "var(--ink-3)" }}>{ad.error}</p>
          </div>
        ) : disabled ? (
          <div className="skeleton" style={{ width: "100%", height: "100%", borderRadius: 0 }} />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--ink-4)", fontSize: 12,
          }}>
            ממתין...
          </div>
        )}

        {/* Ad counter badge */}
        <div style={{
          position: "absolute", top: 10, right: 10,
          fontSize: 10, fontWeight: 800,
          padding: "3px 8px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          borderRadius: 999,
          backdropFilter: "blur(6px)",
        }}>
          {index + 1} / {total}
        </div>

        {hasImage && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            padding: "20px 10px 6px",
            background: "linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 100%)",
            fontSize: 10, color: "rgba(255,255,255,0.85)",
            textAlign: "center", fontWeight: 600,
          }}>
            לחץ לתצוגה מלאה
          </div>
        )}
      </div>

      {/* ── Right: Content ── */}
      <div style={{
        flex: 1,
        padding: "var(--s-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-4)",
        justifyContent: "space-between",
      }}>
        {/* Top: badges + logo */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontSize: 10, fontWeight: 700,
              padding: "3px 10px",
              background: typeMeta.bg, color: typeMeta.color,
              borderRadius: 999,
              border: `1px solid ${typeMeta.color}30`,
            }}>
              {typeMeta.label}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 600,
              padding: "3px 10px",
              background: "var(--bg-tint)", color: "var(--ink-3)",
              borderRadius: 999,
              border: "1px solid var(--rule)",
            }}>
              #{ad.id}
            </span>
          </div>
          {logoUrl && (
            <img
              src={logoUrl}
              alt=""
              style={{ height: 36, width: "auto", maxWidth: 100, objectFit: "contain", borderRadius: 6, flexShrink: 0, border: "1px solid var(--rule)" }}
            />
          )}
        </div>

        {/* Headline */}
        {editing ? (
          <input
            value={headline}
            onChange={e => setHeadline(e.target.value)}
            style={{
              width: "100%", fontSize: "var(--t-lg)", fontWeight: 800,
              color: "var(--ink)", border: "1px solid var(--blue)",
              borderRadius: "var(--r-1)", padding: "4px 8px",
              background: "var(--surface)", outline: "none",
            }}
          />
        ) : (
          <p style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", lineHeight: 1.3, margin: 0 }}>
            {ad.headline}
          </p>
        )}

        {/* Description */}
        {editing ? (
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={4}
            style={{
              width: "100%", fontSize: "var(--t-sm)", color: "var(--ink-2)",
              lineHeight: 1.7, resize: "vertical",
              border: "1px solid var(--blue)", borderRadius: "var(--r-1)",
              padding: "4px 8px", background: "var(--surface)", outline: "none",
            }}
          />
        ) : (
          <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.7, margin: 0, flex: 1 }}>
            {ad.description}
          </p>
        )}

        {/* Promotion-ready ad copy — for posting alongside the image on Meta/Facebook.
            Doesn't appear on the image. Generated on-demand, kept persistent. */}
        <div style={{
          marginTop: "var(--s-2)",
          padding: "var(--s-3)",
          background: "var(--blue-soft)",
          border: "1px dashed rgba(0,115,234,0.3)",
          borderRadius: "var(--r-2)",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 8, marginBottom: ad.promotionDescription ? 8 : 0,
          }}>
            <p style={{
              margin: 0, fontSize: 11, fontWeight: 800,
              color: "var(--blue)", letterSpacing: "0.06em", textTransform: "uppercase",
            }}>
              📋 תיאור לפרסום ב-Meta / פייסבוק
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              {ad.promotionDescription && (
                <ActionBtn onClick={copyPromo} color={promoCopied ? "var(--positive)" : undefined}>
                  <IcoCheck size={12} /> {promoCopied ? "הועתק!" : "העתק"}
                </ActionBtn>
              )}
              <ActionBtn onClick={handleGeneratePromo} disabled={promoBusy}>
                <IcoAI size={12} className={promoBusy ? "spin" : undefined} />
                {promoBusy ? "מייצר..." : ad.promotionDescription ? "צור מחדש" : "צור תיאור פרסומי"}
              </ActionBtn>
            </div>
          </div>
          {ad.promotionDescription ? (
            <p style={{
              margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--ink)",
              whiteSpace: "pre-wrap",
            }}>{ad.promotionDescription}</p>
          ) : promoBusy ? (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-3)", fontStyle: "italic" }}>
              מייצר…
            </p>
          ) : null}
        </div>

        {/* CTA row */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flexWrap: "wrap" }}>
          {editing ? (
            <input
              value={cta}
              onChange={e => setCta(e.target.value)}
              style={{
                fontSize: "var(--t-sm)", fontWeight: 800,
                padding: "7px 14px", width: 160,
                border: "1px solid var(--blue)", borderRadius: "var(--r-2)",
                background: "var(--surface)", outline: "none", color: "var(--ink)",
              }}
            />
          ) : (
            <span style={{
              fontSize: "var(--t-sm)", fontWeight: 800,
              padding: "8px 20px",
              background: "var(--blue)", color: "#fff",
              borderRadius: "var(--r-2)",
            }}>
              {ad.cta}
            </span>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: "var(--s-2)", marginInlineStart: "auto", flexWrap: "wrap" }}>

            {/* Edit / Save / Cancel */}
            {editing ? (
              <>
                <ActionBtn onClick={saveEdit} color="var(--positive)">
                  <IcoCheck size={13} /> שמור
                </ActionBtn>
                <ActionBtn onClick={cancelEdit}>
                  <IcoX size={13} /> ביטול
                </ActionBtn>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploading(true);
                    try { await onUploadImage(file); }
                    finally { setUploading(false); e.target.value = ""; }
                  }}
                />
                <ActionBtn onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  📎 {uploading ? "מעלה..." : "העלה תמונה"}
                </ActionBtn>
              </>
            ) : (
              <ActionBtn onClick={() => setEditing(true)}>
                <IcoEdit size={13} /> ערוך
              </ActionBtn>
            )}

            {/* Approve */}
            <ActionBtn
              onClick={onApprove}
              disabled={approving}
              color={isApproved ? "var(--positive)" : undefined}
              fill={isApproved}
            >
              <IcoCheck size={13} className={approving ? "spin" : undefined} />
              {approving ? "..." : isApproved ? "מאושר ✓" : "אשר מודעה"}
            </ActionBtn>

            {/* Edit image with change request */}
            {editImageMode ? (
              <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", flex: 1 }}>
                <textarea
                  autoFocus
                  value={changeRequest}
                  onChange={e => setChangeRequest(e.target.value)}
                  placeholder="מה תרצה לשנות בתמונה?"
                  rows={2}
                  style={{
                    flex: 1, resize: "none", direction: "rtl",
                    fontSize: 13, padding: "6px 10px",
                    border: "1px solid var(--blue)", borderRadius: "var(--r-2)",
                    background: "var(--surface)", color: "var(--ink)", outline: "none",
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      if (changeRequest.trim()) {
                        onRegenerateWithRequest(changeRequest.trim());
                        setChangeRequest("");
                        setEditImageMode(false);
                      }
                    }
                  }}
                />
                <ActionBtn
                  onClick={() => {
                    if (!changeRequest.trim()) return;
                    onRegenerateWithRequest(changeRequest.trim());
                    setChangeRequest("");
                    setEditImageMode(false);
                  }}
                  disabled={!changeRequest.trim() || regenerating}
                  color="var(--blue)"
                  fill
                >
                  <IcoRefresh size={13} /> שלח
                </ActionBtn>
                <ActionBtn onClick={() => { setEditImageMode(false); setChangeRequest(""); }}>
                  <IcoX size={13} /> ביטול
                </ActionBtn>
              </div>
            ) : (
              <ActionBtn onClick={() => setEditImageMode(true)} disabled={regenerating}>
                ✏️ ערוך תמונה
              </ActionBtn>
            )}

            {/* Refresh */}
            {!editImageMode && (
              <ActionBtn onClick={onRegenerate} disabled={regenerating}>
                <IcoRefresh size={13} className={regenerating ? "spin" : undefined} />
                {regenerating ? "מייצר..." : "רענן"}
              </ActionBtn>
            )}

            {/* Download */}
            {hasImage && (
              <a
                href={resolvedImgUrl}
                download={`wow_ad_${ad.id}.png`}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "7px 12px",
                  background: "var(--bg-tint)", color: "var(--ink-2)",
                  border: "1px solid var(--rule-strong)", borderRadius: "var(--r-2)",
                  fontSize: 12, fontWeight: 700, textDecoration: "none",
                  display: "flex", alignItems: "center", gap: 4, transition: "all 150ms",
                }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--blue-soft)"}
                onMouseLeave={e => e.currentTarget.style.background = "var(--bg-tint)"}
              >
                <IcoDownload size={13} /> הורד
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ActionBtn ─────────────────────────────────────────────────────── */
function ActionBtn({ onClick, disabled, color, fill, children }: {
  onClick: () => void;
  disabled?: boolean;
  color?: string;
  fill?: boolean;
  children: React.ReactNode;
}) {
  const base = fill
    ? { background: color ?? "var(--blue)", color: "#fff", border: `1px solid ${color ?? "var(--blue)"}` }
    : { background: "var(--bg-tint)", color: color ?? "var(--ink-2)", border: "1px solid var(--rule-strong)" };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "7px 12px",
        ...base,
        borderRadius: "var(--r-2)",
        fontSize: 12, fontWeight: 700,
        cursor: disabled ? "wait" : "pointer",
        display: "flex", alignItems: "center", gap: 4,
        opacity: disabled ? 0.6 : 1,
        transition: "all 150ms",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
