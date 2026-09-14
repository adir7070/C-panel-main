import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type BusinessProfile,
  type ServiceItem,
  type OrganicSlot,
  type AvatarConfig,
  type FbTargeting,
  type FbStatus,
  getCharacterization,
  updateCharacterization,
  resolveImgUrl,
  getClientPackage,
  generateWowAds,
  generateWowOrganic,
  generateWowLp,
  expandAboutWithAI,
  spellcheckTexts,
  suggestServicesWithAI,
  getFbStatus,
  isFbUnavailable,
  markCharacterizationComplete,
} from "../../api/client";
import { FbConnectModal } from "../modals/FbConnectModal";
import { useApi } from "../../hooks/useApi";
import { useToast } from "../../context/ToastContext";
import { CATEGORIES, categoryByKey } from "../../data/categories";
import { PAGE_GOAL_OPTIONS, TARGET_AUDIENCE_OPTIONS } from "../../data/options";
import { SectionHead } from "../ui/SectionHead";
import { Spinner } from "../ui/Spinner";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/Field";
import { Input, Textarea } from "../ui/Input";
import { Badge } from "../ui/Badge";
import { Accordion } from "../ui/Accordion";
/* CategoryPicker (modal) replaced by the inline CategoryInlinePicker
   defined further down — keep the file around in case other tabs
   still mount it, but don't import here. */
import { AvatarDesigner } from "../pickers/AvatarDesigner";
import { LogoGenerator } from "../pickers/LogoGenerator";
import { TargetingEditor, targetingSummary } from "../pickers/TargetingEditor";
import {
  CampaignIcon,
  IcoPalette,
  IcoPerson,
  IcoCrosshair,
  IcoSparkle,
  IcoInbox,
  IcoCheck,
  IcoXMark,
} from "../icons/BrandIcons";
import { IcoEye } from "../icons/Icons";

interface Props { phone: string }

interface Service {
  id: string;
  title: string;
  description: string;
  price: string;
  uniqueFeature: string;
  notes: string;
  imageUrl: string;
  /* Up to 3 photos per service. imageUrl mirrors images[0] (the primary the
     ad/LP pipeline reads). Shared field with the mobile app for sync. */
  images: string[];
  promotion: string;
  campaignType: string;
  targetAudience: string[];
  targetingDetailed?: FbTargeting;
}

const CAMPAIGN_OBJECTIVES: { id: string; label: string; emoji: string }[] = [
  { id: "LEAD_GENERATION", label: "לידים",    emoji: "🎯" },
  { id: "CONVERSIONS",     label: "המרות",    emoji: "⚡" },
  { id: "MESSAGES",        label: "הודעות",   emoji: "💬" },
  { id: "TRAFFIC",         label: "תנועה",    emoji: "🌐" },
  { id: "REACH",           label: "חשיפה",    emoji: "📢" },
  { id: "BRAND_AWARENESS", label: "מודעות",   emoji: "✨" },
  { id: "ENGAGEMENT",      label: "מעורבות",  emoji: "❤️" },
];

const ORGANIC_SLOTS = 5;

/* Ad language (business_profiles.language). Drives multi-language ad + post
   generation server-side; default Hebrew. Keep codes in sync with the server's
   services/ad-languages.service.js. */
const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: "he", label: "🇮🇱 עברית" },
  { code: "en", label: "🇬🇧 English" },
  { code: "ar", label: "🇸🇦 العربية" },
  { code: "ru", label: "🇷🇺 Русский" },
  { code: "fr", label: "🇫🇷 Français" },
  { code: "es", label: "🇪🇸 Español" },
  { code: "de", label: "🇩🇪 Deutsch" },
  { code: "pt", label: "🇵🇹 Português" },
  { code: "it", label: "🇮🇹 Italiano" },
  { code: "uk", label: "🇺🇦 Українська" },
];

function genId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function emptyService(): Service {
  return {
    id: genId(), title: "", description: "", price: "", uniqueFeature: "",
    notes: "", imageUrl: "", images: [], promotion: "", campaignType: "", targetAudience: [],
  };
}

export function CharacterizationTab({ phone }: Props) {
  const fetcher = useCallback(() => getCharacterization(phone), [phone]);
  const { data, loading, error, reload } = useApi(fetcher, [fetcher]);
  const toast = useToast();

  const [form, setForm] = useState<BusinessProfile>({});
  const [services, setServices] = useState<Service[]>([]);
  const [activeServiceIdx, setActiveServiceIdx] = useState(0);
  const [organicSlots, setOrganicSlots] = useState<OrganicSlot[]>(
    Array.from({ length: ORGANIC_SLOTS }, () => ({}))
  );
  const [saving, setSaving] = useState(false);
  const [showFbPassword, setShowFbPassword] = useState(false);
  const [showFbModal, setShowFbModal] = useState(false);
  const [fbStatus, setFbStatus] = useState<FbStatus | null>(null);
  const [fbOff, setFbOff] = useState(false);
  const [completing, setCompleting] = useState(false);
  /* "✨ הרחב עם AI" button busy state — OpenAI call can take 5-15s,
     button shows spinner + disables to prevent double-click. */
  const [expandingAbout, setExpandingAbout] = useState(false);
  /* "🔤 תקן כתיב" busy states — spell-fix for about + all services. */
  const [fixingAbout, setFixingAbout] = useState(false);
  const [fixingServices, setFixingServices] = useState(false);
  /* "✨ הוסף שירותים עם AI" button busy state. */
  const [suggestingServices, setSuggestingServices] = useState(false);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);

  /* showCats removed — category picker is now inline (CategoryInlinePicker). */
  const [showAvatar, setShowAvatar] = useState(false);
  const [showLogoGen, setShowLogoGen] = useState(false);

  useEffect(() => {
    getFbStatus(phone).then(setFbStatus).catch(err => { if (isFbUnavailable(err)) setFbOff(true); });
  }, [phone]);

  // hydrate from API
  useEffect(() => {
    if (!data) return;
    const bp = data.businessProfile ?? {};
    setForm(bp);
    const list = (bp.services ?? []).map((s: ServiceItem) => ({
      id: s.id ?? genId(),
      title: s.title ?? "",
      description: s.description ?? "",
      price: s.price ?? "",
      uniqueFeature: s.uniqueFeature ?? "",
      notes: s.notes ?? "",
      imageUrl: s.imageUrl ?? "",
      images: (() => {
        const arr = Array.isArray(s.images)
          ? s.images.filter((x): x is string => typeof x === "string" && !!x.trim())
          : [];
        if (arr.length) return arr.slice(0, 3);
        return s.imageUrl ? [s.imageUrl] : [];   // legacy single-image fallback
      })(),
      promotion: s.promotion ?? "",
      campaignType: s.campaignType ?? "",
      targetAudience: s.targetAudience ?? [],
      targetingDetailed: s.targetingDetailed,
    }));
    setServices(list);
    setActiveServiceIdx(0);
    /* normalize organic slots to fixed length */
    const slots = (bp.organicSlots ?? []).slice(0, ORGANIC_SLOTS);
    while (slots.length < ORGANIC_SLOTS) slots.push({});
    setOrganicSlots(slots);
  }, [data]);

  function patch<K extends keyof BusinessProfile>(key: K, value: BusinessProfile[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function patchSocial(key: "instagram" | "facebook" | "tiktok", value: string) {
    setForm(f => ({ ...f, socialLinks: { ...(f.socialLinks ?? {}), [key]: value } }));
  }

  function patchColor(
    key: "primary" | "secondary" | "accent" | "extra1" | "extra2" | "extra3",
    value: string,
  ) {
    setForm(f => ({ ...f, preferredColors: { ...(f.preferredColors ?? {}), [key]: value } }));
  }

  function updateService(idx: number, patch: Partial<Service>) {
    setServices(arr => arr.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }

  function addService() {
    const next = [...services, emptyService()];
    setServices(next);
    setActiveServiceIdx(next.length - 1);
  }

  function removeService(idx: number) {
    if (!confirm("להסיר את השירות?")) return;
    const next = services.filter((_, i) => i !== idx);
    setServices(next);
    setActiveServiceIdx(Math.min(idx, Math.max(0, next.length - 1)));
  }

  /* "🔤 תקן כתיב לכל השירותים" — fixes Hebrew spelling in every service's
     title / description / uniqueFeature / promotion in ONE AI call, then
     writes the corrected strings back (spelling only — meaning unchanged).
     Typos here otherwise propagate straight into ad/post generation. */
  async function fixServicesSpelling() {
    const fieldKeys = ["title", "description", "uniqueFeature", "promotion"] as const;
    const slots: Array<{ idx: number; key: typeof fieldKeys[number] }> = [];
    const texts: string[] = [];
    services.forEach((s, idx) => {
      fieldKeys.forEach(key => {
        const v = (s[key] ?? "").toString();
        if (v.trim()) { slots.push({ idx, key }); texts.push(v); }
      });
    });
    if (texts.length === 0) { toast.warn("אין טקסט בשירותים לתיקון"); return; }
    setFixingServices(true);
    try {
      const { corrected } = await spellcheckTexts(phone, texts);
      if (!Array.isArray(corrected) || corrected.length !== texts.length) {
        toast.error("תגובת התיקון לא תקינה");
        return;
      }
      let changed = 0;
      const next = services.map(s => ({ ...s }));
      slots.forEach((slot, i) => {
        const fixed = corrected[i] ?? texts[i];
        if (fixed !== texts[i]) { changed++; next[slot.idx][slot.key] = fixed; }
      });
      if (changed > 0) setServices(next);
      toast.ok(changed > 0 ? `תוקנו שגיאות כתיב ב-${changed} שדות שירות ✨` : "לא נמצאו שגיאות כתיב בשירותים");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "תיקון נכשל");
    } finally {
      setFixingServices(false);
    }
  }

  /* "✨ הוסף שירותים עם AI" — wraps the suggestServicesWithAI API
     call, builds 3 ServiceItem objects from the response, and APPENDS
     them to the existing services list (never replaces). The new
     services jump to the front of the tab strip so the manager sees
     them immediately and can fine-tune. */
  async function handleSuggestServices() {
    const name = (form.businessName ?? "").trim();
    const desc = (form.about ?? "").trim();
    if (!name && !desc) {
      toast.warn("מלא שם עסק או אודות לפני שמשתמשים בהוספה עם AI");
      return;
    }
    setSuggestingServices(true);
    try {
      const r = await suggestServicesWithAI(phone, {
        businessName:  name || undefined,
        about:         desc || undefined,
        businessField: form.categoryKey || undefined,
        businessNiche: Array.isArray(form.subCategoryKeys) ? form.subCategoryKeys.join(", ") : undefined,
      });
      const newOnes: Service[] = (r.services || []).map(s => ({
        ...emptyService(),
        title:             s.title,
        description:       s.description,
        uniqueFeature:     s.uniqueFeature,
        targetAudience:    Array.isArray(s.targetAudience) ? s.targetAudience : [],
        /* AI-suggested Meta campaign objective + full targeting. The
           targetingDetailed comes back with locations defaulted to
           Israel and customInterests as free-text — the manager can
           refine in the targeting editor. */
        campaignType:      s.campaignType || "",
        targetingDetailed: s.targetingDetailed,
      }));
      if (newOnes.length === 0) {
        toast.warn("לא הוצעו שירותים");
        return;
      }
      const next = [...services, ...newOnes];
      setServices(next);
      /* Jump to the first newly-added service so the manager can edit
         it right away. */
      setActiveServiceIdx(services.length);
      toast.ok(`נוספו ${newOnes.length} שירותים ✨`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "הצעת שירותים נכשלה");
    } finally {
      setSuggestingServices(false);
    }
  }

  function setSlot(idx: number, slot: OrganicSlot) {
    setOrganicSlots(arr => arr.map((s, i) => i === idx ? slot : s));
  }

  function validateForCompletion(bp: BusinessProfile): string[] {
    const missing: string[] = [];
    if (!bp.businessName?.trim()) missing.push("שם העסק");
    if (!bp.categoryKey) missing.push("קטגוריה ראשית");
    if (!bp.subCategoryKeys || bp.subCategoryKeys.filter(k => k !== "other_input").length === 0) missing.push("תת-קטגוריה");
    if (!bp.services || bp.services.length === 0) missing.push("שירות אחד לפחות");
    if (!bp.targetAudience || bp.targetAudience.length === 0) missing.push("קהל יעד");
    if (!bp.pageGoal) missing.push("מטרת דף");
    if (!bp.logoUrl) missing.push("לוגו");
    if (!bp.preferredColors?.primary) missing.push("צבע ראשי");
    if (!(bp as any).images || (bp as any).images.length === 0) missing.push("תמונה אחת לפחות");
    return missing;
  }

  async function save() {
    setSaving(true);
    const bp: BusinessProfile = {
      ...form,
      services: services.map(s => ({ ...s, imageUrl: s.images?.[0] ?? s.imageUrl ?? "" })),
      organicSlots,
    };
    try {
      await updateCharacterization(phone, bp);
      toast.ok("האיפיון נשמר");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירה");
    } finally {
      setSaving(false);
    }
  }

  async function completeCharacterization() {
    const bp: BusinessProfile = {
      ...form,
      services: services.map(s => ({ ...s, imageUrl: s.images?.[0] ?? s.imageUrl ?? "" })),
      organicSlots,
    };
    const missing = validateForCompletion(bp);
    if (missing.length > 0) {
      setMissingFields(missing);
      return;
    }
    setCompleting(true);
    try {
      await updateCharacterization(phone, bp);
      /* Records the completion server-side and WhatsApps the client
         "איפיון הושלם" — never blocks the product kickoff below. */
      markCharacterizationComplete(phone).catch(() =>
        toast.warn("האיפיון נשמר, אבל סיום האיפיון לא נרשם וההודעה ללקוח לא נשלחה — לחצו שוב \"סיים איפיון\""));
      /* Auto-kick all product pipelines now that the characterization is
         genuinely complete (the missing-fields gate above only lets us
         through when nothing's left to fill). Mirrors the manual
         resendToProduction logic in ProductsTab: one generate call per
         purchased product type, fire-and-forget so the manager doesn't
         wait on 3-5 long-running pipelines. We DO NOT trigger logos — they
         need the manager's style/color picks in the LogoGenerator modal
         to produce anything useful. */
      try {
        const pkg = await getClientPackage(phone);
        const items = pkg?.items;
        if (items) {
          const calls: Promise<unknown>[] = [];
          if ((items.organicAds ?? 0) > 0) calls.push(generateWowOrganic(phone));
          for (let i = 0; i < (items.campaignTraffic ?? 0); i++)
            calls.push(generateWowAds(phone, `campaign_traffic_${i}`));
          for (let i = 0; i < (items.campaignLeads ?? 0); i++)
            calls.push(generateWowAds(phone, `campaign_leads_${i}`));
          /* Legacy paid-ads (pre-campaign-split packages) — only fire if
             neither campaignTraffic nor campaignLeads are set. */
          if ((items.paidAds ?? 0) > 0 && (items.campaignTraffic ?? 0) === 0 && (items.campaignLeads ?? 0) === 0)
            calls.push(generateWowAds(phone));
          if ((items.lps ?? 0) > 0) calls.push(generateWowLp(phone));
          /* Fire-and-forget — each pipeline runs server-side for minutes;
             waiting here would block the toast and the manager. Individual
             failures are logged server-side and surface in the products tab. */
          calls.forEach(p => p.catch(e => console.warn("[characterization-complete] auto-generation failed:", e)));
        }
      } catch (autoErr) {
        /* Auto-generation kickoff failed (e.g. package fetch errored).
           The characterization itself is still saved — we don't want to
           mislead the manager into thinking save failed. */
        console.warn("[characterization-complete] could not auto-trigger products:", autoErr);
      }
      toast.ok("האיפיון הושלם — המוצרים מתחילים להיווצר אוטומטית ברקע");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "שגיאה בשמירה");
    } finally {
      setCompleting(false);
    }
  }

  /* `cat` is no longer needed at the outer scope — the inline picker
     resolves it internally via categoryByKey. */

  /* Category readiness counters for badges on accordion headers. */
  const filledServices = useMemo(
    () => services.filter(s => s.title.trim().length > 0).length,
    [services],
  );
  const filledSlots = useMemo(
    () => organicSlots.filter(s => s.serviceId || s.mode === "ai").length,
    [organicSlots],
  );

  if (loading) return <Spinner label="טוען איפיון" />;
  if (error)   return <ErrorBlock message={error} onRetry={reload} />;

  return (
    <div style={{ display: "grid", gap: "var(--s-5)" }}>

      {/* ── Accordion 1 — Business info ────────────────────────────────── */}
      <Accordion
        eyebrow="Identity"
        title="פרטי עסק"
        meta="פרטי העסק, תיאור וקטגוריה"
        defaultOpen
        badge={<Badge>{form.businessName ? <IcoCheck size={12} color="var(--positive, #16a34a)" /> : "—"}</Badge>}
      >
        <div style={{ display: "grid", gap: "var(--s-7)" }}>

          {/* — business info — */}
          <div>
            <SubHead title="פרטי עסק" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5) var(--s-6)" }}>
              <Field label="שם העסק">
                <Input value={form.businessName ?? ""} onChange={e => patch("businessName", e.target.value)} placeholder="לדוגמה: סלון ויוטה" />
              </Field>
              <Field label="טלפון העסק">
                <Input value={form.businessPhone ?? ""} onChange={e => patch("businessPhone", e.target.value)} placeholder="0501234567" dir="ltr" inputMode="tel" />
              </Field>
              <Field label="כתובת">
                <Input value={form.address ?? ""} onChange={e => patch("address", e.target.value)} placeholder="רחוב, עיר" />
              </Field>
              <Field label="אימייל">
                <Input type="email" value={form.email ?? ""} onChange={e => patch("email", e.target.value)} dir="ltr" placeholder="info@business.co.il" />
              </Field>
              <Field label="שעות וימי פעילות">
                <Input
                  value={(form as any).operatingHours ?? ""}
                  onChange={e => patch("operatingHours" as any, e.target.value as any)}
                  placeholder="א'–ה' 9:00–18:00 · ו' 9:00–13:00"
                />
              </Field>
              <Field label="אתר / דומיין הלקוח">
                <Input
                  value={(form as any).websiteUrl ?? ""}
                  onChange={e => patch("websiteUrl" as any, e.target.value as any)}
                  dir="ltr"
                  inputMode="url"
                  placeholder="https://example.co.il"
                />
              </Field>
            </div>

            {/* — Contact-info toggles — drive whether the wow-ads pipeline
                surfaces phone / address on the generated creative. Default
                off; both flags flow through buildBriefForClient and the
                image-prompt builder adds a MANDATORY contact-info block
                when true. */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "var(--s-5) var(--s-6)",
              marginTop: "var(--s-4)",
            }}>
              <ToggleRow
                label="האם לכלול טלפון במודעות?"
                checked={(form as any).includePhoneInAds === true}
                onChange={v => patch("includePhoneInAds" as any, v as any)}
              />
              <ToggleRow
                label="האם לכלול כתובת במודעות?"
                checked={(form as any).includeAddressInAds === true}
                onChange={v => patch("includeAddressInAds" as any, v as any)}
              />
            </div>
          </div>

          {/* — Facebook credentials — */}
          <div>
            <SubHead
              title="פרטי כניסה פייסבוק"
              meta={fbOff ? "חיבור פייסבוק כבוי כרגע" : fbStatus?.status === "connected" ? `מחובר ✓${fbStatus.connectedAt ? " · " + new Date(fbStatus.connectedAt).toLocaleDateString("he-IL") : ""}` : undefined}
              action={
                <Button
                  size="sm"
                  onClick={() => setShowFbModal(true)}
                  disabled={fbOff || !form.facebookUsername || !form.facebookPassword}
                >
                  {fbStatus?.status === "connected" ? "חבר מחדש" : "התחבר"}
                </Button>
              }
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5) var(--s-6)" }}>
              <Field label="שם משתמש">
                <Input
                  dir="ltr"
                  value={form.facebookUsername ?? ""}
                  onChange={e => patch("facebookUsername", e.target.value)}
                  placeholder="username@example.com"
                  autoComplete="off"
                />
              </Field>
              <Field label="סיסמה">
                <div style={{ position: "relative" }}>
                  <Input
                    type={showFbPassword ? "text" : "password"}
                    dir="ltr"
                    value={form.facebookPassword ?? ""}
                    onChange={e => patch("facebookPassword", e.target.value)}
                    placeholder="••••••••"
                    autoComplete="new-password"
                    style={{ paddingLeft: 36 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowFbPassword(v => !v)}
                    title={showFbPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                    style={{
                      position: "absolute",
                      left: 8,
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      color: showFbPassword ? "var(--blue)" : "var(--text-muted, #888)",
                    }}
                  >
                    <IcoEye size={16} />
                  </button>
                </div>
              </Field>
            </div>
          </div>

          {/* — about — */}
          <div>
            <SubHead
              title="אודות העסק"
              action={
                <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!(form.about ?? "").trim() || fixingAbout}
                  loading={fixingAbout}
                  onClick={async () => {
                    const current = (form.about ?? "").trim();
                    if (!current) { toast.warn("אין טקסט לתיקון"); return; }
                    setFixingAbout(true);
                    try {
                      const { corrected } = await spellcheckTexts(phone, [form.about ?? ""]);
                      const fixed = corrected?.[0] ?? (form.about ?? "");
                      const changed = fixed !== (form.about ?? "");
                      patch("about", fixed);
                      toast.ok(changed ? "תוקנו שגיאות כתיב באודות ✨" : "לא נמצאו שגיאות כתיב");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "תיקון נכשל");
                    } finally {
                      setFixingAbout(false);
                    }
                  }}
                  title="מתקן שגיאות כתיב בעברית בטקסט הקיים"
                >
                  🔤 תקן כתיב
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!(form.about ?? "").trim() || expandingAbout}
                  loading={expandingAbout}
                  onClick={async () => {
                    const current = (form.about ?? "").trim();
                    if (!current) {
                      toast.warn("אודות העסק ריק — אין מה להרחיב");
                      return;
                    }
                    setExpandingAbout(true);
                    try {
                      /* Send the canonical category catalog so the
                         server can also pick categoryKey + sub-category
                         in the same call. Both are validated against
                         the catalog before reaching us — null = no
                         confident match, leave manager's selection
                         alone. */
                      const { expanded, categoryKey, subCategoryKey } = await expandAboutWithAI(
                        phone,
                        current,
                        CATEGORIES.map(c => ({
                          key: c.key,
                          label: c.label,
                          subCategories: c.subCategories.map(s => ({ key: s.key, label: s.label })),
                        })),
                      );
                      patch("about", expanded);
                      const changes: string[] = ["האודות הורחב"];
                      if (categoryKey) {
                        patch("categoryKey", categoryKey);
                        /* New main category → clear any prior sub
                           selection that doesn't belong to it. */
                        patch("subCategoryKeys", subCategoryKey ? [subCategoryKey] : []);
                        patch("subCategoryCustom", "");
                        const catLabel = categoryByKey(categoryKey)?.label;
                        if (catLabel) changes.push(`קטגוריה: ${catLabel}`);
                        if (subCategoryKey) {
                          const subLabel = categoryByKey(categoryKey)?.subCategories.find(s => s.key === subCategoryKey)?.label;
                          if (subLabel) changes.push(`תת: ${subLabel}`);
                        }
                      }
                      toast.ok(`${changes.join(" · ")} ✨`);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "הרחבה נכשלה");
                    } finally {
                      setExpandingAbout(false);
                    }
                  }}
                  title={(form.about ?? "").trim() ? "מרחיב את הטקסט הקיים באמצעות AI" : "מלא קודם אודות העסק"}
                >
                  ✨ הרחב עם AI
                </Button>
                </div>
              }
            />
            <Field label="טקסט חופשי">
              <Textarea
                value={form.about ?? ""}
                onChange={e => patch("about", e.target.value)}
                rows={5}
                placeholder="ספר על העסק, ייחודיות, קהל יעד, ניסיון…"
              />
            </Field>
          </div>

          {/* — category — inline search inputs instead of a popup
              modal. Manager types and picks; no extra clicks. */}
          <div>
            <SubHead title="קטגוריית עסק" meta="הקלד או בחר — קטגוריה ראשית ותת-קטגוריה" />
            <CategoryInlinePicker
              categoryKey={form.categoryKey ?? ""}
              subCategoryKey={(form.subCategoryKeys ?? [])[0] ?? ""}
              customSub={form.subCategoryCustom ?? ""}
              onChangeCategory={(key) => {
                patch("categoryKey", key);
                /* New main category → clear the prior sub selection so
                   the manager doesn't end up with a sub from a
                   different category. */
                patch("subCategoryKeys", []);
                patch("subCategoryCustom", "");
              }}
              onChangeSubCategory={(key) => {
                patch("subCategoryKeys", key ? [key] : []);
                /* When picking a real sub, clear any leftover custom
                   text so the badge below shows just the picked one. */
                if (key && key !== "other_input") patch("subCategoryCustom", "");
              }}
              onChangeCustomSub={(v) => patch("subCategoryCustom", v)}
            />
          </div>

        </div>
      </Accordion>

      {/* ── Accordion — Marketing target (page goal + audience) ───────── */}
      <Accordion
        eyebrow="Marketing"
        title="מטרת השיווק וקהל יעד"
        meta="נדרש לפתיחת מסך המוצרים — מגדיר ל-AI מה לייצר ולמי"
        badge={<Badge>{(form.pageGoal ? 1 : 0) + ((form.targetAudience?.length ?? 0) > 0 ? 1 : 0)}/2</Badge>}
        defaultOpen={!form.pageGoal || !form.targetAudience?.length}
      >
        <div style={{ display: "grid", gap: "var(--s-7)" }}>

          {/* — page goal — */}
          <div>
            <SubHead title="מטרת דף הנחיתה" meta="מה הפעולה המרכזית שתרצה שמבקרי הדף יעשו?" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
              {PAGE_GOAL_OPTIONS.map(opt => {
                const active = form.pageGoal === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => patch("pageGoal", opt.value)}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--blue)" : "var(--rule-strong)"}`,
                      background: active ? "var(--blue)" : "var(--paper)",
                      color: active ? "#fff" : "var(--ink-2)",
                      fontSize: "var(--t-sm)",
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 150ms",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* — target audience — */}
          <div>
            <SubHead title="קהל יעד" meta="בחר את הקבוצות הרלוונטיות (ניתן לבחור כמה)" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
              {TARGET_AUDIENCE_OPTIONS.map(opt => {
                const active = (form.targetAudience ?? []).includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      const cur = form.targetAudience ?? [];
                      patch("targetAudience", active ? cur.filter(x => x !== opt) : [...cur, opt]);
                    }}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--blue)" : "var(--rule-strong)"}`,
                      background: active ? "var(--blue-soft)" : "var(--paper)",
                      color: active ? "var(--blue)" : "var(--ink-2)",
                      fontSize: "var(--t-sm)",
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 150ms",
                    }}
                  >
                    {active ? "✓ " : ""}{opt}
                  </button>
                );
              })}
            </div>
          </div>

          {/* — ad language — */}
          <div>
            <SubHead title="שפת מודעות" meta="השפה שבה ייכתבו ויעוצבו המודעות והפוסטים לעסק זה (ברירת מחדל: עברית)" />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
              {LANGUAGE_OPTIONS.map(opt => {
                const cur = ((form as any).language as string) || "he";
                const active = cur === opt.code;
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => patch("language" as any, opt.code as any)}
                    style={{
                      padding: "8px 16px",
                      borderRadius: 999,
                      border: `1px solid ${active ? "var(--blue)" : "var(--rule-strong)"}`,
                      background: active ? "var(--blue)" : "var(--paper)",
                      color: active ? "#fff" : "var(--ink-2)",
                      fontSize: "var(--t-sm)",
                      fontWeight: 700,
                      cursor: "pointer",
                      transition: "all 150ms",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

        </div>
      </Accordion>

      {/* ── Accordion 2 — Services ────────────────────────────────────── */}
      <Accordion
        eyebrow="Services"
        title="שירותים"
        meta={`${filledServices}/${services.length || 0} שירותים מאופיינים`}
        badge={<Badge>{services.length}</Badge>}
      >
        {services.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--s-3)" }}>
            <Button
              variant="ghost"
              size="sm"
              loading={fixingServices}
              disabled={fixingServices}
              onClick={fixServicesSpelling}
              title="מתקן שגיאות כתיב בעברית בכל שדות השירותים (כותרת, תיאור, ייחודיות, מבצע)"
            >
              🔤 תקן כתיב לכל השירותים
            </Button>
          </div>
        )}
        <ServicesPanel
          services={services}
          activeIdx={activeServiceIdx}
          onSelect={setActiveServiceIdx}
          onAdd={addService}
          onRemove={removeService}
          onChange={updateService}
          onSuggestWithAI={handleSuggestServices}
          suggestBusy={suggestingServices}
        />
      </Accordion>

      {/* ── Accordion 3 — Social ──────────────────────────────────────── */}
      <Accordion
        eyebrow="Social"
        title="סושיאל"
        meta={`${filledSlots}/${ORGANIC_SLOTS} מודעות אורגניות מתוכננות`}
        badge={<Badge>{filledSlots}</Badge>}
      >
        <SocialPanel
          services={services}
          slots={organicSlots}
          onSetSlot={setSlot}
          avatar={form.avatar}
          onOpenAvatar={() => setShowAvatar(true)}
          form={form}
          onPatchSocial={patchSocial}
        />
      </Accordion>

      {/* ── Branding (logo + brand colors + design style) ─────────────── */}
      <Accordion
        eyebrow="Brand"
        title="לוגו וצבעי מותג"
        meta="העלה לוגו או צור אותו לפי צבעים — הצבעים יחולצו אוטומטית"
      >
        <div style={{ display: "grid", gap: "var(--s-7)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "var(--s-6)", alignItems: "flex-start" }}>
            <LogoUploader
              value={form.logoUrl}
              onChange={(url) => patch("logoUrl", url)}
              onColorsExtracted={(colors) => {
                setForm(f => ({ ...f, preferredColors: { ...(f.preferredColors ?? {}), ...colors } }));
              }}
              onGenerateClick={() => setShowLogoGen(true)}
            />
            <div style={{ display: "grid", gap: "var(--s-5)" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--s-4)" }}>
                <ColorField label="צבע ראשי"   value={form.preferredColors?.primary   ?? ""} onChange={v => patchColor("primary", v)} />
                <ColorField label="צבע משני"   value={form.preferredColors?.secondary ?? ""} onChange={v => patchColor("secondary", v)} />
                <ColorField label="צבע הדגשה" value={form.preferredColors?.accent    ?? ""} onChange={v => patchColor("accent", v)} />
              </div>
              {/* Extra brand colors — same downstream wiring as the first
                  three. Server-side `formatBrandPalette` includes any that
                  are set in the AI prompts for logo / ads / social / LP. */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "var(--s-4)" }}>
                <ColorField label="צבע 4" value={form.preferredColors?.extra1 ?? ""} onChange={v => patchColor("extra1", v)} />
                <ColorField label="צבע 5" value={form.preferredColors?.extra2 ?? ""} onChange={v => patchColor("extra2", v)} />
                <ColorField label="צבע 6" value={form.preferredColors?.extra3 ?? ""} onChange={v => patchColor("extra3", v)} />
              </div>
            </div>
          </div>

          <div>
            <SubHead title="תמונות לקוח" meta="עד 20 תמונות (מסונכרן עם האפליקציה) — יופיעו בדף הנחיתה ובמודעות" />
            <ImagesUploader
              values={(form as any).images || []}
              onChange={(urls) => patch("images" as any, urls as any)}
              max={20}
            />
          </div>
        </div>
      </Accordion>

      {/* ── Save bar ──────────────────────────────────────────────────── */}
      <div style={{
        position: "sticky",
        bottom: 0,
        background: "var(--bg)",
        borderTop: "1px solid var(--rule)",
        padding: "var(--s-5) 0",
        display: "flex",
        gap: "var(--s-3)",
        justifyContent: "flex-start",
        zIndex: 5,
      }}>
        <Button onClick={save} loading={saving} size="lg" disabled={saving || completing}>
          שמור איפיון
        </Button>
        <Button onClick={completeCharacterization} loading={completing} size="lg" disabled={saving || completing}>
          הושלם איפיון ✓
        </Button>
        <Button variant="ghost" onClick={reload} disabled={saving || completing}>שחזר משרת</Button>
      </div>

      {/* CategoryPicker modal retired in favor of the inline
          CategoryInlinePicker rendered above. The modal component is
          still in src/components/pickers in case other places use it,
          but Characterization no longer mounts it. */}

      <FbConnectModal
        phone={phone}
        open={showFbModal}
        onClose={() => setShowFbModal(false)}
        onSuccess={({ fbUserId }) => {
          setFbStatus({ status: "connected", connectedAt: new Date().toISOString(), fbUserId });
          setShowFbModal(false);
        }}
      />

      <AvatarDesigner
        open={showAvatar}
        value={form.avatar}
        onClose={() => setShowAvatar(false)}
        onSave={(cfg: AvatarConfig) => patch("avatar", cfg)}
      />

      <LogoGenerator
        open={showLogoGen}
        businessName={form.businessName}
        initialColors={form.preferredColors as any}
        onClose={() => setShowLogoGen(false)}
        onApply={async (url) => {
          patch("logoUrl", url);
          /* Mirror the file-upload behavior: pull dominant colors out
             of the generated logo and seed the 6 brand-color slots.
             extractDominantColors uses crossOrigin:"anonymous" + Canvas
             and works fine on the same-origin /api/img URL the backend
             returns, so no CORS hop. Soft-fails if extraction returns
             nothing — the form's existing colors stay untouched. */
          try {
            const colors = await extractDominantColors(resolveImgUrl(url) ?? url, 6);
            if (colors.length >= 1) {
              const next: {
                primary?: string; secondary?: string; accent?: string;
                extra1?: string; extra2?: string; extra3?: string;
              } = {};
              if (colors[0]) next.primary   = colors[0];
              if (colors[1]) next.secondary = colors[1];
              if (colors[2]) next.accent    = colors[2];
              if (colors[3]) next.extra1    = colors[3];
              if (colors[4]) next.extra2    = colors[4];
              if (colors[5]) next.extra3    = colors[5];
              setForm(f => ({ ...f, preferredColors: { ...(f.preferredColors ?? {}), ...next } }));
            }
          } catch {
            /* swallow — colors stay as they were */
          }
        }}
      />

      {missingFields !== null && (
        <Modal open onClose={() => setMissingFields(null)} title="האיפיון אינו מלא">
          <p style={{ marginBottom: "var(--s-3)" }}>נא להשלים את השדות הבאים לפני סיום האיפיון:</p>
          <ul style={{ paddingRight: "var(--s-5)", lineHeight: 2 }}>
            {missingFields.map(f => <li key={f}>{f}</li>)}
          </ul>
          <div style={{ marginTop: "var(--s-5)", display: "flex", justifyContent: "flex-end" }}>
            <Button onClick={() => setMissingFields(null)}>סגור</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Services panel — tabbed view, one tab per service.
   Each service gets its own image, promo, campaign type, and audience.
─────────────────────────────────────────────────────────────────────── */

function ServicesPanel({
  services, activeIdx, onSelect, onAdd, onRemove, onChange, onSuggestWithAI, suggestBusy,
}: {
  services: Service[];
  activeIdx: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onChange: (i: number, patch: Partial<Service>) => void;
  onSuggestWithAI: () => void;
  suggestBusy: boolean;
}) {
  if (services.length === 0) {
    return (
      <div style={{
        textAlign: "center",
        padding: "var(--s-7) var(--s-5)",
        border: "2px dashed var(--rule-strong)",
        borderRadius: "var(--r-2)",
        background: "var(--bg-tint)",
      }}>
        <p className="t-body" style={{ marginBottom: "var(--s-4)" }}>טרם נוספו שירותים</p>
        <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "center", flexWrap: "wrap" }}>
          <Button onClick={onAdd}>הוסף שירות ראשון</Button>
          <Button
            variant="ghost"
            onClick={onSuggestWithAI}
            loading={suggestBusy}
            disabled={suggestBusy}
            title="ייצור 3 שירותים מותאמים על בסיס שם העסק והאודות"
          >
            ✨ הוסף שירותים עם AI
          </Button>
        </div>
      </div>
    );
  }

  const idx = Math.min(activeIdx, services.length - 1);
  const cur = services[idx];

  return (
    <div>
      {/* Tabs */}
      <div style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        borderBottom: "1px solid var(--rule)",
        marginBottom: "var(--s-5)",
        paddingBottom: 1,
      }}>
        {services.map((s, i) => {
          const active = i === idx;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(i)}
              style={{
                position: "relative",
                padding: "10px 14px",
                background: active ? "var(--surface)" : "transparent",
                border: "1px solid " + (active ? "var(--rule)" : "transparent"),
                borderBottom: active ? "1px solid var(--surface)" : "1px solid var(--rule)",
                marginBottom: -1,
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13,
                color: active ? "var(--blue)" : "var(--ink-2)",
                borderTopLeftRadius: 6,
                borderTopRightRadius: 6,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              {s.imageUrl && (
                <img src={resolveImgUrl(s.imageUrl)} alt="" style={{ width: 22, height: 22, objectFit: "cover", borderRadius: 4 }} />
              )}
              <span>{s.title || `שירות ${i + 1}`}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          style={{
            padding: "10px 14px",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            fontWeight: 700,
            fontSize: 13,
            color: "var(--blue)",
            marginBottom: -1,
          }}
        >
          + הוסף שירות
        </button>
        <button
          type="button"
          onClick={onSuggestWithAI}
          disabled={suggestBusy}
          title="ייצור 3 שירותים מותאמים על בסיס שם העסק והאודות"
          style={{
            padding: "10px 14px",
            background: "transparent",
            border: 0,
            cursor: suggestBusy ? "wait" : "pointer",
            fontWeight: 700,
            fontSize: 13,
            color: "var(--blue)",
            marginBottom: -1,
            opacity: suggestBusy ? 0.6 : 1,
          }}
        >
          {suggestBusy ? "מייצר… ✨" : "✨ הוסף שירותים עם AI"}
        </button>
      </div>

      {/* Active service editor */}
      <ServiceEditor
        service={cur}
        idx={idx}
        onChange={(patch) => onChange(idx, patch)}
        onRemove={() => onRemove(idx)}
      />
    </div>
  );
}

function ServiceEditor({
  service, idx, onChange, onRemove,
}: {
  service: Service;
  idx: number;
  onChange: (patch: Partial<Service>) => void;
  onRemove: () => void;
}) {
  const [showTargeting, setShowTargeting] = useState(false);

  return (
    <div style={{
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      padding: "var(--s-6)",
      background: "var(--surface)",
      display: "grid",
      gap: "var(--s-6)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <p className="t-eyebrow">שירות · {String(idx + 1).padStart(2, "0")}</p>
        <Button size="sm" variant="quiet" onClick={onRemove}>הסר שירות</Button>
      </div>

      <div style={{ display: "grid", gap: "var(--s-6)" }}>
        <Field label="תמונות השירות (עד 3)">
          <ImagesUploader
            values={service.images ?? []}
            onChange={imgs => onChange({ images: imgs })}
            max={3}
          />
        </Field>

        <div style={{ display: "grid", gap: "var(--s-5)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5)" }}>
            <Field label="שם השירות">
              <Input value={service.title} onChange={e => onChange({ title: e.target.value })} placeholder="לדוגמה: גזירת שיער + תספורת" />
            </Field>
            <Field label="מחיר">
              <Input value={service.price} onChange={e => onChange({ price: e.target.value })} placeholder="לדוגמה: 150 ₪" />
            </Field>
          </div>
          <Field label="תיאור" hint="2–3 משפטים">
            <Textarea value={service.description} onChange={e => onChange({ description: e.target.value })} rows={3} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5)" }}>
            <Field label="ייחודיות">
              <Textarea value={service.uniqueFeature} onChange={e => onChange({ uniqueFeature: e.target.value })} rows={3} placeholder="מה הופך את השירות שלך לייחודי?" />
            </Field>
            <Field label="מבצע (אופציונלי)" hint="אם השירות במבצע">
              <Textarea value={service.promotion} onChange={e => onChange({ promotion: e.target.value })} rows={3} placeholder="לדוגמה: 50% הנחה ללקוח חדש" />
            </Field>
          </div>
        </div>
      </div>

      <div>
        <SubHead title="סוג קמפיין" meta="המטרה השיווקית של מודעות לשירות הזה" />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
          {CAMPAIGN_OBJECTIVES.map(o => {
            const active = service.campaignType === o.id;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange({ campaignType: active ? "" : o.id })}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 14px",
                  background: active ? "var(--blue)" : "var(--paper)",
                  color: active ? "#fff" : "var(--ink)",
                  border: "1px solid " + (active ? "var(--blue)" : "var(--rule-strong)"),
                  borderRadius: "var(--r-2)",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <CampaignIcon objective={o.id} size={16} />
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <SubHead
          title="טירגוט פייסבוק"
          meta="גילאים, מגדר, מיקום, שפות, תחומי עניין/התנהגות/דמוגרפי, חיבורים"
          action={
            <Button size="sm" variant="ghost" onClick={() => setShowTargeting(true)}>
              {service.targetingDetailed ? "ערוך טירגוט" : "הגדר טירגוט"}
            </Button>
          }
        />
        <TargetingPreview
          targeting={service.targetingDetailed}
          onClick={() => setShowTargeting(true)}
        />
      </div>

      <TargetingEditor
        open={showTargeting}
        serviceTitle={service.title || `שירות ${idx + 1}`}
        value={service.targetingDetailed}
        onClose={() => setShowTargeting(false)}
        onSave={(t) => onChange({ targetingDetailed: t })}
      />
    </div>
  );
}

function TargetingPreview({ targeting, onClick }: { targeting?: FbTargeting; onClick: () => void }) {
  const summary = targetingSummary(targeting);
  const detailed = targeting?.detailed ?? [];
  const customs  = targeting?.customInterests ?? [];
  const locs     = targeting?.locations ?? [];

  if (!targeting) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={{
          display: "block",
          width: "100%",
          padding: "20px",
          background: "var(--bg-tint)",
          border: "2px dashed var(--rule-strong)",
          borderRadius: "var(--r-2)",
          cursor: "pointer",
          textAlign: "center",
          color: "var(--ink-2)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
          <IcoCrosshair size={20} />
          לחץ להגדרת טירגוט פייסבוק מלא
        </span>
      </button>
    );
  }

  return (
    <div style={{
      padding: "var(--s-4)",
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-2)",
      display: "grid",
      gap: "var(--s-3)",
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
        {summary}
      </div>

      {locs.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {locs.slice(0, 6).map((l, i) => (
            <span key={i} style={{
              fontSize: 11, fontWeight: 600,
              padding: "3px 9px",
              background: l.include ? "rgba(16,185,129,0.10)" : "rgba(220,38,38,0.10)",
              color:      l.include ? "#065f46" : "#991b1b",
              borderRadius: 999,
            }}>📍 {l.name}{l.radiusKm ? ` +${l.radiusKm}km` : ""}</span>
          ))}
          {locs.length > 6 && (
            <span className="t-meta" style={{ fontSize: 11 }}>+{locs.length - 6}</span>
          )}
        </div>
      )}

      {(detailed.length > 0 || customs.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {detailed.slice(0, 8).map(d => (
            <span key={d.id} style={{
              fontSize: 11, fontWeight: 600,
              padding: "3px 9px",
              background: "rgba(30,58,138,0.08)",
              color: "#1E3A8A",
              borderRadius: 999,
            }}>{d.name}</span>
          ))}
          {customs.slice(0, 4).map(c => (
            <span key={c} style={{
              fontSize: 11, fontWeight: 600,
              padding: "3px 9px",
              background: "var(--bg-tint)",
              color: "var(--ink-2)",
              border: "1px dashed var(--rule-strong)",
              borderRadius: 999,
            }}>{c}</span>
          ))}
          {(detailed.length + customs.length) > 12 && (
            <span className="t-meta" style={{ fontSize: 11 }}>+{detailed.length + customs.length - 12}</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ServiceImageUpload (single-image) removed — service images now use the
   multi-image <ImagesUploader max={3} /> bound to service.images[]. */

/* ─────────────────────────────────────────────────────────────────────
   Social panel — services chips + 5 organic ad slots with drag-drop +
   avatar designer entry point.
─────────────────────────────────────────────────────────────────────── */

function SocialPanel({
  services, slots, onSetSlot, avatar, onOpenAvatar, form, onPatchSocial,
}: {
  services: Service[];
  slots: OrganicSlot[];
  onSetSlot: (i: number, slot: OrganicSlot) => void;
  avatar: AvatarConfig | undefined;
  onOpenAvatar: () => void;
  form: BusinessProfile;
  onPatchSocial: (k: "instagram" | "facebook" | "tiktok", v: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--s-7)" }}>

      {/* Services chips (draggable) */}
      <div>
        <SubHead title="שירותים זמינים" meta="גרור שירות אל מודעה אורגנית כדי לשייך" />
        {services.length === 0 ? (
          <p className="t-meta">אין שירותים. הוסף שירותים בכרטיסיית "שירותים" קודם.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-3)" }}>
            {services.map((s, i) => (
              <ServiceChip key={s.id} service={s} idx={i} />
            ))}
          </div>
        )}
      </div>

      {/* Organic ad slots */}
      <div>
        <SubHead
          title="5 מודעות אורגניות"
          meta="גרור שירות לתוך משבצת — או לחץ AI כדי שהמערכת תייצר באופן חופשי"
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "var(--s-3)" }}>
          {slots.map((slot, i) => (
            <OrganicSlotCard
              key={i}
              idx={i}
              slot={slot}
              services={services}
              onChange={(s) => onSetSlot(i, s)}
            />
          ))}
        </div>
      </div>

      {/* Avatar */}
      <div>
        <SubHead
          title="אווטר / פרזנטור"
          meta="דמות אופציונלית שתופיע בכל המודעות האורגניות"
          action={<Button variant="ghost" size="sm" onClick={onOpenAvatar}>{avatar ? "עריכת אווטר" : "צור אווטר"}</Button>}
        />
        {avatar ? <AvatarSummary avatar={avatar} /> : (
          <p className="t-meta">לא הוגדר אווטר — לחץ "צור אווטר" כדי להגדיר את הפרזנטור.</p>
        )}
      </div>

      {/* Social links */}
      <div>
        <SubHead title="חשבונות סושיאל" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-5)" }}>
          <Field label="Instagram">
            <Input dir="ltr" value={form.socialLinks?.instagram ?? ""} onChange={e => onPatchSocial("instagram", e.target.value)} placeholder="@username" />
          </Field>
          <Field label="Facebook">
            <Input dir="ltr" value={form.socialLinks?.facebook ?? ""} onChange={e => onPatchSocial("facebook", e.target.value)} placeholder="facebook.com/page" />
          </Field>
          <Field label="TikTok">
            <Input dir="ltr" value={form.socialLinks?.tiktok ?? ""} onChange={e => onPatchSocial("tiktok", e.target.value)} placeholder="@username" />
          </Field>
        </div>
      </div>
    </div>
  );
}

function ServiceChip({ service, idx }: { service: Service; idx: number }) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/x-service-id", service.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title={service.title || `שירות ${idx + 1}`}
      style={{
        width: 110,
        cursor: "grab",
        background: "var(--paper)",
        border: "1px solid var(--rule-strong)",
        borderRadius: "var(--r-2)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{
        height: 70,
        background: service.imageUrl ? `center/cover url(${service.imageUrl})` : "linear-gradient(135deg, var(--blue), var(--cyan, #06B6D4))",
        position: "relative",
      }}>
        {!service.imageUrl && (
          <span style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 800, fontSize: 22,
          }}>{idx + 1}</span>
        )}
      </div>
      <div style={{ padding: "6px 8px", fontSize: 11, fontWeight: 700, lineHeight: 1.3, height: 32, overflow: "hidden" }}>
        {service.title || `שירות ${idx + 1}`}
      </div>
    </div>
  );
}

function OrganicSlotCard({
  idx, slot, services, onChange,
}: {
  idx: number;
  slot: OrganicSlot;
  services: Service[];
  onChange: (s: OrganicSlot) => void;
}) {
  const [over, setOver] = useState(false);
  const linked = slot.serviceId ? services.find(s => s.id === slot.serviceId) : undefined;

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData("text/x-service-id");
    if (id) onChange({ ...slot, serviceId: id, mode: "service" });
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      style={{
        position: "relative",
        aspectRatio: "1/1",
        background: linked?.imageUrl ? `center/cover url(${linked.imageUrl})` : "var(--paper)",
        border: "2px " + (over ? "solid var(--blue)" : (linked || slot.mode === "ai" ? "solid var(--rule)" : "dashed var(--rule-strong)")),
        borderRadius: "var(--r-2)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        transition: "border-color .15s",
      }}
    >
      {/* slot number */}
      <div style={{
        position: "absolute", top: 6, right: 6,
        width: 24, height: 24, borderRadius: "50%",
        background: "rgba(0,0,0,0.7)", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 800,
      }}>{idx + 1}</div>

      {/* AI mode badge */}
      {slot.mode === "ai" && (
        <div style={{
          position: "absolute", top: 6, left: 6,
          padding: "3px 8px",
          background: "var(--blue)",
          color: "#fff",
          fontSize: 10, fontWeight: 800,
          borderRadius: 999,
        }}>AI</div>
      )}

      {/* Empty / linked content */}
      {!linked && slot.mode !== "ai" && (
        <div style={{
          flex: 1,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 8, padding: 12, textAlign: "center",
          color: "var(--ink-3)",
        }}>
          <IcoInbox size={28} />
          <span style={{ fontSize: 11, fontWeight: 700, lineHeight: 1.3 }}>גרור שירות<br />או לחץ AI</span>
          <button
            type="button"
            onClick={() => onChange({ ...slot, mode: "ai", serviceId: undefined })}
            style={{
              padding: "4px 10px", fontSize: 11, fontWeight: 700,
              background: "linear-gradient(135deg, #8B5CF6, #06B6D4)",
              color: "#fff", border: 0, borderRadius: 999,
              cursor: "pointer",
            }}>צור עם AI</button>
        </div>
      )}

      {(linked || slot.mode === "ai") && (
        <>
          <div style={{ flex: 1 }} />
          <div style={{
            background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.85))",
            color: "#fff",
            padding: "20px 8px 6px",
            fontSize: 11, fontWeight: 800,
            lineHeight: 1.3,
          }}>
            {linked?.title || (slot.mode === "ai" ? "AI חופשי" : "")}
          </div>
          <button
            type="button"
            onClick={() => onChange({})}
            title="ניקוי משבצת"
            style={{
              position: "absolute", bottom: 6, left: 6,
              width: 22, height: 22, borderRadius: "50%",
              background: "rgba(0,0,0,0.7)", color: "#fff",
              border: 0, cursor: "pointer", fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}><IcoXMark size={14} /></button>
        </>
      )}
    </div>
  );
}

function AvatarSummary({ avatar }: { avatar: AvatarConfig }) {
  const parts: string[] = [];
  if (avatar.visualStyle)  parts.push(avatar.visualStyle);
  if (avatar.gender)       parts.push(avatar.gender);
  if (avatar.age)          parts.push(`גיל ${avatar.age}`);
  if (avatar.energy)       parts.push(avatar.energy);
  if (avatar.dress)        parts.push(avatar.dress);
  return (
    <div style={{
      display: "flex",
      gap: "var(--s-3)",
      alignItems: "center",
      padding: "var(--s-4)",
      background: "var(--paper)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-2)",
    }}>
      <div style={{
        width: 56, height: 56,
        borderRadius: "50%",
        background: avatar.skinTone || "linear-gradient(135deg, #8B5CF6, #06B6D4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden",
      }}><IcoPerson size={36} /></div>
      <div style={{ flex: 1 }}>
        <p className="t-eyebrow">פרזנטור</p>
        <p className="t-body" style={{ fontWeight: 700 }}>{avatar.description ?? "אווטר"}</p>
        <p className="t-meta" style={{ fontSize: 11 }}>{parts.join(" · ")}</p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Color picker — visual swatches, no HEX text input.
─────────────────────────────────────────────────────────────────────── */

const COLOR_SWATCHES = [
  "#1E3A8A", "#0EA5E9", "#06B6D4", "#10B981",
  "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6",
  "#14B8A6", "#84CC16", "#F97316", "#0F172A",
  "#FFFFFF", "#9CA3AF", "#1F2937", "#FBF9F4",
];

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const display = value && /^#[0-9A-Fa-f]{3,8}$/.test(value) ? value : "#FFFFFF";
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--ink-2)", marginBottom: 8 }}>{label}</label>
      <div style={{
        position: "relative",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-2)",
        background: "var(--paper)",
        padding: 12,
      }}>
        <label style={{ position: "relative", display: "block", cursor: "pointer" }}>
          <div style={{
            width: "100%", height: 56,
            background: display,
            borderRadius: "var(--r-1)",
            border: "1px solid var(--rule-strong)",
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: pickReadableTextColor(display),
            fontSize: 11, fontWeight: 700, letterSpacing: "0.05em",
          }}>
            <span>בחר צבע</span>
          </div>
          <input
            type="color"
            value={display}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            style={{
              position: "absolute", inset: 0, width: "100%", height: "100%",
              opacity: 0, cursor: "pointer",
            }}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 4, marginTop: 10 }}>
          {COLOR_SWATCHES.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              title={c}
              style={{
                width: "100%", aspectRatio: "1/1",
                background: c,
                border: c.toLowerCase() === display.toLowerCase() ? "2px solid var(--blue)" : "1px solid var(--rule-strong)",
                borderRadius: 4,
                cursor: "pointer",
                padding: 0,
                outline: "none",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function pickReadableTextColor(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6 && h.length !== 3) return "#000";
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#0B1430" : "#FFFFFF";
}

/* ─────────────────────────────────────────────────────────────────────
   Logo uploader with auto color extraction + "generate logo" entry.
─────────────────────────────────────────────────────────────────────── */

function LogoUploader({ value, onChange, onColorsExtracted, onGenerateClick }: {
  value?: string;
  onChange: (url: string | undefined) => void;
  /* Extracted dominant colors from the uploaded logo — up to 6. The first
     three feed the named brand slots (primary/secondary/accent); the next
     three feed the extra1/2/3 slots so the full 6-color palette is
     populated automatically when the agent uploads a multi-color logo. */
  onColorsExtracted: (colors: {
    primary?: string; secondary?: string; accent?: string;
    extra1?: string; extra2?: string; extra3?: string;
  }) => void;
  onGenerateClick: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function onFile(file: File) {
    setBusy(true); setError(null);
    try {
      // Logo path: keep PNG transparency, shrink to 800px max so the upload
      // is small but color-sampling still has plenty of pixels to read.
      const optimized = await optimizeImage(file, 800, 0.9);
      const dataUrl = await fileToDataUrl(optimized);
      const colors = await extractDominantColors(dataUrl, 6);
      if (colors.length >= 1) {
        const next: {
          primary?: string; secondary?: string; accent?: string;
          extra1?: string; extra2?: string; extra3?: string;
        } = {};
        if (colors[0]) next.primary   = colors[0];
        if (colors[1]) next.secondary = colors[1];
        if (colors[2]) next.accent    = colors[2];
        if (colors[3]) next.extra1    = colors[3];
        if (colors[4]) next.extra2    = colors[4];
        if (colors[5]) next.extra3    = colors[5];
        onColorsExtracted(next);
      }
      const fd = new FormData();
      fd.append("image", optimized, uploadName("logo", file));
      fd.append("name", uploadName("logo", file));
      fd.append("folder", "agent");
      const token = localStorage.getItem("cpanel_token");
      const res = await fetch("/api/upload-image", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json?.url) {
        onChange(dataUrl);
      } else {
        onChange(json.url);
      }
    } catch (e: any) {
      setError(e?.message || "שגיאה בהעלאת לוגו");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: 200 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--ink-2)", marginBottom: 8 }}>לוגו</label>
      <label
        onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
        onDrop={e => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          const img = Array.from(e.dataTransfer?.files ?? []).find(f => f.type.startsWith("image/"));
          if (img) onFile(img);
        }}
        style={{
        display: "block", cursor: busy ? "wait" : "pointer",
        position: "relative",
        width: 200, height: 200,
        border: dragOver ? "2px dashed var(--blue, #0000b2)" : value ? "1px solid var(--rule)" : "2px dashed var(--rule-strong)",
        borderRadius: "var(--r-3)",
        background: dragOver ? "var(--bg-tint)" : "var(--paper)",
        overflow: "hidden",
        transition: "border-color .15s, background .15s",
      }}>
        {value ? (
          <img src={resolveImgUrl(value)} alt="logo" style={{ width: "100%", height: "100%", objectFit: "contain", padding: 12 }} />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: "var(--ink-3)", gap: 8, padding: 16, textAlign: "center",
          }}>
            <IcoPalette size={42} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>{busy ? "מעלה..." : "העלה לוגו"}</span>
            <span style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.4 }}>הצבעים יחולצו אוטומטית</span>
          </div>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ""; }}
          disabled={busy}
          style={{ display: "none" }}
        />
      </label>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {!value && (
          <button
            type="button"
            onClick={onGenerateClick}
            style={{
              width: "100%", padding: "8px 10px",
              background: "linear-gradient(135deg, #8B5CF6, #06B6D4)",
              color: "#fff", border: 0, borderRadius: "var(--r-1)",
              fontSize: 12, fontWeight: 700, cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
            <IcoSparkle size={14} />
            צור לוגו אוטומטית
          </button>
        )}
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            style={{
              width: "100%", padding: "6px 10px",
              background: "transparent", color: "var(--negative)",
              border: "1px solid var(--negative)", borderRadius: "var(--r-1)",
              fontSize: 11, fontWeight: 700, cursor: "pointer",
            }}>
            הסר לוגו
          </button>
        )}
      </div>
      {error && <p style={{ marginTop: 6, fontSize: 11, color: "var(--negative)" }}>{error}</p>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Multiple client images uploader.
─────────────────────────────────────────────────────────────────────── */

function ImagesUploader({ values, onChange, max = 8 }: { values: string[]; onChange: (urls: string[]) => void; max?: number }) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const MAX = max;

  async function onFiles(files: FileList | File[]) {
    setBusy(true);
    try {
      const list: string[] = [...values];
      const token = localStorage.getItem("cpanel_token");
      for (const file of Array.from(files)) {
        if (list.length >= MAX) break;
        const optimized = await optimizeImage(file);
        const fd = new FormData();
        fd.append("image", optimized, uploadName("portfolio", file));
        fd.append("name", uploadName("portfolio", file));
        fd.append("folder", "agent");
        const res = await fetch("/api/upload-image", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: fd,
        });
        const json = await res.json();
        if (res.ok && json?.url) list.push(json.url);
        else list.push(await fileToDataUrl(optimized));
      }
      onChange(list);
    } finally { setBusy(false); }
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        const imgs = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith("image/"));
        if (imgs.length) onFiles(imgs);
      }}
      style={{
        borderRadius: "var(--r-2)", outlineOffset: 4,
        outline: dragOver ? "2px dashed var(--blue, #0000b2)" : "2px dashed transparent",
        background: dragOver ? "var(--bg-tint)" : "transparent",
        transition: "outline-color .15s, background .15s",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 12 }}>
        {values.map((url, i) => (
          <div key={i} style={{
            position: "relative", aspectRatio: "1/1",
            borderRadius: "var(--r-2)", overflow: "hidden",
            border: "1px solid var(--rule)",
          }}>
            <img src={resolveImgUrl(url)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <button
              type="button"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              style={{
                position: "absolute", top: 6, left: 6,
                width: 24, height: 24, borderRadius: "50%",
                background: "rgba(0,0,0,0.65)", color: "#fff",
                border: 0, cursor: "pointer", fontSize: 14, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
                backdropFilter: "blur(4px)",
              }}><IcoXMark size={14} /></button>
          </div>
        ))}
        {values.length < MAX && (
          <label style={{
            aspectRatio: "1/1", borderRadius: "var(--r-2)",
            border: "2px dashed var(--rule-strong)",
            background: "var(--bg-tint)",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 6, color: "var(--ink-3)",
            cursor: busy ? "wait" : "pointer", fontSize: 12, fontWeight: 700,
          }}>
            <span style={{ fontSize: 28 }}>+</span>
            <span>{busy ? "מעלה..." : "הוסף תמונה"}</span>
            <input type="file" multiple accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={e => { if (e.target.files?.length) onFiles(e.target.files); e.currentTarget.value = ""; }}
              style={{ display: "none" }} />
          </label>
        )}
      </div>
      <p style={{ marginTop: 8, fontSize: 11, color: dragOver ? "var(--blue, #0000b2)" : "var(--ink-3)", fontWeight: dragOver ? 700 : 400 }}>
        {dragOver ? "שחרר כאן להעלאה" : `${values.length}/${MAX} תמונות · לחץ או גרור ושחרר לכאן`}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Color extraction utilities (canvas-based).
─────────────────────────────────────────────────────────────────────── */

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Build a stable, server-safe upload name. The /api/upload-image endpoint
 * requires a non-empty `name` field — without it the server returns 400
 * and we silently fall back to embedding base64 data URLs in the doc,
 * which bloats characterization records past Mongo's 16MB cap.
 *
 * Strips path separators (which the server rejects as traversal attempts)
 * and any non-safe chars from the original filename, then prefixes a role
 * + timestamp so collisions across uploads can't overwrite each other.
 */
function uploadName(role: "service" | "logo" | "portfolio", file: File): string {
  const stem = (file.name || "img")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 60);
  return `${role}_${Date.now()}_${stem}.jpg`;
}

/**
 * Client-side image optimizer. Modern phone cameras produce 4–8MB JPEGs at
 * 4000×3000px — way too big for our use case (portfolio/logo/service thumbs
 * that never display larger than ~600px wide). We resize to fit MAX_EDGE on
 * the longer side and re-encode as JPEG quality 0.82. Net result for a 5MB
 * photo: ~250–400KB. Stops the upload-image 400 cascade AND keeps the
 * fallback-to-base64 path under Mongo's 16MB doc limit.
 *
 * Returns the original File if it's already small (< 400KB) and a JPEG —
 * no reason to re-encode an already-optimized asset and lose quality.
 */
async function optimizeImage(file: File, maxEdge = 2000, quality = 0.82): Promise<Blob> {
  if (file.size < 400 * 1024 && /jpeg|jpg/i.test(file.type)) return file;
  // PNG with transparency: keep PNG to preserve alpha (logos)
  const keepPng = file.type === "image/png";

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // browser can't decode — let the server reject if it's broken

  const { width: w, height: h } = bitmap;
  const longest = Math.max(w, h);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  bitmap.close?.();

  const mime = keepPng ? "image/png" : "image/jpeg";
  const q    = keepPng ? undefined  : quality;
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, q));
  if (!blob) return file;
  // Safety: if optimizer somehow produced a larger blob, keep original
  return blob.size < file.size ? blob : file;
}

async function extractDominantColors(dataUrl: string, count = 3): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const W = 80, H = Math.max(1, Math.round((img.height / img.width) * 80));
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      if (!ctx) return resolve([]);
      ctx.drawImage(img, 0, 0, W, H);
      const { data } = ctx.getImageData(0, 0, W, H);

      const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 200) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max > 245 && min > 245) continue;
        if (max < 20)               continue;
        const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
        const cur = buckets.get(key);
        if (cur) { cur.count++; cur.r += r; cur.g += g; cur.b += b; }
        else      buckets.set(key, { count: 1, r, g, b });
      }

      const sorted = [...buckets.values()]
        .map(b => ({ count: b.count, r: Math.round(b.r / b.count), g: Math.round(b.g / b.count), b: Math.round(b.b / b.count) }))
        .sort((a, b) => b.count - a.count);

      const picked: { r: number; g: number; b: number }[] = [];
      for (const c of sorted) {
        const distinct = picked.every(p => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) > 80);
        if (distinct) picked.push(c);
        if (picked.length >= count) break;
      }

      resolve(picked.map(c => `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, "0")).join("").toUpperCase()}`));
    };
    img.onerror = () => resolve([]);
    img.src = dataUrl;
  });
}

/* ─────────────────────────────────────────────────────────────────────
   Misc helpers.
─────────────────────────────────────────────────────────────────────── */

/* Inline category picker — replaces the old CategoryPicker modal.
   Two searchable comboboxes: main category + sub-category.
   The sub-category includes an "אחר — הזן ידנית" option that reveals
   a free-text input, so categories not in the canonical list don't
   block the manager. */
function CategoryInlinePicker({
  categoryKey,
  subCategoryKey,
  customSub,
  onChangeCategory,
  onChangeSubCategory,
  onChangeCustomSub,
}: {
  categoryKey: string;
  subCategoryKey: string;
  customSub: string;
  onChangeCategory: (key: string) => void;
  onChangeSubCategory: (key: string) => void;
  onChangeCustomSub: (v: string) => void;
}) {
  const cat = categoryByKey(categoryKey);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-4)" }}>
      <Field label="קטגוריה ראשית">
        <SearchableSelect
          value={categoryKey}
          options={CATEGORIES.map(c => ({ value: c.key, label: c.label }))}
          placeholder="הקלד או בחר קטגוריה…"
          onChange={onChangeCategory}
        />
      </Field>
      <Field label="תת-קטגוריה" hint={!cat ? "בחר קטגוריה ראשית קודם" : undefined}>
        <SearchableSelect
          value={subCategoryKey}
          options={cat ? cat.subCategories.map(s => ({ value: s.key, label: s.label })) : []}
          placeholder={cat ? "הקלד או בחר תת-קטגוריה…" : "—"}
          disabled={!cat}
          onChange={onChangeSubCategory}
        />
      </Field>
      {subCategoryKey === "other_input" && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Field label="תת-קטגוריה מותאמת">
            <Input
              value={customSub}
              onChange={e => onChangeCustomSub(e.target.value)}
              placeholder="הקלד את תת-הקטגוריה המותאמת"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/* Searchable select with PORTAL-rendered dropdown.
   The accordion / section wrappers around the Characterization tab
   set overflow:hidden in several places, which was clipping the
   dropdown to just the visible part of its parent and hiding most
   options. Rendering the dropdown into document.body via createPortal
   escapes every parent overflow and the dropdown can grow to its
   full maxHeight regardless of where it sits in the tree.

   Position is computed from the input's bounding rect on open and
   recalculated on scroll / resize so the dropdown stays anchored. */
function SearchableSelect({
  value,
  options,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  /* Anchor position for the portal-rendered dropdown. Recomputed on
     open + on window scroll/resize so the dropdown follows the input
     when the page moves under it. */
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; openUp: boolean; maxH: number } | null>(null);

  /* When `value` changes externally (or on mount), reflect its label
     in the input. Manager keeps the labelized value visible until they
     start typing. */
  const selectedLabel = options.find(o => o.value === value)?.label || "";
  const [draft, setDraft] = useState(selectedLabel);
  useEffect(() => { setDraft(selectedLabel); }, [selectedLabel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [query, options]);

  const recomputeAnchor = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - 16;
    const spaceAbove = r.top - 16;
    /* Prefer dropping down, but if the input is near the bottom of
       the viewport flip and open upwards so the manager sees the
       options instead of a clipped 1-row strip. */
    const openUp   = spaceBelow < 280 && spaceAbove > spaceBelow;
    const maxH     = Math.max(200, openUp ? spaceAbove : spaceBelow);
    setAnchor({ top: openUp ? r.top : r.bottom, left: r.left, width: r.width, openUp, maxH });
  }, []);

  useEffect(() => {
    if (!open) return;
    recomputeAnchor();
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        const dropdown = document.getElementById("__sds_dropdown_portal__");
        if (dropdown && dropdown.contains(e.target as Node)) return;
        setOpen(false);
        setQuery("");
        setDraft(selectedLabel);
      }
    }
    function onWindow() { recomputeAnchor(); }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("scroll", onWindow, true);
    window.addEventListener("resize", onWindow);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("scroll", onWindow, true);
      window.removeEventListener("resize", onWindow);
    };
  }, [open, selectedLabel, recomputeAnchor]);

  function pick(opt: { value: string; label: string }) {
    onChange(opt.value);
    setDraft(opt.label);
    setQuery("");
    setOpen(false);
  }

  const dropdown = open && !disabled && anchor && (
    <div
      id="__sds_dropdown_portal__"
      style={{
        position: "fixed",
        top:   anchor.openUp ? "auto" : anchor.top + 4,
        bottom: anchor.openUp ? window.innerHeight - anchor.top + 4 : "auto",
        left:  anchor.left,
        width: anchor.width,
        maxHeight: Math.min(480, anchor.maxH),
        overflowY: "auto",
        background: "var(--paper)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-2)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
        zIndex: 10000,
      }}
    >
      {filtered.length > 0 ? filtered.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onMouseDown={e => { e.preventDefault(); pick(opt); }}
          onMouseEnter={() => setHighlight(i)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "right",
            padding: "10px 14px",
            background: i === highlight ? "var(--bg-tint)" : "transparent",
            border: "none",
            borderBottom: "1px solid var(--rule)",
            cursor: "pointer",
            fontSize: 13,
            color: opt.value === value ? "var(--blue)" : "var(--ink)",
            fontWeight: opt.value === value ? 700 : 500,
          }}
        >
          {opt.label}
        </button>
      )) : (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--ink-3)" }}>לא נמצאה התאמה</div>
      )}
    </div>
  );

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <Input
        value={open ? query : draft}
        onChange={e => { setQuery(e.target.value); setHighlight(0); if (!open) setOpen(true); }}
        onFocus={() => { if (!disabled) { setOpen(true); setQuery(""); } }}
        onKeyDown={e => {
          if (!open) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && filtered[highlight]) { e.preventDefault(); pick(filtered[highlight]); }
          else if (e.key === "Escape") { setOpen(false); setQuery(""); setDraft(selectedLabel); }
        }}
        placeholder={placeholder}
        disabled={disabled}
      />
      {dropdown && createPortal(dropdown, document.body)}
    </div>
  );
}

/* iOS-style toggle row — used for the phone/address contact-info
   opt-ins on the Characterization tab. Kept inline because it's the
   only place in cpanel that uses this exact shape (label + switch). */
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-2)",
        background: "var(--paper)",
        cursor: "pointer",
        gap: "var(--s-3)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{label}</span>
      <span
        role="switch"
        aria-checked={checked}
        style={{
          position: "relative",
          width: 38,
          height: 22,
          borderRadius: 999,
          background: checked ? "var(--positive, #16a34a)" : "var(--rule-strong, #cbd5e1)",
          transition: "background 0.15s ease",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            insetInlineStart: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            transition: "inset-inline-start 0.15s ease",
          }}
        />
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}
      />
    </label>
  );
}

function SubHead({ title, meta, action }: { title: string; meta?: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s-3)", marginBottom: "var(--s-4)" }}>
      <div>
        <h4 style={{ font: "inherit", fontSize: 15, fontWeight: 800, color: "var(--ink)", margin: 0 }}>{title}</h4>
        {meta && <p className="t-meta" style={{ fontSize: 11, marginTop: 2 }}>{meta}</p>}
      </div>
      {action}
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card">
      <p className="t-eyebrow" style={{ color: "var(--negative)" }}>שגיאה</p>
      <p className="t-body" style={{ marginTop: "var(--s-3)" }}>{message}</p>
      <div style={{ marginTop: "var(--s-5)" }}>
        <Button onClick={onRetry}>נסה שוב</Button>
      </div>
    </div>
  );
}

// Avoid unused-import warnings if CATEGORIES is only used implicitly
void CATEGORIES;
/* SectionHead is intentionally kept available for future re-use though not currently rendered. */
void SectionHead;
