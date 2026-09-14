import { useCallback, useEffect, useMemo, useState } from "react";
import {
  generateWowLp, getWowLp, regenerateWowLpImage, uploadWowLpImage, sendWowLpForApproval, patchWowLp,
  getClients, resolveImgUrl,
  deployLpToNetlify,
  WOW_LP_V2_TEMPLATES,
  COIN_COSTS,
  type WowLpSession,
  type WowLpV2TemplateId,
} from "../../api/client";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { IcoFile, IcoRefresh, IcoSend, IcoCheck, IcoEdit, IcoX, IcoChevronDown, IcoChevronRight } from "../icons/Icons";
import { IcoSparkle, IcoStatusDot, IcoStar } from "../icons/BrandIcons";

interface Props { phone: string; logoUrl?: string; quota?: number | null; coinsRemaining?: number; onCoinsChanged?: () => void }

/* ──────────────────────────────────────────────────────────────────────
   CONSTANTS — extracted from NEW AI BUILD project (ThemePanel.tsx, fonts.ts, theme.ts)
   ────────────────────────────────────────────────────────────────────── */

const COLOR_PRESETS: { id: string; label: string; primary: string; secondary: string; accent: string }[] = [
  { id: "corporate-blue",  label: "Corporate Blue", primary: "#0ea5e9", secondary: "#0f172a", accent: "#f59e0b" },
  { id: "natural-green",   label: "Natural Green",  primary: "#10b981", secondary: "#064e3b", accent: "#fbbf24" },
  { id: "royal-purple",    label: "Royal Purple",   primary: "#8b5cf6", secondary: "#1e1b4b", accent: "#ec4899" },
  { id: "energetic-red",   label: "Energetic Red",  primary: "#ef4444", secondary: "#1f2937", accent: "#f97316" },
  { id: "fresh-teal",      label: "Fresh Teal",     primary: "#06b6d4", secondary: "#134e4a", accent: "#f59e0b" },
  { id: "modern-pink",     label: "Modern Pink",    primary: "#ec4899", secondary: "#831843", accent: "#fbbf24" },
  { id: "warm-earth",      label: "Warm Earth",     primary: "#d97706", secondary: "#292524", accent: "#84cc16" },
  { id: "monochrome",      label: "Monochrome",     primary: "#374151", secondary: "#0f172a", accent: "#9ca3af" },
];

const DARK_TONES = [
  { label: "כהה",       value: "#0f172a" },
  { label: "פחם",       value: "#1f2937" },
  { label: "כחול לילה", value: "#0b1422" },
  { label: "חום",       value: "#3f2e1f" },
  { label: "ירוק יער",  value: "#1a3026" },
  { label: "כתום עמוק", value: "#3a1a06" },
  { label: "סגול ליל",  value: "#1f1235" },
  { label: "בורדו",     value: "#3a0d1a" },
];

const LIGHT_TONES = [
  { label: "לבן",        value: "#ffffff" },
  { label: "קרם",        value: "#fdfaf4" },
  { label: "אפור בהיר",  value: "#f7f8fa" },
  { label: "ורוד עדין",  value: "#fdf6f3" },
  { label: "כחלחל",      value: "#f3f7fb" },
  { label: "ירקרק",      value: "#f4f9f5" },
];

const FONT_FAMILIES = [
  { id: "Heebo",            label: "Heebo (ברירת מחדל)", desc: "עברי, רב-תכליתי" },
  { id: "Rubik",            label: "Rubik",              desc: "מעוגל ונגיש" },
  { id: "Assistant",        label: "Assistant",          desc: "מינימליסטי נקי" },
  { id: "Inter",            label: "Inter",              desc: "מודרני sans" },
  { id: "Noto Sans Hebrew", label: "Noto Sans Hebrew",   desc: "ניטרלי" },
  { id: "Frank Ruhl Libre", label: "Frank Ruhl Libre",   desc: "סריף קלאסי" },
  { id: "Secular One",      label: "Secular One",        desc: "תצוגה מודגשת" },
  { id: "Varela Round",     label: "Varela Round",       desc: "מעוגל אסתטי" },
  { id: "Space Grotesk",    label: "Space Grotesk",      desc: "טכנולוגי" },
  { id: "Playfair Display", label: "Playfair Display",   desc: "סריף אלגנטי" },
  { id: "Montserrat",       label: "Montserrat",         desc: "בינלאומי" },
  { id: "Poppins",          label: "Poppins",            desc: "ידידותי מודרני" },
];

const FONT_STYLES = [
  { id: "modern",   label: "מודרני (tracking הדוק)" },
  { id: "bold",     label: "מודגש (tracking צמוד)" },
  { id: "elegant",  label: "אלגנטי (tracking רחב)" },
  { id: "playful",  label: "שובב (extra-bold)" },
];

const HEADING_SCALES = [
  { id: "sm", label: "קטן (0.85x)",   mul: 0.85 },
  { id: "md", label: "רגיל (1.0x)",  mul: 1.0  },
  { id: "lg", label: "גדול (1.15x)", mul: 1.15 },
  { id: "xl", label: "ענק (1.3x)",   mul: 1.3  },
];
const BODY_SCALES = [
  { id: "sm", label: "קטן (0.9x)",  mul: 0.9 },
  { id: "md", label: "רגיל (1.0x)", mul: 1.0 },
  { id: "lg", label: "גדול (1.1x)", mul: 1.1 },
  { id: "xl", label: "ענק (1.2x)",  mul: 1.2 },
];

const HERO_LAYOUTS = [
  { id: "centered", label: "ממורכז (תמונה מלאה ברקע)" },
  { id: "split",    label: "מפוצל (טקסט+תמונה צד-צד)" },
  { id: "minimal",  label: "מינימלי (טקסט בלבד)" },
];
const SERVICES_LAYOUTS = [
  { id: "cards",       label: "כרטיסיות (Bento grid)" },
  { id: "alternating", label: "מתחלף (טקסט/תמונה לסירוגין)" },
  { id: "icon-list",   label: "רשימת אייקונים" },
];
const ABOUT_LAYOUTS = [
  { id: "image-left",  label: "תמונה משמאל" },
  { id: "image-right", label: "תמונה מימין" },
  { id: "full-width",  label: "רוחב מלא (ללא תמונה)" },
];
const TESTIMONIALS_STYLES = [
  { id: "dark",    label: "כהה (glassmorphism)" },
  { id: "light",   label: "בהיר" },
  { id: "colored", label: "צבעוני (מותג)" },
];

const SECTION_PADDING = {
  compact:  { y: 64,  yMd: 80  },
  normal:   { y: 112, yMd: 144 },
  spacious: { y: 128, yMd: 176 },
};
const CONTAINER_WIDTH = {
  narrow: 960,
  normal: 1200,
  wide:   1440,
};

const ALL_SECTIONS: { key: string; label: string }[] = [
  { key: "hero",         label: "Hero" },
  { key: "about",        label: "About / אודות" },
  { key: "services",     label: "Services / שירותים" },
  { key: "why_us",       label: "Why Us / למה אנחנו" },
  { key: "process",      label: "Process / תהליך" },
  { key: "testimonials", label: "Testimonials / המלצות" },
  { key: "faq",          label: "FAQ / שאלות" },
  { key: "final_cta",    label: "Final CTA" },
];

const STATUS_LABELS: Record<string, string> = {
  generating_content: "מייצר תוכן (1/2)",
  generating_images:  "מייצר תמונות hero (2/2)",
  done:               "הושלם",
  error:              "שגיאה",
};

/* ──────────────────────────────────────────────────────────────────────
   THEME HELPERS
   ────────────────────────────────────────────────────────────────────── */

function themeDefaults(t: any) {
  return {
    primaryColor:      t?.primaryColor      ?? "#1E3A8A",
    secondaryColor:    t?.secondaryColor    ?? "#06B6D4",
    accentColor:       t?.accentColor       ?? "#10B981",
    headingColor:      t?.headingColor      ?? t?.secondaryColor ?? "#0F172A",
    bodyColor:         t?.bodyColor         ?? "#4b5563",
    pageBgColor:       t?.pageBgColor       ?? "#ffffff",
    sectionBgColor:    t?.sectionBgColor    ?? t?.secondaryColor ?? "#0F172A",
    overlayOpacity:    t?.overlayOpacity    ?? 0.45,
    headingScale:      t?.headingScale      ?? "md",
    bodyScale:         t?.bodyScale         ?? "md",
    radius:            t?.radius            ?? 12,
    sectionPadding:    t?.sectionPadding    ?? "normal",
    containerWidth:    t?.containerWidth    ?? "normal",
    heroLayout:        t?.heroLayout        ?? "centered",
    servicesLayout:    t?.servicesLayout    ?? "cards",
    aboutLayout:       t?.aboutLayout       ?? "image-right",
    testimonialsStyle: t?.testimonialsStyle ?? "dark",
    fontFamily:        t?.fontFamily        ?? "Heebo",
    fontStyle:         t?.fontStyle         ?? "modern",
    hiddenSections:    Array.isArray(t?.hiddenSections) ? t.hiddenSections : [],
    sectionOrder:      Array.isArray(t?.sectionOrder) && t.sectionOrder.length === ALL_SECTIONS.length
                          ? t.sectionOrder
                          : ALL_SECTIONS.map(s => s.key),
  };
}

/* Backfill header/footer for sessions created before the prompt was updated.
   Uses brief data as the source of truth for sensible defaults. */
function withHeaderFooterFallback(lp: any, session: any): any {
  const brief = session?.brief || {};
  const businessName = brief.businessName || "העסק שלך";

  const next = { ...lp };

  /* Header — fill in when missing OR when saved object is empty/incomplete */
  const initials = String(businessName).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w.charAt(0)).join("").toUpperCase() || "K";
  const defaultHeader = {
    logoText: businessName.length <= 12 ? businessName : initials,
    navItems: [
      { label: "אודות",     href: "#about" },
      { label: "שירותים",   href: "#services" },
      { label: "תהליך",      href: "#process" },
      { label: "צור קשר",   href: "#contact" },
    ],
    ctaText: lp.hero?.ctaText || "צור קשר",
  };
  next.header = {
    ...defaultHeader,
    ...(typeof next.header === "object" && next.header ? next.header : {}),
  };
  if (!Array.isArray(next.header.navItems) || next.header.navItems.length === 0) {
    next.header.navItems = defaultHeader.navItems;
  }
  if (!next.header.logoText) next.header.logoText = defaultHeader.logoText;
  if (!next.header.ctaText)  next.header.ctaText  = defaultHeader.ctaText;

  /* Footer — same robust merge */
  const defaultFooter = {
    tagline:      lp.brand_strategy?.tagline || lp.about?.heading || `${businessName} · שירות מקצועי`,
    contactPhone: brief.phone || "",
    contactEmail: brief.email || "",
    address:      brief.address || "",
    hours:        "א'–ה' · 09:00–18:00",
    copyright:    `© ${new Date().getFullYear()} ${businessName}. כל הזכויות שמורות.`,
  };
  next.footer = {
    ...defaultFooter,
    ...(typeof next.footer === "object" && next.footer ? next.footer : {}),
  };

  return next;
}

function fontStackFor(family: string): string {
  return `'${family}', 'Heebo', 'Inter', system-ui, sans-serif`;
}

function loadGoogleFont(family: string) {
  if (typeof document === "undefined") return;
  const id = `gf-${family.replace(/\s+/g, "-")}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;500;700;800;900&display=swap`;
  document.head.appendChild(link);
}

function trackingFor(style: string): string {
  if (style === "bold")    return "-0.025em";
  if (style === "elegant") return "0.04em";
  if (style === "playful") return "0";
  return "-0.015em";
}

/* ──────────────────────────────────────────────────────────────────────
   MAIN PANEL
   ────────────────────────────────────────────────────────────────────── */

export function WowLpPanel({ phone, logoUrl, quota, coinsRemaining, onCoinsChanged }: Props) {
  void quota; // LP is single-instance per package; gate exists at ProductsTab via items.lps > 0
  const toast = useToast();
  const [session, setSession]       = useState<WowLpSession | null>(null);
  const [loading, setLoading]       = useState(true);
  const [generating, setGen]        = useState(false);
  const [sending, setSending]       = useState(false);
  const [regenSec, setRegenSec]     = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [resolvedLogoUrl, setResolvedLogoUrl] = useState<string | undefined>(logoUrl);

  // Fall back to client record's logoUrl if bp.logoUrl isn't set
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
      const r = await getWowLp(phone);
      setSession(r.session);
    } finally { setLoading(false); }
  }, [phone]);

  useEffect(() => { load(); }, [load]);

  const inFlight = session?.status && session.status !== "done" && session.status !== "error";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [inFlight, load]);

  /* Load the active font for live preview */
  useEffect(() => {
    const family = session?.design_theme?.fontFamily || "Heebo";
    loadGoogleFont(family);
  }, [session?.design_theme?.fontFamily]);

  /* Resolve relative /api/img URLs to absolute — must be before any early return */
  const images = useMemo(
    () => (session?.images ?? []).map(i => ({ ...i, url: resolveImgUrl(i.url) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.images]
  );

  /* Optional manual template override. When null the v2 service runs
     pickTemplateWithAI; otherwise it forces the chosen template. The
     dropdown sits next to the generate button. */
  const [forceTemplate, setForceTemplate] = useState<WowLpV2TemplateId | "">("");

  async function start() {
    setGen(true);
    try {
      await generateWowLp(phone, forceTemplate || null);
      toast.ok(
        forceTemplate
          ? `מייצר דף נחיתה עם ${forceTemplate} — ייקח כדקה`
          : "מתחיל לייצר דף נחיתה — תהליך AI ייקח כדקה"
      );
      await load();
      onCoinsChanged?.();
    } catch (err: any) {
      const msg = err?.message ?? "שגיאה";
      if (msg.includes("חסרים שדות") || msg.includes("INCOMPLETE")) {
        toast.error("האיפיון לא שלם — מלא את כל השדות בטאב 'איפיון'");
      } else if (msg.includes("NO_PACKAGE")) {
        toast.error("ללקוח אין חבילה פעילה — רכוש חבילה בטאב 'חיוב'");
      } else if (msg.includes("INSUFFICIENT_COINS")) {
        toast.error("אין מספיק מטבעות לפעולה זו");
      } else toast.error(msg);
    } finally { setGen(false); }
  }

  async function regenerate(section: string) {
    setRegenSec(section);
    try {
      await regenerateWowLpImage(phone, section);
      await load();
      toast.ok("התמונה רעוננה");
      onCoinsChanged?.();
    } catch (err: any) {
      const msg = err?.message ?? "שגיאה";
      if (msg.includes("INSUFFICIENT_COINS")) toast.error("אין מספיק מטבעות לרענון התמונה");
      else toast.error(msg);
    }
    finally { setRegenSec(null); }
  }

  async function uploadImage(section: string, file: File) {
    setRegenSec(section);
    try {
      await uploadWowLpImage(phone, section, file);
      await load();
      toast.ok("התמונה הועלתה");
    } catch (err: any) { toast.error(err?.message ?? "שגיאה בהעלאה"); }
    finally { setRegenSec(null); }
  }

  async function sendApproval() {
    setSending(true);
    try {
      const r = await sendWowLpForApproval(phone);
      setPreviewUrl(r.previewUrl);
      toast.ok("נוצר קישור לאישור הלקוח");
      await load();
    } catch (err: any) { toast.error(err?.message ?? "שגיאה"); }
    finally { setSending(false); }
  }

  /* "🚀 פרסם ל-Netlify" — zips the rendered HTML and ships it to
     Netlify as a 1-file static site. First click creates a new site
     + URL; every click after that redeploys to the same site so the
     URL stays stable. */
  const [deploying, setDeploying] = useState(false);
  async function deployToNetlify() {
    if (!window.confirm("לפרסם את דף הנחיתה ל-Netlify? הקישור יהיה זמין מיד.")) return;
    setDeploying(true);
    try {
      const r = await deployLpToNetlify(phone);
      toast.ok("פורסם בהצלחה 🚀");
      /* Refresh the session so the new netlifySiteUrl shows up in
         the banner without a reload. */
      await load();
      /* Open the live URL in a new tab for instant verification. */
      if (r.url) window.open(r.url, "_blank", "noopener");
    } catch (err: any) {
      const msg = err?.message ?? "פרסום נכשל";
      toast.error(msg.includes("NETLIFY_API_TOKEN") ? "Netlify לא מוגדר בשרת — פנה לאדמין" : msg);
    } finally {
      setDeploying(false);
    }
  }

  async function applyPatches(patches: { path: (string | number)[]; value: unknown }[]) {
    if (patches.length === 0) return;
    try {
      const r = await patchWowLp(phone, patches);
      setSession(r.session);
    } catch (err: any) { toast.error(err?.message ?? "שגיאה בשמירה"); }
  }

  if (loading) return <div style={{ padding: "var(--s-7)", textAlign: "center", color: "var(--ink-3)" }}>טוען...</div>;

  const ready = session?.status === "done";
  const errored = session?.status === "error";
  const lp = session?.landing_page;
  const theme = themeDefaults(session?.design_theme);

  return (
    <section className="section" style={{ marginTop: 0 }}>
      {/* Status banner */}
      <div className="card-grad-border" style={{
        padding: "var(--s-5)",
        marginBottom: "var(--s-5)",
        background: `radial-gradient(at 0% 100%, rgba(30,58,138,0.05) 0%, transparent 50%), var(--surface)`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap" }}>
          <div style={{
            width: 48, height: 48,
            borderRadius: "var(--r-2)",
            background: "var(--grad-violet)",
            color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "var(--sh-brand)",
          }}>
            <IcoFile size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7C3AED", letterSpacing: "0.14em", textTransform: "uppercase" }}>
              WOW Landing Page · דף נחיתה AI
            </div>
            <h3 style={{ fontSize: "var(--t-lg)", fontWeight: 800, color: "var(--ink)", margin: "4px 0 0" }}>
              {session ? STATUS_LABELS[session.status] || session.status : "ייצור דף נחיתה מלא"}
            </h3>
            <p style={{ fontSize: "var(--t-sm)", color: "var(--ink-3)", marginTop: 4, lineHeight: 1.5 }}>
              {!session && "OpenAI מייצר 10 סקציות, וGemini מייצר 6 תמונות hero. אחרי הייצור — מסך עריכה מלא: צבעים, רקעים, פריסות, טיפוגרפיה, סקציות ותוכן."}
              {inFlight && session?.completedImages != null && `${session.completedImages}/${session.totalImages || 6} תמונות מוכנות`}
              {ready && <><IcoCheck size={13} color="var(--positive, #16a34a)" /> {`דף נחיתה מוכן · ${images.filter(i => i.url).length} תמונות`}</>}
              {errored && (session.error || "תקלה בייצור — נסה שוב")}
            </p>
          </div>

          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap", alignItems: "center" }}>
            {(!session || ready || errored) && (
              <select
                value={forceTemplate}
                onChange={e => setForceTemplate(e.target.value as WowLpV2TemplateId | "")}
                style={{
                  height: 40, padding: "0 var(--s-3)",
                  borderRadius: "var(--r-2)",
                  border: "1px solid var(--rule)",
                  background: "var(--surface)",
                  fontSize: "var(--t-sm)",
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
                title="בחר template ידנית או השאר על אוטומטי כדי שה-AI יבחר"
              >
                <option value="">אוטומטי (AI בוחר)</option>
                {WOW_LP_V2_TEMPLATES.map(t => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            )}
            {(!session || ready || errored) && (() => {
              const lowOnCoins = coinsRemaining != null && coinsRemaining < COIN_COSTS.GENERATE_LP;
              return (
                <Button
                  onClick={start}
                  loading={generating}
                  size="lg"
                  disabled={lowOnCoins}
                  title={`עלות: ${COIN_COSTS.GENERATE_LP} מטבעות${coinsRemaining != null ? ` · יתרה: ${coinsRemaining}` : ""}`}
                  style={{ background: "var(--grad-violet)", color: "#fff", border: "none" }}
                >
                  {lowOnCoins
                    ? `אין מספיק מטבעות (−${COIN_COSTS.GENERATE_LP})`
                    : ready
                      ? `ייצר מחדש (−${COIN_COSTS.GENERATE_LP})`
                      : `ייצר דף נחיתה (−${COIN_COSTS.GENERATE_LP})`}
                </Button>
              );
            })()}
            {ready && (
              <Button onClick={() => setEditorOpen(true)} size="lg" variant="ghost">
                <IcoEdit size={14} /> ערוך דף
              </Button>
            )}
            {ready && session?.approvalStatus !== "approved" && (
              <Button onClick={sendApproval} loading={sending} size="lg" variant="ghost">
                <IcoSend size={14} /> שלח לאישור
              </Button>
            )}
            {ready && (
              <Button
                onClick={deployToNetlify}
                loading={deploying}
                disabled={deploying}
                size="lg"
                style={{ background: "linear-gradient(135deg,#0ea5e9 0%,#7C3AED 100%)", color: "#fff", border: "none" }}
                title={session?.netlifySiteUrl ? "פרסום מחדש לאותו דומיין" : "יוצר אתר חדש ב-Netlify"}
              >
                🚀 {session?.netlifySiteUrl ? "פרסם מחדש" : "פרסם ל-Netlify"}
              </Button>
            )}
            {inFlight && <span className="pulse-dot" style={{ alignSelf: "center" }} />}
          </div>
        </div>

        {inFlight && (
          <div style={{ marginTop: "var(--s-4)" }}>
            <div style={{ height: 6, background: "var(--bg-tint)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${session?.completedImages != null ? Math.max(8, ((session.completedImages || 0) / Math.max(1, session.totalImages || 6)) * 100) : 12}%`,
                background: "var(--grad-violet)",
                transition: "width 600ms var(--ease-out)",
                boxShadow: "0 0 12px rgba(124,58,237,0.5)",
              }} />
            </div>
          </div>
        )}

        {previewUrl && (
          <div style={{ marginTop: "var(--s-4)", padding: "var(--s-3)", background: "var(--positive-bg)", border: "1px solid rgba(16,185,129,0.30)", borderRadius: "var(--r-2)" }}>
            <div style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "var(--positive)", marginBottom: 4 }}>
              <IcoCheck size={12} /> קישור לאישור נוצר
            </div>
            <a href={previewUrl} target="_blank" rel="noreferrer" dir="ltr" style={{ fontSize: "var(--t-xs)", color: "var(--blue)", wordBreak: "break-all" }}>
              {previewUrl}
            </a>
          </div>
        )}

        {session?.netlifySiteUrl && (
          <div style={{ marginTop: "var(--s-4)", padding: "var(--s-3)", background: "rgba(14,165,233,0.08)", border: "1px solid rgba(124,58,237,0.30)", borderRadius: "var(--r-2)" }}>
            <div style={{ fontSize: "var(--t-xs)", fontWeight: 700, color: "#7C3AED", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              🚀 פורסם ל-Netlify
              {session.netlifyDeployedAt && (
                <span style={{ fontSize: 10, fontWeight: 500, color: "var(--ink-3)" }}>
                  · {new Date(session.netlifyDeployedAt).toLocaleString("he-IL")}
                </span>
              )}
            </div>
            <a
              href={session.netlifySiteUrl}
              target="_blank"
              rel="noreferrer"
              dir="ltr"
              style={{ fontSize: "var(--t-sm)", color: "var(--blue)", wordBreak: "break-all", fontWeight: 600 }}
            >
              {session.netlifySiteUrl}
            </a>
          </div>
        )}

        {session?.approvalStatus && session.approvalStatus !== "draft" && (
          <div style={{ marginTop: "var(--s-3)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "3px 10px",
              borderRadius: 999,
              background:
                session.approvalStatus === "approved" ? "var(--positive-bg)" :
                session.approvalStatus === "rejected" ? "var(--negative-bg)" : "var(--blue-soft)",
              color:
                session.approvalStatus === "approved" ? "var(--positive)" :
                session.approvalStatus === "rejected" ? "var(--negative)" : "var(--blue)",
            }}>
              {session.approvalStatus === "sent"     ? <><IcoStatusDot size={7} /> נשלח לאישור</> :
               session.approvalStatus === "approved" ? <><IcoCheck size={13} /> הלקוח אישר</> :
               <><IcoX size={13} /> הלקוח דחה</>}
            </span>
            {session.clientFeedback && (
              <span style={{ fontSize: "var(--t-xs)", color: "var(--ink-2)" }}>"{session.clientFeedback}"</span>
            )}
          </div>
        )}
      </div>

      {/* Full LP preview */}
      {ready && lp && (
        <LpPreview
          lp={withHeaderFooterFallback(lp, session)}
          theme={theme}
          images={images}
          regenSec={regenSec}
          onRegenerate={regenerate}
          onUpload={uploadImage}
          logoUrl={resolvedLogoUrl}
        />
      )}

      {/* v2 LP preview — sessions produced by runLpPipelineV2 only
         carry session.html (no structured landing_page tree), so the
         legacy LpPreview can't render them. We show the raw HTML in
         a sandboxed iframe instead. Same place in the layout so the
         '🚀 פרסם ל-Netlify' button keeps its mental position. */}
      {ready && !lp && session?.html && (
        <V2Preview html={session.html} session={session} />
      )}

      {/* Editor */}
      {editorOpen && lp && (
        <LpEditor lp={lp} theme={theme} onClose={() => setEditorOpen(false)} onPatch={applyPatches} />
      )}

      {!session && (
        <div className="empty" style={{ marginTop: "var(--s-5)" }}>
          <p className="empty-title">עדיין לא נוצר דף נחיתה</p>
          <p className="empty-meta">
            לחץ "ייצר דף נחיתה" — ה-AI ינתח את האיפיון, ייצר 10 סקציות בעברית (header, hero, about, services, why_us, process, testimonials, faq, final_cta, footer), ויפיק 6 תמונות hero. אחרי הייצור — מסך עריכה מלא.
          </p>
        </div>
      )}
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   LP PREVIEW — full rendering with theme + variants + section order/visibility
   ────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────
   V2 PREVIEW — agency-template renders (sess.html only, no JSON tree)
   ────────────────────────────────────────────────────────────────────── */
function V2Preview({ html, session }: { html: string; session: WowLpSession }) {
  const summary = session?.v2;
  return (
    <div style={{
      marginTop: "var(--s-5)",
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      overflow: "hidden",
      background: "var(--surface)",
    }}>
      <div style={{
        padding: "var(--s-3) var(--s-4)",
        background: "var(--bg-tint)",
        borderBottom: "1px solid var(--rule)",
        display: "flex",
        gap: "var(--s-3)",
        alignItems: "center",
        flexWrap: "wrap",
        fontSize: "var(--t-xs)",
        color: "var(--ink-2)",
      }}>
        <strong style={{ color: "var(--ink)" }}>
          {session.templateName || summary?.templateName || "template v2"}
        </strong>
        {summary?.placeholderCount != null && (
          <span>{summary.valueCount}/{summary.placeholderCount} שדות</span>
        )}
        {summary?.imagesTotal != null && summary.imagesTotal > 0 && (
          <span>{summary.imagesGenerated}/{summary.imagesTotal} תמונות יוצרו</span>
        )}
        {summary?.sectionsTotal != null && (
          <span>{summary.sectionsTotal} סקציות{summary.sectionsAdded ? ` (+${summary.sectionsAdded} AI)` : ""}</span>
        )}
      </div>
      <iframe
        title="LP Preview"
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        style={{
          display: "block",
          width: "100%",
          height: "75vh",
          border: 0,
          background: "#fff",
        }}
      />
    </div>
  );
}

function LpPreview({ lp, theme, images, regenSec, onRegenerate, onUpload, logoUrl }: {
  lp: any;
  theme: ReturnType<typeof themeDefaults>;
  images: { section: string; url?: string }[];
  regenSec: string | null;
  onRegenerate: (section: string) => void;
  onUpload?: (section: string, file: File) => void;
  logoUrl?: string;
}) {
  const headingMul = HEADING_SCALES.find(s => s.id === theme.headingScale)?.mul ?? 1;
  const bodyMul    = BODY_SCALES.find(s => s.id === theme.bodyScale)?.mul ?? 1;
  const padding    = SECTION_PADDING[theme.sectionPadding as keyof typeof SECTION_PADDING] || SECTION_PADDING.normal;
  const containerMaxWidth = CONTAINER_WIDTH[theme.containerWidth as keyof typeof CONTAINER_WIDTH] || CONTAINER_WIDTH.normal;

  const cssVars = {
    "--lp-radius":     `${theme.radius}px`,
    "--lp-primary":    theme.primaryColor,
    "--lp-secondary":  theme.secondaryColor,
    "--lp-accent":     theme.accentColor,
    "--lp-heading":    theme.headingColor,
    "--lp-body":       theme.bodyColor,
    "--lp-pad-y":      `${padding.y}px`,
    "--lp-pad-y-md":   `${padding.yMd}px`,
    "--lp-container":  `${containerMaxWidth}px`,
    "--lp-tracking":   trackingFor(theme.fontStyle),
    fontFamily: fontStackFor(theme.fontFamily),
    fontSize: `${(16 * bodyMul).toFixed(2)}px`,
    background: theme.pageBgColor,
    color: theme.bodyColor,
  } as React.CSSProperties;

  const visibleSections: string[] = theme.sectionOrder.filter((k: string) => !theme.hiddenSections.includes(k));

  return (
    <div style={{
      ...cssVars,
      border: "1px solid var(--rule)",
      borderRadius: "var(--r-3)",
      overflow: "hidden",
    }}>
      {/* Header — always rendered (fallback ensures lp.header exists) */}
      <HeaderBar lp={lp} theme={theme} logoUrl={logoUrl} />

      {/* Sections in user-defined order */}
      {visibleSections.map((key: string) => {
        switch (key) {
          case "hero":         return <HeroSection         key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          case "about":        return <AboutSection        key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          case "why_us":       return <WhyUsSection        key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          case "process":      return <ProcessSection      key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          case "testimonials": return <TestimonialsSection key={key} lp={lp} theme={theme} headingMul={headingMul} />;
          case "faq":          return <FaqSection          key={key} lp={lp} theme={theme} headingMul={headingMul} />;
          case "final_cta":    return <FinalCtaSection     key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          case "services":     return <ServicesSection     key={key} lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
          default: return null;
        }
      })}

      {/* Footer */}
      {lp.footer && <FooterBar lp={lp} theme={theme} logoUrl={logoUrl} />}
    </div>
  );
}

/* ── Header / Footer ────────────────────────────────────────────── */

function HeaderBar({ lp, theme, logoUrl }: any) {
  const header = lp.header || {};
  return (
    <header style={{
      padding: "14px 32px",
      borderBottom: `1px solid ${theme.bodyColor}14`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 16,
      background: theme.pageBgColor,
      position: "sticky", top: 0, zIndex: 50,
      backdropFilter: "blur(12px) saturate(180%)",
      WebkitBackdropFilter: "blur(12px) saturate(180%)",
      boxShadow: `0 1px 0 ${theme.bodyColor}10`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        {logoUrl ? (
          <img
            src={logoUrl}
            alt=""
            style={{ height: 36, width: "auto", maxWidth: 120, objectFit: "contain", borderRadius: 6, display: "block" }}
          />
        ) : (
          <div style={{
            padding: "6px 14px",
            background: theme.primaryColor, color: "#fff",
            borderRadius: 8,
            fontSize: 14, fontWeight: 800, letterSpacing: 0.5,
          }}>{header.logoText || "BRAND"}</div>
        )}
        <nav style={{ display: "flex", gap: 24 }}>
          {(header.navItems || []).map((n: any, i: number) => (
            <span key={i} style={{ fontSize: 13, fontWeight: 600, color: theme.bodyColor, opacity: 0.78 }}>{n.label}</span>
          ))}
        </nav>
      </div>
      <span style={{
        padding: "9px 20px",
        background: theme.primaryColor, color: "#fff",
        borderRadius: theme.radius,
        fontSize: 13, fontWeight: 700,
      }}>{header.ctaText || "צור קשר"}</span>
    </header>
  );
}

function FooterBar({ lp, theme, logoUrl }: any) {
  return (
    <footer style={{
      padding: "32px 32px 24px",
      background: theme.sectionBgColor,
      color: "#fff",
    }}>
      <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 28, marginBottom: 24 }}>
        <div>
          {logoUrl ? (
            <img src={logoUrl} alt="" style={{ height: 32, width: "auto", maxWidth: 100, objectFit: "contain", borderRadius: 4, marginBottom: 8, display: "block" }} />
          ) : (
            <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginBottom: 8 }}>{lp.header?.logoText || "BRAND"}</div>
          )}
          <p style={{ fontSize: 13, opacity: 0.65, lineHeight: 1.6 }}>{lp.footer.tagline}</p>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.6, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>צור קשר</div>
          {lp.footer.contactPhone && <div dir="ltr" style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{lp.footer.contactPhone}</div>}
          {lp.footer.contactEmail && <div dir="ltr" style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{lp.footer.contactEmail}</div>}
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, opacity: 0.6, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 10 }}>פרטים</div>
          {lp.footer.address && <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{lp.footer.address}</div>}
          {lp.footer.hours && <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{lp.footer.hours}</div>}
        </div>
      </div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 16, fontSize: 11, opacity: 0.5, textAlign: "center" }}>
        {lp.footer.copyright || `© ${new Date().getFullYear()} כל הזכויות שמורות.`}
      </div>
    </footer>
  );
}

/* ── Hero variants ──────────────────────────────────────────────── */

function HeroSection({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const layout = theme.heroLayout;
  if (layout === "split")   return <HeroSplit   lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
  if (layout === "minimal") return <HeroMinimal lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
  return <HeroCentered lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
}

/* ── A) centered — Editorial magazine: full image + gradient overlays + stats strip ── */
function HeroCentered({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const heroImg = images.find((i: any) => i.section === "hero")?.url;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const secondary = theme.sectionBgColor;

  return (
    <div style={{ position: "relative", overflow: "hidden", minHeight: "85vh", display: "flex", flexDirection: "column", color: "#fff", background: secondary }}>
      {/* Image bg with 1.06 zoom */}
      {heroImg && (
        <img src={heroImg} alt="hero" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", transform: "scale(1.06)" }} />
      )}
      {/* Diagonal theme gradient */}
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, ${primary}2E 0%, ${primary}99 35%, ${primary}E0 75%, ${primary} 100%)`, pointerEvents: "none" }} />
      {/* Bottom blackout */}
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to top, ${secondary} 0%, ${secondary}99 35%, transparent 60%)`, pointerEvents: "none" }} />
      {/* Dot grid */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)", backgroundSize: "32px 32px", pointerEvents: "none" }} />
      {/* Top-right radial glow */}
      <div style={{ position: "absolute", top: 0, right: 0, width: 700, height: 700, background: `radial-gradient(circle at top right, ${primary}33 0%, transparent 60%)`, pointerEvents: "none" }} />
      {/* Bottom-left accent glow */}
      <div style={{ position: "absolute", bottom: 0, left: 0, width: 500, height: 400, background: `radial-gradient(circle at bottom left, ${accent}24 0%, transparent 65%)`, pointerEvents: "none" }} />
      {/* Vertical decorative line (left edge) */}
      <div style={{ position: "absolute", top: 100, bottom: 100, left: 32, width: 1, background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.14) 30%, rgba(255,255,255,0.14) 70%, transparent)", pointerEvents: "none" }} />

      <ImageActions section="hero" hasImage={!!heroImg} regen={regenSec === "hero"} onRegenerate={onRegenerate} onUpload={onUpload} />

      {/* Content pinned to bottom-ish */}
      <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "flex-end", padding: "120px 32px 64px" }}>
        <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            <div style={{ height: 2, width: 40, background: primary }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.20em", textTransform: "uppercase", color: primary }}>{lp.brand_strategy?.tagline ? "Welcome" : "Brand"}</span>
          </div>
          <h1 style={{
            fontSize: `${72 * headingMul}px`, fontWeight: 800, lineHeight: 1.0,
            color: "#fff", letterSpacing: "-0.03em",
            textShadow: "0 4px 40px rgba(0,0,0,0.4)", margin: 0, maxWidth: 1100,
            fontFamily: "var(--lp-font, 'Heebo', sans-serif)",
          }}>{lp.hero?.headline}</h1>
          <p style={{ fontSize: 20, color: "rgba(255,255,255,0.65)", lineHeight: 1.55, marginTop: 28, maxWidth: 720 }}>{lp.hero?.subheadline}</p>
          <div style={{ display: "flex", gap: 16, marginTop: 36, flexWrap: "wrap" }}>
            <a href="#contact" style={{
              padding: "16px 40px", borderRadius: theme.radius, background: primary, color: "#fff",
              fontWeight: 700, fontSize: 16, textDecoration: "none",
              boxShadow: `0 12px 40px ${primary}80`, transition: "all 200ms",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = `0 20px 60px ${primary}99`; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = `0 12px 40px ${primary}80`; }}>
              {lp.hero?.ctaText} <span>→</span>
            </a>
            <a href="#about" style={{
              padding: "16px 40px", borderRadius: theme.radius,
              border: "1.5px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)",
              color: "#fff", fontWeight: 600, fontSize: 16, textDecoration: "none",
              backdropFilter: "blur(8px)", transition: "all 200ms",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.12)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.40)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)"; }}>
              למד עוד
            </a>
          </div>
        </div>
      </div>

      {/* Stats strip at footer */}
      <div style={{
        position: "relative", borderTop: "1px solid rgba(255,255,255,0.10)",
        background: `${secondary}D9`, backdropFilter: "blur(20px)",
        padding: "20px 32px",
      }}>
        <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto", display: "flex", gap: 0 }}>
          {[
            { v: "10+", l: "שנות ניסיון" },
            { v: "500+", l: "לקוחות מרוצים" },
            { v: "98%", l: "שביעות רצון" },
            { v: "24/7", l: "תמיכה" },
          ].map((s, i, arr) => (
            <div key={i} style={{ flex: 1, textAlign: "center", borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.10)" : "none", padding: "0 16px" }}>
              <div style={{ color: "#fff", fontWeight: 900, fontSize: 24, fontFamily: "var(--sans)", letterSpacing: "-0.01em" }}>{s.v}</div>
              <div style={{ color: "rgba(255,255,255,0.40)", fontSize: 11, marginTop: 4 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── B) split — Bold agency: left image + right dark panel with ghost "01" ── */
function HeroSplit({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const heroImg = images.find((i: any) => i.section === "hero")?.url;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const secondary = theme.sectionBgColor;

  return (
    <div style={{ position: "relative", minHeight: "85vh", color: "#fff", overflow: "hidden", background: secondary }}>
      {/* Top gradient bar */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(to left, ${primary}, ${accent})`, zIndex: 5 }} />

      {/* Left image panel */}
      {heroImg && (
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "46%", display: "block" }}>
          <img src={heroImg} alt="hero" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to right, transparent 30%, ${secondary} 100%)`, pointerEvents: "none" }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to bottom, ${secondary}66 0%, transparent 25%, transparent 75%, ${secondary}80 100%)`, pointerEvents: "none" }} />
          <ImageActions section="hero" hasImage regen={regenSec === "hero"} onRegenerate={onRegenerate} onUpload={onUpload} />
        </div>
      )}

      {/* Right dark content panel */}
      <div style={{ position: "relative", marginInlineStart: "auto", width: heroImg ? "60%" : "100%", display: "flex", flexDirection: "column", minHeight: "85vh", justifyContent: "center", padding: "96px 64px" }}>
        {/* Dot grid */}
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px)", backgroundSize: "28px 28px", pointerEvents: "none" }} />
        {/* Brand glow top-right */}
        <div style={{ position: "absolute", top: 0, right: 0, width: 600, height: 600, background: `radial-gradient(circle at top right, ${primary}2E 0%, transparent 60%)`, pointerEvents: "none" }} />
        {/* Accent glow bottom-left */}
        <div style={{ position: "absolute", bottom: 0, left: 0, width: 400, height: 300, background: `radial-gradient(circle at bottom left, ${accent}1A 0%, transparent 65%)`, pointerEvents: "none" }} />
        {/* HUGE ghost "01" */}
        <div style={{
          position: "absolute", right: 32, top: "20%",
          fontSize: "clamp(180px, 28vw, 380px)",
          fontWeight: 900, color: "rgba(255,255,255,0.025)",
          letterSpacing: "-0.06em", lineHeight: 0.85,
          fontFamily: "var(--sans)", pointerEvents: "none",
        }}>01</div>

        <div style={{ position: "relative", zIndex: 2, maxWidth: 720 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
            <div style={{ height: 2, width: 32, background: accent }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.20em", textTransform: "uppercase", color: accent }}>Brand</span>
          </div>
          <h1 style={{
            fontSize: `${56 * headingMul}px`, fontWeight: 800, lineHeight: 1.10,
            color: "#fff", letterSpacing: "-0.03em", margin: 0,
          }}>{lp.hero?.headline}</h1>
          <p style={{ fontSize: 18, color: "rgba(255,255,255,0.55)", lineHeight: 1.55, marginTop: 24, maxWidth: 520 }}>{lp.hero?.subheadline}</p>
          <div style={{ display: "flex", gap: 16, marginTop: 32, flexWrap: "wrap" }}>
            <a href="#contact" style={{
              padding: "16px 36px", borderRadius: theme.radius,
              background: `linear-gradient(135deg, ${primary}, ${accent})`,
              color: "#fff", fontWeight: 700, fontSize: 16, textDecoration: "none",
              boxShadow: `0 10px 35px ${primary}73`, transition: "all 200ms",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.boxShadow = `0 18px 55px ${primary}8C`; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = `0 10px 35px ${primary}73`; }}>
              {lp.hero?.ctaText}
            </a>
            <a href="#about" style={{
              padding: "16px 36px", borderRadius: theme.radius,
              border: "1.5px solid rgba(255,255,255,0.20)", background: "rgba(255,255,255,0.04)",
              color: "#fff", fontWeight: 600, fontSize: 16, textDecoration: "none",
              backdropFilter: "blur(8px)",
            }}>
              למד עוד
            </a>
          </div>
        </div>

        {/* Stats row at bottom of right panel */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          padding: "24px 64px", display: "flex",
        }}>
          {[
            { v: "10+", l: "שנים" },
            { v: "500+", l: "לקוחות" },
            { v: "98%", l: "שביעות רצון" },
          ].map((s, i, arr) => (
            <div key={i} style={{ flex: 1, textAlign: "center", borderRight: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none" }}>
              <div style={{ color: "#fff", fontWeight: 900, fontSize: 22, fontFamily: "var(--sans)" }}>{s.v}</div>
              <div style={{ color: "rgba(255,255,255,0.40)", fontSize: 11, marginTop: 2 }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── C) minimal — Clean architecture: white bg, concentric circles, offset image card ── */
function HeroMinimal({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const heroImg = images.find((i: any) => i.section === "hero")?.url;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;

  return (
    <div style={{ position: "relative", background: "#fff", overflow: "hidden", minHeight: "80vh" }}>
      {/* Top gradient line */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(to left, ${primary}, ${accent})` }} />

      {/* CSS grid lines bg */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `
          linear-gradient(${primary}0A 1px, transparent 1px),
          linear-gradient(90deg, ${primary}0A 1px, transparent 1px)`,
        backgroundSize: "64px 64px", pointerEvents: "none",
      }} />

      {/* Concentric circles top-right (4 rings) */}
      <div style={{ position: "absolute", top: -100, right: -100, width: 640, height: 640, pointerEvents: "none" }}>
        {[180, 300, 420, 560].map((d, i) => (
          <div key={i} style={{
            position: "absolute", top: "50%", left: "50%",
            width: d, height: d, borderRadius: "50%",
            border: `1px solid ${primary}${(0x14 - i * 4).toString(16).padStart(2, "0")}`,
            transform: "translate(-50%, -50%)",
          }} />
        ))}
        <div style={{ position: "absolute", top: "50%", left: "50%", width: 48, height: 48, borderRadius: "50%", background: `${primary}26`, transform: "translate(-50%, -50%)" }} />
      </div>

      {/* Bottom-left accent glow */}
      <div style={{ position: "absolute", bottom: 0, left: 0, width: 480, height: 380, background: `radial-gradient(circle at bottom left, ${accent}12 0%, transparent 70%)`, pointerEvents: "none" }} />

      <div style={{ position: "relative", padding: "96px 32px", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "center" }}>
          {/* Text column */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
              <div style={{ width: 4, height: 32, background: `linear-gradient(to bottom, ${primary}, ${accent})`, borderRadius: 2 }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.20em", textTransform: "uppercase", color: primary }}>Brand</span>
            </div>
            <h1 style={{
              fontSize: `${64 * headingMul}px`, fontWeight: 800, lineHeight: 1.05,
              color: theme.headingColor, letterSpacing: "-0.03em", margin: 0,
            }}>{lp.hero?.headline}</h1>
            <div style={{ height: 3, width: 64, borderRadius: 999, background: `linear-gradient(to right, ${primary}, ${accent})`, marginTop: 24, marginBottom: 24 }} />
            <p style={{ fontSize: 18, color: "#6b7280", lineHeight: 1.55, maxWidth: 520 }}>{lp.hero?.subheadline}</p>
            {/* Trust chips */}
            <div style={{ display: "flex", gap: 8, marginTop: 24, flexWrap: "wrap" }}>
              {["מקצועי", "אמין", "מהיר", "אישי"].map((c, i) => (
                <span key={i} style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "6px 12px", fontSize: 12, fontWeight: 600,
                  background: `${primary}0F`, border: `1px solid ${primary}24`,
                  color: primary, borderRadius: 6,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: primary }} />
                  {c}
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 32 }}>
              <a href="#contact" style={{
                padding: "14px 32px", borderRadius: theme.radius, background: primary, color: "#fff",
                fontWeight: 700, fontSize: 15, textDecoration: "none",
                boxShadow: `0 10px 30px ${primary}59`,
              }}>{lp.hero?.ctaText}</a>
            </div>
          </div>

          {/* Image column with offset bg + floating stat */}
          <div style={{ position: "relative" }}>
            {/* Offset bg rectangle */}
            <div style={{ position: "absolute", inset: 0, background: `${primary}0D`, borderRadius: 20, transform: "translate(14px, 14px)", zIndex: 0 }} />
            {/* Main image card */}
            <div style={{
              position: "relative", aspectRatio: "4/3", maxWidth: 560,
              borderRadius: 16, overflow: "hidden", zIndex: 1,
              boxShadow: "0 32px 80px rgba(0,0,0,0.16)",
              background: `linear-gradient(135deg, ${primary}24, ${accent}14)`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {heroImg ? (
                <>
                  <img src={heroImg} alt="hero" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  <ImageActions section="hero" hasImage regen={regenSec === "hero"} onRegenerate={onRegenerate} onUpload={onUpload} />
                </>
              ) : (
                <IcoSparkle size={96} />
              )}
              {/* Bottom accent bar */}
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 4, background: `linear-gradient(to right, ${primary}, ${accent})` }} />
              {/* Floating stat (bottom-right) */}
              <div style={{
                position: "absolute", right: -18, bottom: -16,
                background: theme.sectionBgColor, color: "#fff",
                padding: "12px 20px", borderRadius: 12,
                boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
                minWidth: 120,
              }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.50)", fontWeight: 600, letterSpacing: "0.04em" }}>שביעות רצון</div>
                <div style={{ fontSize: 26, fontWeight: 900, fontFamily: "var(--sans)", marginTop: 2, lineHeight: 1 }}>98%</div>
                <div style={{ height: 3, marginTop: 8, background: `linear-gradient(to right, ${primary}, ${accent})`, borderRadius: 2 }} />
              </div>
              {/* Corner accent dots */}
              <div style={{ position: "absolute", top: -14, left: -14, width: 36, height: 36, borderRadius: "50%", background: accent, boxShadow: `0 0 0 5px ${accent}30`, zIndex: 2 }} />
              <div style={{ position: "absolute", top: 20, left: 20, width: 16, height: 16, borderRadius: "50%", background: `${primary}59`, zIndex: 2 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── About variants ─────────────────────────────────────────────── */

function AboutSection({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  if (!lp.about) return null;
  const layout = theme.aboutLayout;
  if (layout === "full-width")  return <AboutFullWidth  lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
  if (layout === "image-right") return <AboutImageRight lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
  return <AboutImageLeft lp={lp} theme={theme} headingMul={headingMul} images={images} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} />;
}

/* Reusable about text column */
function AboutText({ lp, theme, headingMul, centered }: any) {
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28, justifyContent: centered ? "center" : "flex-start" }}>
        {centered && <div style={{ height: 2, width: 40, background: primary }} />}
        <div style={{ height: 2, width: 40, background: primary }} />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.15em", textTransform: "uppercase", color: primary }}>אודותינו</span>
        {centered && <div style={{ height: 2, width: 40, background: primary }} />}
      </div>
      <h2 style={{
        fontSize: `${44 * headingMul}px`, fontWeight: 800, lineHeight: 1.15,
        color: theme.headingColor, letterSpacing: "-0.03em",
        margin: 0, marginBottom: 32,
        textAlign: centered ? "center" : "right",
      }}>{lp.about.heading}</h2>
      <div style={{ height: 4, width: 56, borderRadius: 999, background: `linear-gradient(to right, ${primary}, ${accent})`, marginBottom: 32, marginInline: centered ? "auto" : 0 }} />
      <p style={{
        fontSize: 16, lineHeight: 1.75, color: theme.bodyColor,
        whiteSpace: "pre-line", textAlign: centered ? "center" : "right",
        maxWidth: centered ? 680 : 640, marginInline: centered ? "auto" : 0,
      }}>{lp.about.body}</p>
    </div>
  );
}

/* Image card with offset bg + 2 floating stat panels */
function AboutImageCard({ aboutImg, theme, regenSec, onRegenerate, onUpload, offsetSide, accentBar }: any) {
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const offsetBg = offsetSide === "right" ? `${accent}14` : `${primary}12`;
  const offsetTransform = offsetSide === "right" ? "translate(20px, -20px)" : "translate(-20px, 20px)";
  const offsetPos = offsetSide === "right"
    ? { top: 0, right: 0 }
    : { bottom: 0, left: 0 };
  const isRegen = regenSec === "about";

  return (
    <div style={{ position: "relative" }}>
      {/* Offset bg rectangle */}
      <div style={{ position: "absolute", width: "75%", height: "75%", background: offsetBg, borderRadius: 16, transform: offsetTransform, zIndex: 0, ...offsetPos }} />

      {/* Main image card */}
      <div style={{
        position: "relative", aspectRatio: "3/4", maxWidth: 480,
        borderRadius: 16, overflow: "hidden", zIndex: 1,
        boxShadow: "0 40px 100px rgba(0,0,0,0.20)",
        background: `linear-gradient(135deg, ${primary}24, ${accent}14)`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {aboutImg ? (
          <img src={aboutImg} alt="about" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 96, opacity: 0.4 }}>✦</span>
        )}
        <ImageActions section="about" hasImage={!!aboutImg} regen={isRegen} onRegenerate={onRegenerate} onUpload={onUpload} />
        {/* Bottom darken */}
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to top, ${theme.sectionBgColor}BF 0%, transparent 45%)`, pointerEvents: "none" }} />

        {/* Floating stat panels — 2 cards side-by-side at bottom */}
        <div style={{ position: "absolute", bottom: 20, left: 20, right: 20, display: "flex", gap: 12 }}>
          {/* Glassmorphic */}
          <div style={{
            flex: 1, padding: "12px 16px", borderRadius: 12,
            background: "rgba(255,255,255,0.12)", backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.20)",
          }}>
            <div style={{ color: "rgba(255,255,255,0.60)", fontSize: 10, fontWeight: 600, marginBottom: 4 }}>שנים בענף</div>
            <div style={{ color: "#fff", fontSize: 22, fontWeight: 900, fontFamily: "var(--sans)", lineHeight: 1 }}>10+</div>
          </div>
          {/* Brand-colored */}
          <div style={{
            flex: 1, padding: "12px 16px", borderRadius: 12,
            background: `${primary}D9`, backdropFilter: "blur(12px)",
          }}>
            <div style={{ color: "rgba(255,255,255,0.70)", fontSize: 10, fontWeight: 600, marginBottom: 4 }}>לקוחות</div>
            <div style={{ color: "#fff", fontSize: 22, fontWeight: 900, fontFamily: "var(--sans)", lineHeight: 1 }}>500+</div>
          </div>
        </div>
      </div>

      {/* Vertical accent bar (only for image-left) */}
      {accentBar && (
        <div style={{ position: "absolute", top: 48, right: 0, width: 4, height: 96, borderRadius: 999, background: `linear-gradient(to bottom, ${accent}, transparent)` }} />
      )}
    </div>
  );
}

/* ── A) image-left ─────────────────────────────────────────────── */
function AboutImageLeft({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const aboutImg = images.find((i: any) => i.section === "about")?.url;
  return (
    <div style={{ position: "relative", padding: "var(--lp-pad-y) 32px", background: "#fff", borderTop: `1px solid ${theme.bodyColor}08` }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(circle, ${theme.primaryColor}12 1px, transparent 1px)`, backgroundSize: "28px 28px", pointerEvents: "none" }} />
      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 96, alignItems: "center" }}>
        <AboutImageCard aboutImg={aboutImg} theme={theme} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} offsetSide="left" accentBar />
        <AboutText lp={lp} theme={theme} headingMul={headingMul} />
      </div>
    </div>
  );
}

/* ── B) image-right (mirror) ───────────────────────────────────── */
function AboutImageRight({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const aboutImg = images.find((i: any) => i.section === "about")?.url;
  return (
    <div style={{ position: "relative", padding: "var(--lp-pad-y) 32px", background: "#fff", borderTop: `1px solid ${theme.bodyColor}08` }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(circle, ${theme.primaryColor}12 1px, transparent 1px)`, backgroundSize: "28px 28px", pointerEvents: "none" }} />
      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 96, alignItems: "center" }}>
        <AboutText lp={lp} theme={theme} headingMul={headingMul} />
        <AboutImageCard aboutImg={aboutImg} theme={theme} regenSec={regenSec} onRegenerate={onRegenerate} onUpload={onUpload} offsetSide="right" />
      </div>
    </div>
  );
}

/* ── C) full-width — Image bleeds 21/9, centered text below ────── */
function AboutFullWidth({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  const aboutImg = images.find((i: any) => i.section === "about")?.url;
  return (
    <div style={{ position: "relative", padding: "var(--lp-pad-y) 32px", background: "#fff", borderTop: `1px solid ${theme.bodyColor}08` }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: `radial-gradient(circle, ${theme.primaryColor}12 1px, transparent 1px)`, backgroundSize: "28px 28px", pointerEvents: "none" }} />
      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        {aboutImg && (
          <div style={{ position: "relative", aspectRatio: "21/9", borderRadius: 16, overflow: "hidden", marginBottom: 64, boxShadow: "0 30px 80px rgba(0,0,0,0.15)" }}>
            <img src={aboutImg} alt="about" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to top, ${theme.sectionBgColor}80 0%, transparent 60%)`, pointerEvents: "none" }} />
            <ImageActions section="about" hasImage regen={regenSec === "about"} onRegenerate={onRegenerate} onUpload={onUpload} />
          </div>
        )}
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          <AboutText lp={lp} theme={theme} headingMul={headingMul} centered />
        </div>
      </div>
    </div>
  );
}

/* ── Services variants ──────────────────────────────────────────── */

function ServicesSection({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  if (!lp.services?.items?.length) return null;
  const layout = theme.servicesLayout;
  const props = { lp, theme, headingMul, images: images ?? [], regenSec, onRegenerate, onUpload };
  if (layout === "alternating") return <ServicesAlternating {...props} />;
  if (layout === "icon-list")   return <ServicesIconList   {...props} />;
  return <ServicesCards {...props} />;
}

/* ── A) cards — Bento grid with featured first card ─────────────── */
function ServicesCards({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload: _u }: any) {
  const items = lp.services.items;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const secondary = theme.secondaryColor;

  return (
    <div style={{
      padding: "var(--lp-pad-y) 32px",
      background: "#f7f8fa",
      backgroundImage: `radial-gradient(circle, ${primary}14 1px, transparent 1px)`,
      backgroundSize: "32px 32px",
      borderTop: `1px solid ${theme.bodyColor}08`,
    }}>
      <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <SectionLabel label="שירותים" theme={theme} />
        <h2 style={{
          fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center",
          color: theme.headingColor, letterSpacing: "-0.02em", marginTop: 16, marginBottom: 48,
        }}>{lp.services.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
          {items.map((it: any, i: number) => {
            const featured = i === 0;
            const slot = `services_${i + 1}`;
            const img  = images.find((x: any) => x.section === slot)?.url;
            const isRegen = regenSec === slot;
            return (
              <div key={i} style={{
                background: "#fff",
                borderRadius: theme.radius * 1.2,
                overflow: "hidden",
                boxShadow: "0 4px 24px rgba(0,0,0,0.07)",
                gridColumn: featured ? "1 / -1" : undefined,
                display: "flex",
                flexDirection: "column",
                position: "relative",
                transition: "all 400ms cubic-bezier(0.22,1,0.36,1)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-6px)";
                e.currentTarget.style.boxShadow = "0 24px 72px rgba(0,0,0,0.15)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "0 4px 24px rgba(0,0,0,0.07)";
              }}>
                {/* Image area */}
                <div style={{
                  position: "relative",
                  aspectRatio: featured ? "21/9" : "4/3",
                  background: `linear-gradient(135deg, ${primary}25, ${accent}15)`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: featured ? 64 : 40,
                  overflow: "hidden",
                }}>
                  {img ? (
                    <img src={img} alt={it.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.20))" }}>{it.icon}</span>
                  )}
                  {/* Numbered badge top-right */}
                  <div style={{
                    position: "absolute", top: 12, right: 12,
                    width: 36, height: 36, borderRadius: "50%",
                    background: primary, color: "#fff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 900, letterSpacing: 0,
                    zIndex: 2,
                  }}>{String(i + 1).padStart(2, "0")}</div>

                  {/* Generate/Regenerate image button — top-left */}
                  {onRegenerate && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRegenerate(slot); }}
                      disabled={isRegen}
                      style={{
                        position: "absolute", top: 12, left: 12,
                        padding: "6px 12px", borderRadius: 999,
                        background: "rgba(0,0,0,0.55)", color: "#fff",
                        border: "1px solid rgba(255,255,255,0.30)",
                        fontSize: 11, fontWeight: 700,
                        cursor: isRegen ? "wait" : "pointer", opacity: isRegen ? 0.7 : 1,
                        display: "flex", alignItems: "center", gap: 4,
                        backdropFilter: "blur(6px)", zIndex: 3,
                      }}>
                      <IcoRefresh size={11} />
                      {isRegen ? "מייצר..." : img ? "החלף" : "צור תמונה"}
                    </button>
                  )}

                  {/* Bottom fade */}
                  <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.18) 0%, transparent 45%)", pointerEvents: "none" }} />
                  {/* Top accent bar */}
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(to right, ${primary}, ${accent})`, zIndex: 1 }} />
                  {/* Featured headline overlay */}
                  {featured && (
                    <div style={{
                      position: "absolute", left: 24, right: 24, bottom: 20, zIndex: 2,
                      background: `linear-gradient(to top, ${secondary}E8 0%, transparent 100%)`,
                      padding: "20px 4px 4px",
                    }}>
                      <p style={{ fontSize: 11, fontWeight: 800, color: accent, letterSpacing: "0.18em", textTransform: "uppercase", margin: 0 }}>שירות מוביל</p>
                      <h3 style={{ fontSize: `${28 * headingMul}px`, fontWeight: 800, color: "#fff", margin: "6px 0 0", letterSpacing: "-0.02em" }}>{it.title}</h3>
                      <p style={{ fontSize: 14, color: "rgba(255,255,255,0.65)", marginTop: 8, lineHeight: 1.6, maxWidth: 580 }}>{it.description}</p>
                    </div>
                  )}
                </div>
                {/* Content (only for non-featured) */}
                {!featured && (
                  <div style={{ padding: 20, flex: 1 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 8, lineHeight: 1.3, color: theme.headingColor }}>{it.title}</h3>
                    <p style={{ fontSize: 13, color: theme.bodyColor, lineHeight: 1.6, opacity: 0.8 }}>{it.description}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── B) alternating — Editorial rows with offset background + ghost numbers ── */
function ServicesAlternating({ lp, theme, headingMul, images: _i, regenSec: _r, onRegenerate: _o }: any) {
  const items = lp.services.items;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;

  return (
    <div style={{ padding: "var(--lp-pad-y) 32px", background: "#fff", borderTop: `1px solid ${theme.bodyColor}08` }}>
      <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <SectionLabel label="שירותים" theme={theme} />
        <h2 style={{
          fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center",
          color: theme.headingColor, letterSpacing: "-0.02em", marginTop: 16, marginBottom: 80,
        }}>{lp.services.heading}</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 96 }}>
          {items.map((it: any, i: number) => {
            const reverse = i % 2 === 1;
            return (
              <div key={i} style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "center",
              }}>
                {/* Image / icon panel — order swaps based on row */}
                <div style={{ position: "relative", order: reverse ? 2 : 1 }}>
                  {/* Offset background rectangle */}
                  <div style={{
                    position: "absolute",
                    width: "75%", height: "75%",
                    background: `${primary}10`,
                    borderRadius: 16,
                    transform: reverse ? "translate(12px, 12px)" : "translate(-12px, 12px)",
                    bottom: 0, left: reverse ? "auto" : 0, right: reverse ? 0 : "auto",
                    zIndex: 0,
                  }} />
                  {/* Main image card */}
                  <div style={{
                    position: "relative",
                    aspectRatio: "4/3",
                    borderRadius: 16,
                    background: `linear-gradient(135deg, ${primary}25, ${accent}15)`,
                    boxShadow: "0 32px 80px rgba(0,0,0,0.15)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 80, zIndex: 1,
                    overflow: "hidden",
                  }}>
                    <span style={{ filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.25))" }}>{it.icon}</span>
                    {/* Ghost number overlay */}
                    <div style={{
                      position: "absolute",
                      [reverse ? "left" : "right"]: 20,
                      top: 12,
                      fontSize: 80, fontWeight: 900,
                      color: "rgba(255,255,255,0.18)",
                      letterSpacing: "-0.04em", lineHeight: 1,
                      fontFamily: "var(--sans)",
                    }}>{String(i + 1).padStart(2, "0")}</div>
                  </div>
                </div>
                {/* Text */}
                <div style={{ order: reverse ? 1 : 2 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                    {/* Numbered badge */}
                    <div style={{
                      width: 36, height: 36, borderRadius: "50%",
                      background: `linear-gradient(135deg, ${primary}, ${accent})`,
                      color: "#fff", fontSize: 14, fontWeight: 900,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, height: 1, background: `${primary}33` }} />
                  </div>
                  <h3 style={{
                    fontSize: `${30 * headingMul}px`, fontWeight: 800, lineHeight: 1.15,
                    color: theme.headingColor, letterSpacing: "-0.02em", marginBottom: 20,
                  }}>{it.title}</h3>
                  <p style={{ fontSize: 16, color: theme.bodyColor, lineHeight: 1.7, marginBottom: 28, opacity: 0.9 }}>{it.description}</p>
                  <div style={{ height: 2, width: 56, borderRadius: 999, background: `linear-gradient(to right, ${primary}, ${accent})` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── C) icon-list — Dark premium 2-col list with glows ─────────── */
function ServicesIconList({ lp, theme, headingMul }: any) {
  const items = lp.services.items;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;

  return (
    <div style={{
      position: "relative", overflow: "hidden",
      padding: "var(--lp-pad-y) 32px",
      background: theme.sectionBgColor,
      color: "#fff",
    }}>
      {/* Glow top-right */}
      <div style={{
        position: "absolute", top: 0, right: 0, width: 500, height: 500,
        background: primary, filter: "blur(100px)", opacity: 0.10,
        transform: "translate(30%, -40%)", borderRadius: "50%", pointerEvents: "none",
      }} />
      {/* Glow bottom-left */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, width: 400, height: 400,
        background: accent, filter: "blur(100px)", opacity: 0.08,
        transform: "translate(-30%, 40%)", borderRadius: "50%", pointerEvents: "none",
      }} />
      {/* Dot grid */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "28px 28px", pointerEvents: "none",
      }} />

      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <SectionLabel label="שירותים" theme={theme} dark />
        <h2 style={{
          fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center",
          color: "#fff", letterSpacing: "-0.02em", marginTop: 16, marginBottom: 48,
        }}>{lp.services.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {items.map((it: any, i: number) => (
            <div key={i} style={{
              display: "flex", gap: 20, padding: 24,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: theme.radius,
              transition: "all 300ms cubic-bezier(0.22,1,0.36,1)",
              cursor: "default",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${primary}14`;
              e.currentTarget.style.borderColor = `${primary}48`;
              e.currentTarget.style.transform = "translateY(-3px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.03)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)";
              e.currentTarget.style.transform = "translateY(0)";
            }}>
              {/* Numbered icon tile */}
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                background: `linear-gradient(135deg, ${primary}40, ${accent}25)`,
                border: `1px solid ${primary}50`,
                color: "#fff", fontSize: 14, fontWeight: 800,
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>{String(i + 1).padStart(2, "0")}</div>
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 6, lineHeight: 1.3 }}>{it.title}</h3>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>{it.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Reusable section label — eyebrow with bars on both sides */
function SectionLabel({ label, theme, dark }: { label: string; theme: any; dark?: boolean }) {
  const color = theme.primaryColor;
  const barColor = dark ? "rgba(255,255,255,0.20)" : `${color}44`;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
      <div style={{ height: 1, width: 32, background: barColor }} />
      <span style={{
        fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase",
        color: color, padding: "4px 12px",
        border: `1px solid ${color}44`,
        background: `${color}14`,
        borderRadius: 6,
      }}>{label}</span>
      <div style={{ height: 1, width: 32, background: barColor }} />
    </div>
  );
}

/* ── Why Us / Process / FAQ / Testimonials / Final CTA ─────────── */

function WhyUsSection({ lp, theme, headingMul, images, regenSec, onRegenerate }: any) {
  if (!lp.why_us?.points?.length) return null;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const whyImg  = (images || []).find((x: any) => x.section === "why_us")?.url;
  const isRegen = regenSec === "why_us";

  return (
    <div style={{
      position: "relative", overflow: "hidden",
      padding: "var(--lp-pad-y) 32px",
      background: theme.sectionBgColor, color: "#fff",
    }}>
      {/* Glows */}
      <div style={{ position: "absolute", top: 0, right: 0, width: 700, height: 700, background: `radial-gradient(circle at top right, ${primary}24 0%, transparent 60%)`, pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, width: 500, height: 400, background: `radial-gradient(circle at bottom left, ${accent}1A 0%, transparent 65%)`, pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "30px 30px", pointerEvents: "none" }} />

      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "start" }}>
        {/* Image column */}
        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", width: "75%", height: "75%", background: `${primary}1F`, borderRadius: 16, transform: "translate(-16px, 16px)", bottom: 0, left: 0, zIndex: 0 }} />
          <div style={{
            position: "relative", aspectRatio: "3/4", maxWidth: 480,
            background: `linear-gradient(160deg, ${primary}40 0%, ${accent}28 100%)`,
            borderRadius: 16, overflow: "hidden", zIndex: 1,
            boxShadow: `0 40px 100px ${theme.sectionBgColor}80`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {whyImg ? (
              <img src={whyImg} alt="why us" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span style={{ fontSize: 144, fontWeight: 900, color: "rgba(255,255,255,0.10)", fontFamily: "var(--sans)", letterSpacing: "-0.04em" }}>#1</span>
            )}
            {/* Always-visible regen button */}
            {onRegenerate && (
              <button
                onClick={(e) => { e.stopPropagation(); onRegenerate("why_us"); }}
                disabled={isRegen}
                style={{
                  position: "absolute", top: 12, left: 12, zIndex: 5,
                  padding: "7px 12px", borderRadius: 999,
                  background: "rgba(0,0,0,0.55)", color: "#fff",
                  border: "1px solid rgba(255,255,255,0.30)",
                  fontSize: 12, fontWeight: 700,
                  cursor: isRegen ? "wait" : "pointer", opacity: isRegen ? 0.7 : 1,
                  display: "flex", alignItems: "center", gap: 5,
                  backdropFilter: "blur(6px)",
                }}>
                <IcoRefresh size={12} />
                {isRegen ? "מייצר..." : whyImg ? "החלף" : "צור תמונה"}
              </button>
            )}
            {/* Floating stats */}
            <div style={{
              position: "absolute", top: 24, right: 24,
              padding: "12px 16px", borderRadius: 8, background: primary,
              boxShadow: `0 8px 30px ${primary}66`, color: "#fff",
            }}>
              <div style={{ fontSize: 10, opacity: 0.7, fontWeight: 600, marginBottom: 4 }}>שביעות רצון</div>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: "var(--sans)", lineHeight: 1 }}>98%</div>
            </div>
            <div style={{
              position: "absolute", bottom: 24, left: 24,
              padding: "12px 16px", borderRadius: 8, background: "#fff",
              boxShadow: "0 8px 30px rgba(0,0,0,0.20)",
            }}>
              <div style={{ fontSize: 10, color: theme.bodyColor, fontWeight: 600, marginBottom: 4 }}>שנות ניסיון</div>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: "var(--sans)", lineHeight: 1, color: theme.headingColor }}>10+</div>
            </div>
          </div>
        </div>

        {/* Text column */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{ height: 2, width: 40, background: primary }} />
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: primary }}>למה אנחנו</span>
          </div>
          <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, color: "#fff", letterSpacing: "-0.02em", marginBottom: 32 }}>{lp.why_us.heading}</h2>

          {/* Points list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {lp.why_us.points.map((p: any, i: number) => (
              <div key={i} style={{
                display: "flex", gap: 16, padding: 16,
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: 8,
                transition: "all 250ms cubic-bezier(0.22,1,0.36,1)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${primary}14`;
                e.currentTarget.style.borderColor = `${primary}40`;
                e.currentTarget.style.transform = "translateY(-2px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)";
                e.currentTarget.style.transform = "translateY(0)";
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                  background: `linear-gradient(135deg, ${primary}4D, ${accent}33)`,
                  border: `1px solid ${primary}59`, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 900,
                }}>{String(i + 1).padStart(2, "0")}</div>
                <div>
                  <h4 style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 4, lineHeight: 1.3 }}>{p.title}</h4>
                  <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>{p.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProcessSection({ lp, theme, headingMul, images, regenSec, onRegenerate }: any) {
  if (!lp.process?.steps?.length) return null;
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  const steps = lp.process.steps;

  return (
    <div style={{
      position: "relative", overflow: "hidden",
      padding: "var(--lp-pad-y) 32px",
      background: theme.sectionBgColor, color: "#fff",
    }}>
      {/* Top-center radial glow */}
      <div style={{
        position: "absolute", top: 0, left: "50%",
        width: 700, height: 400, background: primary, filter: "blur(90px)",
        opacity: 0.10, transform: "translate(-50%, -40%)", borderRadius: "50%", pointerEvents: "none",
      }} />
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.035) 1px, transparent 1px)", backgroundSize: "30px 30px", pointerEvents: "none" }} />

      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <SectionLabel label="תהליך" theme={theme} dark />
        <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center", color: "#fff", letterSpacing: "-0.02em", marginTop: 16, marginBottom: 48 }}>{lp.process.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(steps.length, 4)}, 1fr)`, gap: 20, position: "relative" }}>
          {steps.map((s: any, i: number) => {
            const slot = `process_${i + 1}`;
            const img = (images || []).find((x: any) => x.section === slot)?.url;
            const isRegen = regenSec === slot;
            return (
            <div key={i} style={{
              position: "relative", display: "flex", flexDirection: "column",
              borderRadius: theme.radius, overflow: "hidden",
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              transition: "all 350ms cubic-bezier(0.22,1,0.36,1)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${primary}17`;
              e.currentTarget.style.borderColor = `${primary}59`;
              e.currentTarget.style.transform = "translateY(-6px)";
              e.currentTarget.style.boxShadow = `0 24px 60px ${primary}26`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}>
              {/* Image area */}
              <div style={{
                position: "relative", aspectRatio: "4/3", overflow: "hidden",
                background: `linear-gradient(135deg, ${primary}30, ${accent}1F)`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {img ? (
                  <img src={img} alt={s.title} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.7) saturate(0.85)" }} />
                ) : (
                  <>
                    {/* Big step number */}
                    <span style={{
                      fontSize: 80, fontWeight: 900,
                      color: "rgba(255,255,255,0.18)",
                      fontFamily: "var(--sans)", letterSpacing: "-0.04em", lineHeight: 1,
                    }}>{String(s.step ?? i + 1).padStart(2, "0")}</span>
                    {/* Decorative rings */}
                    <div style={{ position: "absolute", inset: 16, border: "1px solid rgba(255,255,255,0.10)", borderRadius: "50%" }} />
                    <div style={{ position: "absolute", inset: 36, border: "1px solid rgba(255,255,255,0.06)", borderRadius: "50%" }} />
                  </>
                )}
                {/* Always-visible regen button */}
                {onRegenerate && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onRegenerate(slot); }}
                    disabled={isRegen}
                    style={{
                      position: "absolute", top: 10, left: 10, zIndex: 4,
                      padding: "5px 10px", borderRadius: 999,
                      background: "rgba(0,0,0,0.55)", color: "#fff",
                      border: "1px solid rgba(255,255,255,0.30)",
                      fontSize: 10, fontWeight: 700,
                      cursor: isRegen ? "wait" : "pointer", opacity: isRegen ? 0.7 : 1,
                      display: "flex", alignItems: "center", gap: 4,
                      backdropFilter: "blur(6px)",
                    }}>
                    <IcoRefresh size={10} />
                    {isRegen ? "מייצר..." : img ? "החלף" : "צור"}
                  </button>
                )}
                {/* Bottom gradient */}
                <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to top, ${theme.sectionBgColor}BF 0%, transparent 50%)`, pointerEvents: "none" }} />
              </div>

              {/* Content */}
              <div style={{ padding: 20, display: "flex", flexDirection: "column", flex: 1 }}>
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "4px 10px", borderRadius: 999,
                  background: `${primary}2E`, color: primary,
                  border: `1px solid ${primary}4D`,
                  fontSize: 10, fontWeight: 800, marginBottom: 12, alignSelf: "flex-start",
                }}>
                  <span className="pulse-dot" style={{ background: primary, width: 6, height: 6 }} />
                  שלב {s.step ?? i + 1}
                </span>
                <h3 style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 8, lineHeight: 1.3 }}>{s.title}</h3>
                <p style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.6, flex: 1 }}>{s.description}</p>
              </div>

              {/* Connector arrow (between cards, not on last) */}
              {i < steps.length - 1 && (
                <div style={{
                  position: "absolute", left: -14, top: "calc(50% - 14px)",
                  width: 28, height: 28, borderRadius: "50%",
                  background: primary,
                  boxShadow: `0 0 0 3px ${theme.sectionBgColor}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  zIndex: 5,
                }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "#fff" }}>←</span>
                </div>
              )}
            </div>
          );})}
        </div>
      </div>
    </div>
  );
}

function TestimonialsSection({ lp, theme, headingMul }: any) {
  if (!lp.testimonials?.items?.length) return null;
  const style = theme.testimonialsStyle || "dark";
  if (style === "light")   return <TestimonialsLight   lp={lp} theme={theme} headingMul={headingMul} />;
  if (style === "colored") return <TestimonialsColored lp={lp} theme={theme} headingMul={headingMul} />;
  return <TestimonialsDark lp={lp} theme={theme} headingMul={headingMul} />;
}

const AVATAR_COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

/* Star rating row */
function Stars({ color = "#fbbf24", size = 14 }: { color?: string; size?: number }) {
  return (
    <div style={{ display: "flex", gap: 2 }}>
      {[0, 1, 2, 3, 4].map(i => (
        <IcoStar key={i} size={size} color={color} />
      ))}
    </div>
  );
}

/* ── A) dark — Glassmorphism cards with giant quote marks ─────── */
function TestimonialsDark({ lp, theme, headingMul }: any) {
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  return (
    <div style={{ position: "relative", overflow: "hidden", padding: "var(--lp-pad-y) 32px", background: theme.sectionBgColor, color: "#fff" }}>
      <div style={{ position: "absolute", top: 0, right: 0, width: 384, height: 384, background: primary, filter: "blur(80px)", opacity: 0.10, transform: "translate(30%, -30%)", borderRadius: "50%", pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, width: 320, height: 320, background: accent, filter: "blur(80px)", opacity: 0.10, transform: "translate(-30%, 30%)", borderRadius: "50%", pointerEvents: "none" }} />

      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-flex", padding: "6px 16px", fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", borderRadius: 6, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.55)" }}>המלצות</span>
        </div>
        <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center", color: "#fff", letterSpacing: "-0.02em", marginBottom: 48 }}>{lp.testimonials.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {lp.testimonials.items.map((t: any, i: number) => (
            <div key={i} style={{
              position: "relative", overflow: "hidden",
              background: "linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.03) 100%)",
              border: "1px solid rgba(255,255,255,0.10)", borderRadius: theme.radius,
              padding: 28, backdropFilter: "blur(12px)",
              transition: "all 300ms cubic-bezier(0.22,1,0.36,1)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${primary}59`;
              e.currentTarget.style.transform = "translateY(-5px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
              e.currentTarget.style.transform = "translateY(0)";
            }}>
              {/* Giant quote */}
              <span style={{ position: "absolute", top: 12, left: 16, fontSize: 80, color: `${primary}30`, fontFamily: "Georgia, serif", lineHeight: 1, pointerEvents: "none", zIndex: 0 }}>"</span>

              <Stars color={accent} />
              <p style={{ position: "relative", color: "rgba(255,255,255,0.80)", fontSize: 14, lineHeight: 1.6, marginTop: 20, marginBottom: 28, fontStyle: "italic", zIndex: 1 }}>
                {t.quote}
              </p>
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 20, display: "flex", alignItems: "center", gap: 12, position: "relative", zIndex: 1 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
                  background: `linear-gradient(135deg, ${AVATAR_COLORS[i % AVATAR_COLORS.length]}, ${AVATAR_COLORS[i % AVATAR_COLORS.length]}99)`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontWeight: 700, fontSize: 16,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                }}>{(t.name || "?").charAt(0)}</div>
                <div>
                  <div style={{ color: "#fff", fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>{t.name}</div>
                  <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 2 }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── B) light — Clean editorial cards on gray ─────────────────── */
function TestimonialsLight({ lp, theme, headingMul }: any) {
  const primary = theme.primaryColor;
  const accent  = theme.accentColor;
  return (
    <div style={{ padding: "var(--lp-pad-y) 32px", background: "#f8f9fa", borderTop: `1px solid ${theme.bodyColor}08` }}>
      <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-flex", padding: "6px 16px", fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", borderRadius: 6, background: `${primary}12`, border: `1px solid ${primary}2E`, color: primary }}>המלצות</span>
        </div>
        <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center", color: theme.headingColor, letterSpacing: "-0.02em", marginBottom: 48 }}>{lp.testimonials.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
          {lp.testimonials.items.map((t: any, i: number) => (
            <div key={i} style={{
              position: "relative", overflow: "hidden",
              background: "#fff", borderRadius: theme.radius, padding: 32,
              borderLeft: `4px solid ${primary}`,
              boxShadow: "0 2px 16px rgba(0,0,0,0.06)",
              transition: "all 300ms",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 16px 48px rgba(0,0,0,0.14)";
              e.currentTarget.style.transform = "translateY(-4px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 2px 16px rgba(0,0,0,0.06)";
              e.currentTarget.style.transform = "translateY(0)";
            }}>
              {/* Giant quote top-right */}
              <span style={{ position: "absolute", top: 0, right: 16, fontSize: 96, color: `${primary}12`, fontFamily: "Georgia, serif", lineHeight: 1 }}>"</span>

              <Stars color={accent} />
              <p style={{ color: theme.bodyColor, fontSize: 14, lineHeight: 1.6, marginTop: 16, marginBottom: 28, fontStyle: "italic" }}>{t.quote}</p>
              <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: "50%",
                  background: primary, color: "#fff",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 14,
                }}>{(t.name || "?").charAt(0)}</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: theme.headingColor }}>{t.name}</div>
                  <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 2 }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── C) colored — Full brand color background ─────────────────── */
function TestimonialsColored({ lp, theme, headingMul }: any) {
  const primary = theme.primaryColor;
  return (
    <div style={{ position: "relative", overflow: "hidden", padding: "var(--lp-pad-y) 32px", background: primary, color: "#fff" }}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, rgba(0,0,0,0.20) 0%, transparent 60%)", pointerEvents: "none" }} />

      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <span style={{ display: "inline-flex", padding: "6px 16px", fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", borderRadius: 6, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.30)", color: "#fff" }}>המלצות</span>
        </div>
        <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, lineHeight: 1.15, textAlign: "center", color: "#fff", letterSpacing: "-0.02em", marginBottom: 48 }}>{lp.testimonials.heading}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {lp.testimonials.items.map((t: any, i: number) => (
            <div key={i} style={{
              position: "relative",
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.22)",
              borderRadius: theme.radius, padding: 28,
              backdropFilter: "blur(10px)",
              transition: "all 300ms",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.18)";
              e.currentTarget.style.transform = "translateY(-4px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.12)";
              e.currentTarget.style.transform = "translateY(0)";
            }}>
              <span style={{ position: "absolute", top: 12, left: 16, fontSize: 64, color: "rgba(255,255,255,0.20)", fontFamily: "Georgia, serif", lineHeight: 1, pointerEvents: "none" }}>"</span>

              <Stars color="#fde047" />
              <p style={{ position: "relative", color: "rgba(255,255,255,0.90)", fontSize: 14, lineHeight: 1.6, marginTop: 16, marginBottom: 28, fontStyle: "italic", zIndex: 1 }}>{t.quote}</p>
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.20)", paddingTop: 20, display: "flex", alignItems: "center", gap: 12, position: "relative", zIndex: 1 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: "50%",
                  background: "rgba(255,255,255,0.25)",
                  border: "2px solid rgba(255,255,255,0.40)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontWeight: 700, fontSize: 14,
                }}>{(t.name || "?").charAt(0)}</div>
                <div>
                  <div style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>{t.name}</div>
                  <div style={{ color: "rgba(255,255,255,0.60)", fontSize: 12, marginTop: 2 }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FaqSection({ lp, theme, headingMul }: any) {
  if (!lp.faq?.items?.length) return null;
  return (
    <SectionWrap theme={theme}>
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: theme.accentColor, margin: 0 }}>שאלות נפוצות</p>
        <h2 style={{ fontSize: `${32 * headingMul}px`, fontWeight: 800, marginTop: 12, lineHeight: 1.15, color: theme.headingColor, letterSpacing: "var(--lp-tracking)" }}>{lp.faq.heading}</h2>
      </div>
      <div style={{ maxWidth: 800 }}>
        {lp.faq.items.map((q: any, i: number) => (
          <FaqItem key={i} question={q.question} answer={q.answer} primary={theme.primaryColor} ink={theme.bodyColor} />
        ))}
      </div>
    </SectionWrap>
  );
}

function FaqItem({ question, answer, primary, ink }: any) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${ink}15`, padding: "16px 0" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "transparent", border: 0, cursor: "pointer", padding: 0, color: "inherit", textAlign: "right" }}>
        <span style={{ fontSize: "var(--t-base)", fontWeight: 700, color: primary }}>{question}</span>
        <span style={{ transform: open ? "rotate(180deg)" : "rotate(0)", transition: "transform 200ms", color: primary, opacity: 0.6 }}>
          <IcoChevronDown size={18} />
        </span>
      </button>
      {open && <p style={{ fontSize: "var(--t-sm)", marginTop: 10, lineHeight: 1.7, opacity: 0.85 }}>{answer}</p>}
    </div>
  );
}

function FinalCtaSection({ lp, theme, headingMul, images, regenSec, onRegenerate, onUpload }: any) {
  if (!lp.final_cta) return null;
  const ctaImg = images.find((i: any) => i.section === "final_cta")?.url;
  return (
    <div style={{
      padding: "var(--lp-pad-y) 32px",
      textAlign: "center",
      position: "relative",
      background: ctaImg ? `linear-gradient(135deg, ${theme.primaryColor}E0, ${theme.secondaryColor}D0)` : `linear-gradient(135deg, ${theme.primaryColor}, ${theme.secondaryColor})`,
      color: "#fff",
      overflow: "hidden",
    }}>
      {ctaImg && (
        <>
          <img src={ctaImg} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 1 - theme.overlayOpacity, mixBlendMode: "overlay" }} />
          <ImageActions section="final_cta" hasImage regen={regenSec === "final_cta"} onRegenerate={onRegenerate} onUpload={onUpload} small />
        </>
      )}
      <div style={{ position: "relative", maxWidth: "var(--lp-container)", margin: "0 auto" }}>
        <h2 style={{ fontSize: `${36 * headingMul}px`, fontWeight: 800, margin: 0, letterSpacing: "var(--lp-tracking)" }}>{lp.final_cta.heading}</h2>
        <p style={{ fontSize: "var(--t-md)", marginTop: 16, opacity: 0.9, maxWidth: 640, marginInline: "auto" }}>{lp.final_cta.subheading}</p>
        <span style={{
          display: "inline-block", marginTop: 24,
          padding: "14px 32px",
          background: "#fff", color: theme.primaryColor,
          borderRadius: theme.radius,
          fontWeight: 800, fontSize: "var(--t-base)",
        }}>{lp.final_cta.ctaText}</span>
      </div>
    </div>
  );
}

function SectionWrap({ theme, bg, children }: { theme: any; bg?: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: "var(--lp-pad-y) 32px",
      background: bg || "transparent",
      borderTop: bg ? "none" : `1px solid ${theme.bodyColor}08`,
    }}>
      <div style={{ maxWidth: "var(--lp-container)", margin: "0 auto" }}>{children}</div>
    </div>
  );
}

/* Image overlay: AI regenerate + custom upload */
function ImageActions({ section, hasImage, regen, onRegenerate, onUpload, small }: {
  section: string;
  hasImage: boolean;
  regen: boolean;
  onRegenerate: (section: string) => void;
  onUpload?: (section: string, file: File) => void;
  small?: boolean;
}) {
  const pad  = small ? "5px 10px" : "7px 12px";
  const fs   = small ? 10 : 12;
  const ico  = small ? 11 : 12;
  const base: React.CSSProperties = {
    padding: pad, borderRadius: 999,
    background: "rgba(0,0,0,0.58)", color: "#fff",
    border: "1px solid rgba(255,255,255,0.28)",
    fontSize: fs, fontWeight: 700,
    cursor: regen ? "wait" : "pointer",
    opacity: regen ? 0.6 : 1,
    display: "flex", alignItems: "center", gap: 5,
    backdropFilter: "blur(6px)",
    pointerEvents: regen ? "none" : "auto",
  };
  return (
    <div style={{ position: "absolute", top: 10, right: 10, zIndex: 5, display: "flex", gap: 6 }}>
      <button onClick={e => { e.stopPropagation(); onRegenerate(section); }} disabled={regen} style={base}>
        <IcoRefresh size={ico} className={regen ? "spin" : undefined} />
        {regen ? "מייצר..." : hasImage ? "AI החלף" : "AI צור"}
      </button>
      {onUpload && (
        <label style={{ ...base, cursor: "pointer" }}>
          <IcoFile size={ico} />
          העלה תמונה
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) onUpload(section, file);
              e.currentTarget.value = "";
            }}
            style={{ display: "none" }}
          />
        </label>
      )}
    </div>
  );
}


/* ──────────────────────────────────────────────────────────────────────
   LP EDITOR — 6 tabs slide-in side panel
   ────────────────────────────────────────────────────────────────────── */

type EditorTab = "content" | "colors" | "backgrounds" | "layout" | "typography" | "sections";

function LpEditor({ lp, theme, onClose, onPatch }: {
  lp: any;
  theme: ReturnType<typeof themeDefaults>;
  onClose: () => void;
  onPatch: (patches: { path: (string | number)[]; value: unknown }[]) => Promise<void>;
}) {
  const [tab, setTab] = useState<EditorTab>("colors");
  const [pending, setPending] = useState<Record<string, { path: (string | number)[]; value: unknown }>>({});
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  function setField(path: (string | number)[], value: any) {
    setPending(prev => ({ ...prev, [path.join(".")]: { path, value } }));
  }
  function getField(path: (string | number)[], fallback: any): any {
    const k = path.join(".");
    if (k in pending) return pending[k].value;
    let cur: any = path[0] === "design_theme" ? theme : lp;
    for (let i = 1; i < path.length; i++) { cur = cur?.[path[i]]; if (cur == null) break; }
    return cur ?? fallback;
  }

  const t = useCallback((key: string, fallback?: any) => getField(["design_theme", key], fallback), [pending, theme]);
  const setT = useCallback((key: string, value: any) => setField(["design_theme", key], value), []);

  /* AUTO-SAVE — debounced 600ms after last change.
     Keeps the preview live: change dropdown → 0.6s later auto-saves → preview re-renders. */
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    setSaveStatus("saving");
    const id = setTimeout(async () => {
      const patches = Object.values(pending);
      try {
        await onPatch(patches);
        setPending({});
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 1800);
      } catch {
        setSaveStatus("idle");
      }
    }, 600);
    return () => clearTimeout(id);
  }, [pending, onPatch]);

  const dirty = Object.keys(pending).length > 0;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(11,20,48,0.55)", zIndex: 200, backdropFilter: "blur(2px)" }} />
      <div style={{
        position: "fixed", top: 0, bottom: 0, left: 0,
        width: "min(560px, 100vw)",
        background: "var(--bg)",
        zIndex: 201, display: "flex", flexDirection: "column",
        boxShadow: "4px 0 32px rgba(0,0,0,0.18)",
        animation: "slideInLeft 240ms cubic-bezier(0.22,1,0.36,1)",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--rule)", display: "flex", alignItems: "center", gap: 12, flexShrink: 0, background: "var(--paper)" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7C3AED", letterSpacing: "0.14em", textTransform: "uppercase" }}>LP Editor</div>
            <h3 style={{ fontSize: 17, fontWeight: 800, margin: "2px 0 0" }}>עריכת דף נחיתה</h3>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", padding: 8 }}>
            <IcoX size={18} />
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--rule)", flexShrink: 0, background: "var(--paper)", overflowX: "auto" }}>
          {([
            { id: "colors",       label: "צבעים" },
            { id: "backgrounds",  label: "רקעים" },
            { id: "layout",       label: "פריסה" },
            { id: "typography",   label: "טיפוגרפיה" },
            { id: "sections",     label: "סקציות" },
            { id: "content",      label: "תוכן" },
          ] as { id: EditorTab; label: string }[]).map(x => (
            <button key={x.id} onClick={() => setTab(x.id)}
              style={{
                flex: "1 0 auto", padding: "10px 16px",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 700,
                color: tab === x.id ? "#7C3AED" : "var(--ink-3)",
                borderBottom: tab === x.id ? "2px solid #7C3AED" : "2px solid transparent",
                marginBottom: -1, whiteSpace: "nowrap",
              }}>
              {x.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px" }}>
          {tab === "colors"      && <ColorsTab      t={t} setT={setT} />}
          {tab === "backgrounds" && <BackgroundsTab t={t} setT={setT} />}
          {tab === "layout"      && <LayoutTab      t={t} setT={setT} />}
          {tab === "typography"  && <TypographyTab  t={t} setT={setT} />}
          {tab === "sections"    && <SectionsTab    t={t} setT={setT} />}
          {tab === "content"     && <ContentTab     lp={lp} getField={getField} setField={setField} />}
        </div>

        {/* Footer — auto-save status */}
        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--rule)", background: "var(--paper)", display: "flex", gap: 12, flexShrink: 0, alignItems: "center" }}>
          <button onClick={onClose}
            style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            סגור
          </button>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, fontSize: 12, fontWeight: 600 }}>
            {saveStatus === "saving" && (
              <>
                <span className="spin" style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--rule)", borderTopColor: "#7C3AED", display: "inline-block" }} />
                <span style={{ color: "var(--ink-2)" }}>שומר...</span>
              </>
            )}
            {saveStatus === "saved" && (
              <>
                <IcoCheck size={14} color="#10B981" />
                <span style={{ color: "#10B981" }}>נשמר אוטומטית · ה-preview עודכן</span>
              </>
            )}
            {saveStatus === "idle" && !dirty && (
              <span style={{ color: "var(--ink-3)" }}>שינויים נשמרים אוטומטית</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   EDITOR TABS
   ────────────────────────────────────────────────────────────────────── */

function ColorsTab({ t, setT }: { t: (k: string, f?: any) => any; setT: (k: string, v: any) => void }) {
  function applyPreset(p: typeof COLOR_PRESETS[number]) {
    setT("primaryColor", p.primary);
    setT("secondaryColor", p.secondary);
    setT("accentColor", p.accent);
    setT("sectionBgColor", p.secondary);
    setT("headingColor", p.secondary);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ColorRow label="ראשי (Primary)"      value={t("primaryColor")}   onChange={v => setT("primaryColor", v)} />
      <ColorRow label="משני (Secondary)"     value={t("secondaryColor")} onChange={v => setT("secondaryColor", v)} />
      <ColorRow label="הדגשה (Accent)"       value={t("accentColor")}    onChange={v => setT("accentColor", v)} />
      <ColorRow label="צבע כותרות"            value={t("headingColor")}   onChange={v => setT("headingColor", v)} />
      <ColorRow label="צבע גוף טקסט"          value={t("bodyColor")}      onChange={v => setT("bodyColor", v)} />

      <SubLabel>פרסטים מוכנים</SubLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {COLOR_PRESETS.map(p => (
          <button key={p.id} onClick={() => applyPreset(p)}
            style={{ padding: 12, background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: 10, cursor: "pointer", textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "flex", gap: -6, position: "relative", width: 40, height: 24 }}>
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: p.primary,   border: "2px solid #fff", position: "absolute", left: 0,  zIndex: 3 }} />
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: p.secondary, border: "2px solid #fff", position: "absolute", left: 11, zIndex: 2 }} />
              <span style={{ width: 18, height: 18, borderRadius: "50%", background: p.accent,    border: "2px solid #fff", position: "absolute", left: 22, zIndex: 1 }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BackgroundsTab({ t, setT }: { t: (k: string, f?: any) => any; setT: (k: string, v: any) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ColorRow label="רקע דף"        value={t("pageBgColor")}    onChange={v => setT("pageBgColor", v)} />
      <ColorRow label="רקע סקציות כהות" value={t("sectionBgColor")} onChange={v => setT("sectionBgColor", v)} />

      <SubLabel>שקיפות overlay על תמונות</SubLabel>
      <RangeRow value={Number(t("overlayOpacity"))} min={0} max={1} step={0.05}
        format={v => `${Math.round(v * 100)}%`}
        onChange={v => setT("overlayOpacity", v)} />

      <SubLabel>גוונים כהים — לסקציות (Testimonials/Footer)</SubLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {DARK_TONES.map(c => (
          <button key={c.value} onClick={() => setT("sectionBgColor", c.value)}
            title={c.label}
            style={{ padding: 0, height: 36, background: c.value, border: t("sectionBgColor") === c.value ? "2px solid #7C3AED" : "1px solid var(--rule)", borderRadius: 6, cursor: "pointer" }} />
        ))}
      </div>

      <SubLabel>גוונים בהירים — לרקע הדף</SubLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {LIGHT_TONES.map(c => (
          <button key={c.value} onClick={() => setT("pageBgColor", c.value)}
            title={c.label}
            style={{ padding: 0, height: 36, background: c.value, border: t("pageBgColor") === c.value ? "2px solid #7C3AED" : "1px solid var(--rule)", borderRadius: 6, cursor: "pointer" }} />
        ))}
      </div>
    </div>
  );
}

function LayoutTab({ t, setT }: { t: (k: string, f?: any) => any; setT: (k: string, v: any) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SelectRow label="פריסת Hero"            value={t("heroLayout")}        options={HERO_LAYOUTS}        onChange={v => setT("heroLayout", v)} />
      <SelectRow label="פריסת About"           value={t("aboutLayout")}       options={ABOUT_LAYOUTS}       onChange={v => setT("aboutLayout", v)} />
      <SelectRow label="פריסת Services"        value={t("servicesLayout")}    options={SERVICES_LAYOUTS}    onChange={v => setT("servicesLayout", v)} />
      <SelectRow label="סגנון Testimonials"     value={t("testimonialsStyle")} options={TESTIMONIALS_STYLES} onChange={v => setT("testimonialsStyle", v)} />
      <hr style={{ border: 0, borderTop: "1px solid var(--rule)" }} />
      <SelectRow label="ריווח סקציות"           value={t("sectionPadding")}    options={[
        { id: "compact",  label: "צפוף (64–80px)" },
        { id: "normal",   label: "רגיל (112–144px)" },
        { id: "spacious", label: "מרווח (128–176px)" },
      ]} onChange={v => setT("sectionPadding", v)} />
      <SelectRow label="רוחב מקסימלי"           value={t("containerWidth")}    options={[
        { id: "narrow", label: "צר (960px)" },
        { id: "normal", label: "רגיל (1200px)" },
        { id: "wide",   label: "רחב (1440px)" },
      ]} onChange={v => setT("containerWidth", v)} />
    </div>
  );
}

function TypographyTab({ t, setT }: { t: (k: string, f?: any) => any; setT: (k: string, v: any) => void }) {
  /* Auto-load font when changed */
  useEffect(() => {
    const f = t("fontFamily");
    if (f) loadGoogleFont(f);
  }, [t("fontFamily")]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <SelectRow label="גופן" value={t("fontFamily")} options={FONT_FAMILIES.map(f => ({ id: f.id, label: `${f.label} — ${f.desc}` }))}
        onChange={v => setT("fontFamily", v)} />
      <SelectRow label="סגנון גופן (Mood)" value={t("fontStyle")} options={FONT_STYLES} onChange={v => setT("fontStyle", v)} />
      <SelectRow label="גודל כותרות"      value={t("headingScale")} options={HEADING_SCALES.map(s => ({ id: s.id, label: s.label }))} onChange={v => setT("headingScale", v)} />
      <SelectRow label="גודל טקסט גוף"    value={t("bodyScale")}    options={BODY_SCALES.map(s => ({ id: s.id, label: s.label }))}    onChange={v => setT("bodyScale", v)} />
      <SubLabel>Border radius</SubLabel>
      <RangeRow value={Number(t("radius"))} min={0} max={32} step={1} format={v => `${v}px`} onChange={v => setT("radius", v)} />
    </div>
  );
}

function SectionsTab({ t, setT }: { t: (k: string, f?: any) => any; setT: (k: string, v: any) => void }) {
  const order: string[]  = t("sectionOrder")  || ALL_SECTIONS.map(s => s.key);
  const hidden: string[] = t("hiddenSections") || [];

  function toggle(key: string) {
    setT("hiddenSections", hidden.includes(key) ? hidden.filter(k => k !== key) : [...hidden, key]);
  }
  function move(key: string, dir: -1 | 1) {
    const i = order.indexOf(key);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setT("sectionOrder", next);
  }
  function resetOrder() {
    setT("sectionOrder", ALL_SECTIONS.map(s => s.key));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SubLabel>סדר וסקציות נראות</SubLabel>
      {order.map((key, i) => {
        const def = ALL_SECTIONS.find(s => s.key === key);
        if (!def) return null;
        const visible = !hidden.includes(key);
        return (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <button onClick={() => move(key, -1)} disabled={i === 0}
                style={{ width: 24, height: 16, padding: 0, background: "transparent", border: "1px solid var(--rule)", borderRadius: 4, cursor: i === 0 ? "not-allowed" : "pointer", fontSize: 9, opacity: i === 0 ? 0.4 : 1 }}>▲</button>
              <button onClick={() => move(key, 1)} disabled={i === order.length - 1}
                style={{ width: 24, height: 16, padding: 0, background: "transparent", border: "1px solid var(--rule)", borderRadius: 4, cursor: i === order.length - 1 ? "not-allowed" : "pointer", fontSize: 9, opacity: i === order.length - 1 ? 0.4 : 1 }}>▼</button>
            </div>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: visible ? "var(--ink)" : "var(--ink-3)", textDecoration: visible ? "none" : "line-through" }}>{def.label}</span>
            <ToggleSwitch checked={visible} onChange={() => toggle(key)} />
          </div>
        );
      })}
      <button onClick={resetOrder} style={{ marginTop: 12, padding: "8px 12px", background: "transparent", border: "1px solid var(--rule)", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
        אפס סדר ראשוני
      </button>
    </div>
  );
}

function ContentTab({ lp, getField, setField }: any) {
  const [openSection, setOpenSection] = useState<string>("hero");
  const sectionDefs = [
    { key: "header",       label: "Header" },
    { key: "hero",         label: "Hero" },
    { key: "about",        label: "About" },
    { key: "services",     label: "Services" },
    { key: "why_us",       label: "Why us" },
    { key: "process",      label: "Process" },
    { key: "testimonials", label: "Testimonials" },
    { key: "faq",          label: "FAQ" },
    { key: "final_cta",    label: "Final CTA" },
    { key: "footer",       label: "Footer" },
  ];
  return (
    <div>
      {sectionDefs.map(s => (
        <Accordion key={s.key} label={s.label} open={openSection === s.key} onToggle={() => setOpenSection(openSection === s.key ? "" : s.key)}>
          {s.key === "header"       && <HeaderEditor       getField={getField} setField={setField} />}
          {s.key === "hero"         && <HeroEditor         getField={getField} setField={setField} />}
          {s.key === "about"        && <AboutEditor        getField={getField} setField={setField} />}
          {s.key === "services"     && <ServicesEditor     getField={getField} setField={setField} items={lp.services?.items ?? []} />}
          {s.key === "why_us"       && <WhyUsEditor        getField={getField} setField={setField} points={lp.why_us?.points ?? []} />}
          {s.key === "process"      && <ProcessEditor      getField={getField} setField={setField} steps={lp.process?.steps ?? []} />}
          {s.key === "testimonials" && <TestimonialsEditor getField={getField} setField={setField} items={lp.testimonials?.items ?? []} />}
          {s.key === "faq"          && <FaqEditor          getField={getField} setField={setField} items={lp.faq?.items ?? []} />}
          {s.key === "final_cta"    && <FinalCtaEditor     getField={getField} setField={setField} />}
          {s.key === "footer"       && <FooterEditor       getField={getField} setField={setField} />}
        </Accordion>
      ))}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   REUSABLE UI BUILDING BLOCKS
   ────────────────────────────────────────────────────────────────────── */

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-2)", letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 8 }}>{children}</div>;
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ width: 40, height: 40, padding: 0, border: "1px solid var(--rule)", borderRadius: 8, cursor: "pointer", background: "transparent" }} />
        <input type="text" value={value} onChange={e => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && onChange(e.target.value)}
          dir="ltr"
          style={{ flex: 1, padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: 8, fontFamily: "var(--mono)", fontSize: 13 }} />
      </div>
    </div>
  );
}

function RangeRow({ value, min, max, step, format, onChange }: { value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <input type="range" value={value} min={min} max={max} step={step} onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: "#7C3AED" }} />
      <span style={{ minWidth: 50, textAlign: "center", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{format(value)}</span>
    </div>
  );
}

function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: 8, fontSize: 13, background: "var(--paper)" }}>
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)}
      style={{
        width: 38, height: 22, borderRadius: 999,
        background: checked ? "#7C3AED" : "var(--rule-strong)",
        border: "none", cursor: "pointer", position: "relative",
        transition: "background 200ms",
      }}>
      <span style={{
        position: "absolute", top: 2, [checked ? "left" : "right"]: 2,
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        transition: "all 200ms",
      }} />
    </button>
  );
}

function Accordion({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderBottom: "1px solid var(--rule)" }}>
      <button onClick={onToggle}
        style={{
          width: "100%", padding: "14px 0",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "transparent", border: 0, cursor: "pointer",
          fontSize: 13, fontWeight: 700, color: "var(--ink)",
          textAlign: "right",
        }}>
        <span>{label}</span>
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 180ms", color: "var(--ink-3)" }}>
          <IcoChevronRight size={14} />
        </span>
      </button>
      {open && <div style={{ paddingBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>}
    </div>
  );
}

function TextField({ label, value, onChange, multiline, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 4 }}>{label}</span>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows}
          style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontFamily: "inherit", fontSize: 13, lineHeight: 1.5, resize: "vertical" }} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--rule)", borderRadius: "var(--r-2)", fontFamily: "inherit", fontSize: 13 }} />
      )}
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────────
   CONTENT EDITORS — per section
   ────────────────────────────────────────────────────────────────────── */

function HeaderEditor({ getField, setField }: any) {
  const navItems = getField(["landing_page", "header", "navItems"], []) as any[];
  return (
    <>
      <TextField label="טקסט לוגו"  value={getField(["landing_page", "header", "logoText"], "")} onChange={v => setField(["landing_page", "header", "logoText"], v)} />
      <TextField label="כפתור CTA" value={getField(["landing_page", "header", "ctaText"], "")} onChange={v => setField(["landing_page", "header", "ctaText"], v)} />
      <SubLabel>פריטי תפריט</SubLabel>
      {navItems.map((n, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <TextField label={`#${i + 1} טקסט`} value={getField(["landing_page", "header", "navItems", i, "label"], n.label)} onChange={v => setField(["landing_page", "header", "navItems", i, "label"], v)} />
          <TextField label="קישור"            value={getField(["landing_page", "header", "navItems", i, "href"], n.href)}   onChange={v => setField(["landing_page", "header", "navItems", i, "href"], v)} />
        </div>
      ))}
    </>
  );
}

function HeroEditor({ getField, setField }: any) {
  return (
    <>
      <TextField label="כותרת ראשית"           value={getField(["landing_page", "hero", "headline"], "")} onChange={v => setField(["landing_page", "hero", "headline"], v)} />
      <TextField label="תת-כותרת" multiline rows={3} value={getField(["landing_page", "hero", "subheadline"], "")} onChange={v => setField(["landing_page", "hero", "subheadline"], v)} />
      <TextField label="טקסט כפתור"            value={getField(["landing_page", "hero", "ctaText"], "")} onChange={v => setField(["landing_page", "hero", "ctaText"], v)} />
      <TextField label="טקסט מתחת לכפתור"     value={getField(["landing_page", "hero", "ctaSubtext"], "")} onChange={v => setField(["landing_page", "hero", "ctaSubtext"], v)} />
    </>
  );
}

function AboutEditor({ getField, setField }: any) {
  return (
    <>
      <TextField label="כותרת"                 value={getField(["landing_page", "about", "heading"], "")} onChange={v => setField(["landing_page", "about", "heading"], v)} />
      <TextField label="גוף הטקסט" multiline rows={6} value={getField(["landing_page", "about", "body"], "")} onChange={v => setField(["landing_page", "about", "body"], v)} />
    </>
  );
}

function ServicesEditor({ getField, setField, items }: any) {
  return (
    <>
      <TextField label="כותרת סקציה" value={getField(["landing_page", "services", "heading"], "")} onChange={v => setField(["landing_page", "services", "heading"], v)} />
      {items.map((s: any, i: number) => (
        <div key={i} style={{ padding: 12, background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", marginBottom: 6 }}>שירות #{i + 1}</div>
          <TextField label="אמוג'י" value={getField(["landing_page", "services", "items", i, "icon"], s.icon ?? "")} onChange={v => setField(["landing_page", "services", "items", i, "icon"], v)} />
          <TextField label="כותרת"   value={getField(["landing_page", "services", "items", i, "title"], s.title ?? "")} onChange={v => setField(["landing_page", "services", "items", i, "title"], v)} />
          <TextField label="תיאור" multiline rows={2} value={getField(["landing_page", "services", "items", i, "description"], s.description ?? "")} onChange={v => setField(["landing_page", "services", "items", i, "description"], v)} />
        </div>
      ))}
    </>
  );
}

function WhyUsEditor({ getField, setField, points }: any) {
  return (
    <>
      <TextField label="כותרת סקציה" value={getField(["landing_page", "why_us", "heading"], "")} onChange={v => setField(["landing_page", "why_us", "heading"], v)} />
      {points.map((p: any, i: number) => (
        <div key={i} style={{ padding: 12, background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", marginBottom: 6 }}>נקודה #{i + 1}</div>
          <TextField label="כותרת" value={getField(["landing_page", "why_us", "points", i, "title"], p.title ?? "")} onChange={v => setField(["landing_page", "why_us", "points", i, "title"], v)} />
          <TextField label="תיאור" multiline rows={2} value={getField(["landing_page", "why_us", "points", i, "description"], p.description ?? "")} onChange={v => setField(["landing_page", "why_us", "points", i, "description"], v)} />
        </div>
      ))}
    </>
  );
}

function ProcessEditor({ getField, setField, steps }: any) {
  return (
    <>
      <TextField label="כותרת סקציה" value={getField(["landing_page", "process", "heading"], "")} onChange={v => setField(["landing_page", "process", "heading"], v)} />
      {steps.map((s: any, i: number) => (
        <div key={i} style={{ padding: 12, background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", marginBottom: 6 }}>שלב #{i + 1}</div>
          <TextField label="כותרת" value={getField(["landing_page", "process", "steps", i, "title"], s.title ?? "")} onChange={v => setField(["landing_page", "process", "steps", i, "title"], v)} />
          <TextField label="תיאור" multiline rows={2} value={getField(["landing_page", "process", "steps", i, "description"], s.description ?? "")} onChange={v => setField(["landing_page", "process", "steps", i, "description"], v)} />
        </div>
      ))}
    </>
  );
}

function TestimonialsEditor({ getField, setField, items }: any) {
  return (
    <>
      <TextField label="כותרת סקציה" value={getField(["landing_page", "testimonials", "heading"], "")} onChange={v => setField(["landing_page", "testimonials", "heading"], v)} />
      {items.map((t: any, i: number) => (
        <div key={i} style={{ padding: 12, background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", marginBottom: 6 }}>המלצה #{i + 1}</div>
          <TextField label="שם"    value={getField(["landing_page", "testimonials", "items", i, "name"], t.name ?? "")} onChange={v => setField(["landing_page", "testimonials", "items", i, "name"], v)} />
          <TextField label="תפקיד" value={getField(["landing_page", "testimonials", "items", i, "role"], t.role ?? "")} onChange={v => setField(["landing_page", "testimonials", "items", i, "role"], v)} />
          <TextField label="ציטוט" multiline rows={3} value={getField(["landing_page", "testimonials", "items", i, "quote"], t.quote ?? "")} onChange={v => setField(["landing_page", "testimonials", "items", i, "quote"], v)} />
        </div>
      ))}
    </>
  );
}

function FaqEditor({ getField, setField, items }: any) {
  return (
    <>
      <TextField label="כותרת סקציה" value={getField(["landing_page", "faq", "heading"], "")} onChange={v => setField(["landing_page", "faq", "heading"], v)} />
      {items.map((q: any, i: number) => (
        <div key={i} style={{ padding: 12, background: "var(--bg-tint)", borderRadius: "var(--r-2)" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", marginBottom: 6 }}>שאלה #{i + 1}</div>
          <TextField label="שאלה"   value={getField(["landing_page", "faq", "items", i, "question"], q.question ?? "")} onChange={v => setField(["landing_page", "faq", "items", i, "question"], v)} />
          <TextField label="תשובה" multiline rows={3} value={getField(["landing_page", "faq", "items", i, "answer"], q.answer ?? "")} onChange={v => setField(["landing_page", "faq", "items", i, "answer"], v)} />
        </div>
      ))}
    </>
  );
}

function FinalCtaEditor({ getField, setField }: any) {
  return (
    <>
      <TextField label="כותרת"             value={getField(["landing_page", "final_cta", "heading"], "")}    onChange={v => setField(["landing_page", "final_cta", "heading"], v)} />
      <TextField label="תת-כותרת" multiline rows={2} value={getField(["landing_page", "final_cta", "subheading"], "")} onChange={v => setField(["landing_page", "final_cta", "subheading"], v)} />
      <TextField label="טקסט כפתור"        value={getField(["landing_page", "final_cta", "ctaText"], "")}    onChange={v => setField(["landing_page", "final_cta", "ctaText"], v)} />
    </>
  );
}

function FooterEditor({ getField, setField }: any) {
  return (
    <>
      <TextField label="סלוגן"          value={getField(["landing_page", "footer", "tagline"], "")}      onChange={v => setField(["landing_page", "footer", "tagline"], v)} />
      <TextField label="טלפון"          value={getField(["landing_page", "footer", "contactPhone"], "")} onChange={v => setField(["landing_page", "footer", "contactPhone"], v)} />
      <TextField label="אימייל"         value={getField(["landing_page", "footer", "contactEmail"], "")} onChange={v => setField(["landing_page", "footer", "contactEmail"], v)} />
      <TextField label="כתובת"          value={getField(["landing_page", "footer", "address"], "")}      onChange={v => setField(["landing_page", "footer", "address"], v)} />
      <TextField label="שעות פעילות"   value={getField(["landing_page", "footer", "hours"], "")}        onChange={v => setField(["landing_page", "footer", "hours"], v)} />
      <TextField label="זכויות יוצרים"  value={getField(["landing_page", "footer", "copyright"], "")}    onChange={v => setField(["landing_page", "footer", "copyright"], v)} />
    </>
  );
}

/* Silence unused import (useMemo is re-exported in case future) */
const _useMemoMaybe = useMemo;
void _useMemoMaybe;
