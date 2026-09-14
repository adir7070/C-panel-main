/**
 * WOW Landing Page — deterministic HTML template engine.
 *
 * Turns the LP content JSON (+ brand colors + AI images) into a complete,
 * self-contained, premium RTL Hebrew landing page that matches the quality of
 * the hand-built reference pages (KLIQ, Lugassy, FRESCO, Liabi, …).
 *
 * Design system distilled from those pages: Tailwind CDN + a reusable CSS layer
 * (aurora, glassmorphism, shimmer text, framed hero image with floating stat
 * cards, marquee gallery, scroll-reveal, count-up, gradient borders, lift-on-
 * hover, premium shadows) + a small vanilla-JS layer (reveal, count-up, marquee
 * duplication, mobile hamburger, single-open FAQ, lightbox, lead-form submit).
 *
 * The look is driven by an industry/tone PRESET (palette + fonts + vibe), with
 * brand colors overriding the preset palette when supplied.
 *
 * Exports:
 *   PRESETS                       — preset definitions keyed by name
 *   pickPreset(brief)             — choose a preset key from industry/tone
 *   resolveTheme(brief, design)   — merge preset + AI theme + preferred colors
 *   renderWowLandingPage(opts)    — return the full HTML string
 *
 * renderWowLandingPage is pure (no I/O), so it is trivially testable and never
 * throws on missing sections — anything absent is simply skipped.
 */

"use strict";

/* ──────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────── */

function h(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Attribute-safe (for href/src already produced internally). */
function attr(s) { return h(s); }

function isHex(c) { return typeof c === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()); }

/* "#0500C8" → "5,0,200" so we can build rgba() shadows/overlays. */
function hexToRgb(hex) {
  if (!isHex(hex)) return "0,0,0";
  let c = hex.trim().replace("#", "");
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  const n = parseInt(c, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/* Strip a phone to an Israeli intl number for wa.me / tel:. */
function intlPhone(raw) {
  const d = String(raw || "").replace(/[^\d]/g, "");
  if (!d) return "";
  if (d.startsWith("972")) return d;
  if (d.startsWith("0")) return "972" + d.slice(1);
  return d;
}

/* Split a number-ish string into { num, suffix, prefix } for count-up. */
function parseStat(value) {
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/^([^\d]*)([\d.,]+)(.*)$/);
  if (!m) return { num: null, prefix: "", suffix: s };
  const num = parseFloat(m[2].replace(/,/g, ""));
  return { num: isNaN(num) ? null : num, prefix: m[1] || "", suffix: m[3] || "" };
}

function imgFor(images, section) {
  const hit = (images || []).find(i => i && i.section === section && i.url);
  return hit ? hit.url : null;
}

/* ──────────────────────────────────────────────────────────────────────
   Presets — palette + fonts + vibe per industry/tone
   ────────────────────────────────────────────────────────────────────── */

const PRESETS = {
  /* Clean blue/cyan tech — SaaS, apps, marketing, startups (KLIQ vibe). */
  tech: {
    label: "tech",
    palette: { c1: "#0500C8", c2: "#006BFF", c3: "#00C8FF", c4: "#31E6C2", ink: "#0A1130", soft: "#F5F7FB", body: "#3A3A3A" },
    fonts: [{ family: "Assistant", weights: "400;500;600;700;800" }],
    headFont: "Assistant", bodyFont: "Assistant", displayFont: "Assistant",
    serifHeadings: false,
    heroBg: "soft",
  },

  /* Gold / charcoal serif luxury — fashion, tailoring, jewelry, fine dining,
     premium real-estate, law (Lugassy / FRESCO / Rafi vibe). */
  luxury: {
    label: "luxury",
    palette: { c1: "#B8893B", c2: "#8E6B28", c3: "#D4B070", c4: "#1F1810", ink: "#1B140B", soft: "#FBF6EE", body: "#4A4036" },
    fonts: [
      { family: "Frank Ruhl Libre", weights: "300;400;500;700;900" },
      { family: "Cormorant Garamond", weights: "300;400;500;600" },
      { family: "Heebo", weights: "300;400;500;700" },
    ],
    headFont: "Frank Ruhl Libre", bodyFont: "Heebo", displayFont: "Cormorant Garamond",
    serifHeadings: true,
    heroBg: "dark",
  },

  /* Coral / rose beauty — cosmetics, PMU, aesthetics, spa, hair, nails
     (Lior Beauty / Pure Beauty / Mentor vibe). */
  beauty: {
    label: "beauty",
    palette: { c1: "#E0699F", c2: "#FF8FA3", c3: "#FFB4A2", c4: "#C98BB9", ink: "#3E2433", soft: "#FFF6F3", body: "#5B4A52" },
    fonts: [
      { family: "Rubik", weights: "300;400;500;600;700;800" },
      { family: "Cormorant Garamond", weights: "300;400;500;600" },
    ],
    headFont: "Rubik", bodyFont: "Rubik", displayFont: "Cormorant Garamond",
    serifHeadings: false,
    heroBg: "soft",
  },

  /* Sunset coral/orange/teal vibrant — food, cafe, restaurant, catering,
     events, kids, leisure (Liabi vibe). */
  vibrant: {
    label: "vibrant",
    palette: { c1: "#FF5E3A", c2: "#FF8A3D", c3: "#1FB6B6", c4: "#FF4D8D", ink: "#2A1A12", soft: "#FFF8EE", body: "#4A3B33" },
    fonts: [{ family: "Heebo", weights: "300;400;500;700;800;900" }],
    headFont: "Heebo", bodyFont: "Heebo", displayFont: "Heebo",
    serifHeadings: false,
    heroBg: "soft",
  },

  /* Dark slate + amber bold — construction, contractors, industrial, auto,
     fitness, security (RM Build vibe). */
  bold: {
    label: "bold",
    palette: { c1: "#F59E0B", c2: "#0F172A", c3: "#FBBF24", c4: "#334155", ink: "#0A0F1C", soft: "#F1F5F9", body: "#334155" },
    fonts: [{ family: "Heebo", weights: "300;400;500;700;800;900" }],
    headFont: "Heebo", bodyFont: "Heebo", displayFont: "Heebo",
    serifHeadings: false,
    heroBg: "dark",
  },
};

const DEFAULT_PRESET = "tech";

/* Keyword → preset routing. Matches Hebrew + English in industry/tone/style. */
const PRESET_KEYWORDS = [
  ["luxury", ["luxur", "fashion", "tailor", "jewel", "boutique", "fine dining", "real estate", "law", "legal", "premium", "exclusive",
    "אופנה", "תפירה", "חליפ", "תכשיט", "יוקרה", "יוקרת", "מסעדת שף", "נדל\"ן", "נדלן", "עורך דין", "משפט", "בוטיק", "גורמה"]],
  ["beauty", ["beauty", "cosmet", "makeup", "pmu", "aesthet", "spa", "skin", "hair", "nails", "lash", "brow", "salon", "clinic",
    "יופי", "קוסמט", "איפור", "אסתטי", "ספא", "עור", "שיער", "ציפורניים", "ריסים", "גבות", "מספרה", "קליניק", "טיפוח", "פנים"]],
  ["vibrant", ["food", "restaurant", "cafe", "coffee", "bar", "cater", "bakery", "event", "party", "kids", "ice cream", "pizza", "burger", "juice",
    "אוכל", "מסעד", "קפה", "בית קפה", "בר", "קייטרינג", "מאפ", "אירוע", "מסיב", "ילדים", "גלידה", "פיצה", "המבורגר", "שתיה", "משקא"]],
  ["bold", ["construct", "build", "contractor", "renovat", "industrial", "auto", "garage", "fitness", "gym", "security", "logistic", "plumb", "electric",
    "בנייה", "בניה", "קבלן", "שיפוץ", "שיפוצ", "תעשי", "רכב", "מוסך", "כושר", "חדר כושר", "אבטחה", "לוגיסטי", "אינסטל", "חשמל", "מיזוג"]],
  ["tech", ["tech", "saas", "software", "app", "startup", "market", "digital", "fintech", "ai", "platform", "agency",
    "טכנולוג", "תוכנה", "אפליקצי", "סטארטאפ", "שיווק", "דיגיטל", "פינטק", "פלטפורמ", "סוכנות"]],
];

/* Substring match for keywords >=4 chars (tolerates Hebrew prefixes like
   ו/ה/ב/ל/מ/ש); whole-word match for short keywords ("בר","spa","ai") to avoid
   false positives such as "בר" inside "חברת". */
function kwHit(hay, w) {
  w = w.toLowerCase();
  if (w.length >= 4) return hay.includes(w);
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(`(^|[^\\p{L}])${esc}($|[^\\p{L}])`, "u").test(hay); }
  catch (e) { return hay.includes(w); }
}

function matchPreset(hay) {
  for (const [preset, words] of PRESET_KEYWORDS) {
    if (words.some(w => kwHit(hay, w))) return preset;
  }
  return null;
}

function pickPreset(brief) {
  brief = brief || {};
  /* Industry is the strongest signal — check it alone first, so a beauty clinic
     with a "luxurious" tone still routes to the beauty preset. */
  const byIndustry = matchPreset(String(brief.industry || "").toLowerCase());
  if (byIndustry) return byIndustry;

  /* Otherwise fall back to all available signals (tone, style, name, offer). */
  const hay = [brief.brandTone, brief.designStyle, brief.businessName, brief.keyOffer]
    .filter(Boolean).join(" ").toLowerCase();
  return matchPreset(hay) || DEFAULT_PRESET;
}

/* ──────────────────────────────────────────────────────────────────────
   Theme resolution: preset palette < AI design_theme colors < preferredColors
   ────────────────────────────────────────────────────────────────────── */

function resolveTheme(brief, design) {
  design = design || {};
  const presetKey = design.preset && PRESETS[design.preset] ? design.preset : pickPreset(brief || {});
  const preset = PRESETS[presetKey];
  const pal = { ...preset.palette };

  /* AI-chosen colors (only if valid hex). */
  if (isHex(design.primaryColor))   pal.c1 = design.primaryColor;
  if (isHex(design.secondaryColor)) pal.c2 = design.secondaryColor;
  if (isHex(design.accentColor))    pal.c3 = design.accentColor;

  /* Brand-supplied preferred colors win outright. */
  const pref = (brief && brief.preferredColors) || {};
  if (isHex(pref.primary))   pal.c1 = pref.primary;
  if (isHex(pref.secondary)) pal.c2 = pref.secondary;
  if (isHex(pref.accent))    pal.c3 = pref.accent;
  if (isHex(pref.extra1))    pal.c4 = pref.extra1;

  return {
    presetKey,
    preset,
    palette: pal,
    radius: design.radius != null ? design.radius : 18,
    overlayOpacity: design.overlayOpacity != null ? design.overlayOpacity : 0.5,
    sectionOrder: Array.isArray(design.sectionOrder) && design.sectionOrder.length ? design.sectionOrder : null,
    hiddenSections: Array.isArray(design.hiddenSections) ? design.hiddenSections : [],
  };
}

/* ──────────────────────────────────────────────────────────────────────
   <head> — fonts, tailwind config, reusable CSS layer (themed via vars)
   ────────────────────────────────────────────────────────────────────── */

function buildHead(ctx) {
  const { theme, businessName, metaDescription } = ctx;
  const p = theme.palette;
  const preset = theme.preset;

  const fontsHref = "https://fonts.googleapis.com/css2?" +
    preset.fonts.map(f => `family=${encodeURIComponent(f.family)}:wght@${f.weights}`).join("&") +
    "&display=swap";

  const headFamily    = `'${preset.headFont}',system-ui,sans-serif`;
  const bodyFamily    = `'${preset.bodyFont}',system-ui,sans-serif`;
  const displayFamily = `'${preset.displayFont}',serif`;

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(businessName)} | ${h((ctx.tagline || "").slice(0, 60))}</title>
<meta name="description" content="${h((metaDescription || "").slice(0, 160))}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="${attr(p.c1)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<meta property="og:title" content="${h(businessName)}">
<meta property="og:description" content="${h((metaDescription || "").slice(0, 160))}">
${ctx.heroImg ? `<meta property="og:image" content="${attr(ctx.heroImg)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${attr(fontsHref)}" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = { theme: { extend: {
  colors: { c1:'${p.c1}', c2:'${p.c2}', c3:'${p.c3}', c4:'${p.c4}', ink:'${p.ink}', soft:'${p.soft}', body:'${p.body}' },
  fontFamily: { sans: ['${preset.bodyFont}','system-ui','sans-serif'], head: ['${preset.headFont}','sans-serif'], display: ['${preset.displayFont}','serif'] },
} } };
</script>
<style>
  :root{
    --c1:${p.c1};--c2:${p.c2};--c3:${p.c3};--c4:${p.c4};
    --ink:${p.ink};--soft:${p.soft};--body:${p.body};
    --c1rgb:${hexToRgb(p.c1)};--c2rgb:${hexToRgb(p.c2)};--c3rgb:${hexToRgb(p.c3)};
    --radius:${theme.radius}px;
  }
  html{scroll-behavior:smooth}
  body{font-family:${bodyFamily};color:var(--body);overflow-x:hidden;background:#fff}
  h1,h2,h3,.font-head{font-family:${headFamily}}
  .font-display{font-family:${displayFamily}}
  .grad{background:linear-gradient(120deg,var(--c1) 0%,var(--c2) 55%,var(--c3) 100%)}
  .grad-soft{background:linear-gradient(160deg,rgba(var(--c1rgb),.06) 0%,var(--soft) 48%,rgba(var(--c3rgb),.08) 100%)}
  .grad-text{background:linear-gradient(110deg,var(--c1),var(--c2) 55%,var(--c3));-webkit-background-clip:text;background-clip:text;color:transparent}
  .shimmer{background:linear-gradient(110deg,var(--c1),var(--c2),var(--c3),var(--c4),var(--c2),var(--c1));background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sh 6s linear infinite}
  @keyframes sh{to{background-position:200% center}}
  .blob{position:absolute;border-radius:9999px;filter:blur(60px);z-index:0;pointer-events:none}
  .aurora{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
  .aurora i{position:absolute;border-radius:50%;filter:blur(80px);opacity:.5;animation:aur 16s ease-in-out infinite}
  .aurora i:nth-child(1){width:38rem;height:38rem;background:radial-gradient(circle,var(--c2),transparent 60%);top:-14rem;right:-8rem}
  .aurora i:nth-child(2){width:34rem;height:34rem;background:radial-gradient(circle,var(--c3),transparent 60%);bottom:-14rem;left:-6rem;animation-delay:-8s}
  .aurora i:nth-child(3){width:26rem;height:26rem;background:radial-gradient(circle,var(--c1),transparent 60%);top:30%;left:35%;animation-delay:-4s;opacity:.35}
  @keyframes aur{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(-3rem,2.5rem) scale(1.18)}}
  .grid-tex{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(rgba(var(--c1rgb),.04) 1px,transparent 1px),linear-gradient(90deg,rgba(var(--c1rgb),.04) 1px,transparent 1px);background-size:42px 42px;-webkit-mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,#000,transparent);mask-image:radial-gradient(ellipse 70% 60% at 50% 40%,#000,transparent)}
  .glass{background:rgba(255,255,255,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.7)}
  .glow{position:relative}
  .glow::before{content:"";position:absolute;inset:-12%;background:radial-gradient(circle,rgba(var(--c2rgb),.5),rgba(var(--c3rgb),.25) 45%,transparent 68%);filter:blur(45px);z-index:-1}
  .eyebrow{display:inline-flex;align-items:center;gap:.5rem;border-radius:9999px;padding:.4rem 1rem;font-size:.8rem;font-weight:800;color:var(--c2);background:linear-gradient(135deg,rgba(var(--c1rgb),.12),rgba(var(--c3rgb),.16));border:1px solid rgba(var(--c1rgb),.15)}
  .fcard{position:absolute;z-index:20;background:#fff;border-radius:1rem;box-shadow:0 20px 45px -14px rgba(var(--c1rgb),.28);padding:.65rem .9rem}
  .float{animation:fl 6s ease-in-out infinite}
  @keyframes fl{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
  .lift{transition:transform .35s cubic-bezier(.22,1,.36,1),box-shadow .35s}
  .lift:hover{transform:translateY(-6px);box-shadow:0 30px 60px -28px rgba(var(--c1rgb),.3)}
  .gb{position:relative;isolation:isolate}
  .gb::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1.5px;background:linear-gradient(135deg,var(--c2),var(--c3));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;opacity:0;transition:opacity .35s;z-index:-1}
  .gb:hover::before{opacity:1}
  .num-badge{display:inline-grid;place-items:center;height:2.6rem;width:2.6rem;border-radius:.9rem;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--c2),var(--c3));box-shadow:0 10px 24px -8px rgba(var(--c2rgb),.6)}
  .mq{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent);mask-image:linear-gradient(90deg,transparent,#000 7%,#000 93%,transparent)}
  .mq-track{display:flex;gap:1rem;width:max-content;animation:mq 38s linear infinite}
  .mq:hover .mq-track{animation-play-state:paused}
  @keyframes mq{to{transform:translateX(50%)}}
  [data-reveal]{opacity:0;transform:translateY(26px);transition:opacity .7s,transform .7s cubic-bezier(.22,1,.36,1)}
  [data-reveal].in{opacity:1;transform:none}
  details>summary{list-style:none}details>summary::-webkit-details-marker{display:none}
  details[open] .faq-ico{transform:rotate(45deg)}
  .gimg{border-radius:var(--radius);overflow:hidden;box-shadow:0 24px 50px -24px rgba(var(--c1rgb),.35);cursor:zoom-in}
  .gimg img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .5s}
  .gimg:hover img{transform:scale(1.06)}
  #lb{position:fixed;inset:0;z-index:120;background:rgba(8,10,30,.92);display:none;align-items:center;justify-content:center;padding:5vw}
  #lb.open{display:flex}#lb img{max-width:92vw;max-height:88vh;border-radius:1rem;box-shadow:0 30px 80px -20px #000}
  .wa-float{position:fixed;bottom:1.1rem;left:1.1rem;z-index:90;display:grid;place-items:center;height:3.4rem;width:3.4rem;border-radius:9999px;background:#25D366;color:#fff;box-shadow:0 14px 30px -8px rgba(37,211,102,.6);animation:fl 4s ease-in-out infinite}
  @media(prefers-reduced-motion:reduce){.aurora i,.shimmer,.mq-track,.float{animation:none}[data-reveal]{opacity:1!important;transform:none!important}}
</style>`;
}

/* ──────────────────────────────────────────────────────────────────────
   Section renderers
   ────────────────────────────────────────────────────────────────────── */

function renderHeader(ctx) {
  const { lp, businessName, logoUrl } = ctx;
  const hd = lp.header || {};
  const nav = (hd.navItems || []).filter(n => n && n.label);
  const logo = logoUrl
    ? `<img src="${attr(logoUrl)}" alt="${h(businessName)}" class="h-9 w-auto rounded-lg">`
    : `<span class="grid h-9 w-9 place-items-center rounded-lg grad text-white font-extrabold">${h((hd.logoText || businessName || "").trim().charAt(0) || "•")}</span>`;
  return `
<header id="hdr" class="sticky top-0 z-50 w-full border-b border-black/5 bg-white/85 backdrop-blur">
  <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3 md:px-8">
    <a href="#top" class="flex items-center gap-2 shrink-0">${logo}<span class="text-xl font-extrabold text-ink">${h(hd.logoText || businessName)}</span></a>
    <nav class="hidden items-center gap-6 text-sm font-semibold text-body lg:flex">
      ${nav.map(n => `<a href="${attr(n.href || "#")}" class="hover:text-ink transition">${h(n.label)}</a>`).join("")}
    </nav>
    <div class="flex items-center gap-2">
      <a href="#contact" class="hidden rounded-xl grad px-4 py-2 text-sm font-bold text-white shadow-md sm:inline-block">${h(hd.ctaText || "צור קשר")}</a>
      <button id="navToggle" aria-label="תפריט" aria-expanded="false" class="grid h-10 w-10 place-items-center rounded-lg ring-1 ring-black/10 lg:hidden">
        <svg id="navOpen" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        <svg id="navClose" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="hidden"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
  </div>
  <div id="mnav" class="hidden border-t border-black/5 bg-white lg:hidden">
    <nav class="mx-auto flex max-w-7xl flex-col px-5 py-2 text-sm font-semibold text-body">
      ${nav.map(n => `<a href="${attr(n.href || "#")}" class="border-b border-black/5 py-3.5">${h(n.label)}</a>`).join("")}
      <a href="#contact" class="py-3.5 font-extrabold text-ink">${h(hd.ctaText || "צור קשר")}</a>
    </nav>
  </div>
</header>`;
}

function renderHero(ctx) {
  const { lp, theme, heroImg } = ctx;
  const hero = lp.hero || {};
  const head = String(hero.headline || "");
  const hl = String(hero.headlineHighlight || "").trim();
  let headlineHtml;
  if (hl && head.includes(hl)) {
    headlineHtml = h(head.replace(hl, "")) + `<span class="shimmer">${h(hl)}</span>`;
  } else {
    /* shimmer the last 2 words by default */
    const parts = head.split(" ");
    if (parts.length > 2) {
      const tail = parts.slice(-2).join(" ");
      headlineHtml = h(parts.slice(0, -2).join(" ")) + " <span class=\"shimmer\">" + h(tail) + "</span>";
    } else {
      headlineHtml = `<span class="shimmer">${h(head)}</span>`;
    }
  }

  const stat = (lp.stats && lp.stats.items) || [];
  const fcards = stat.slice(0, 2).map((s, i) => {
    const ps = parseStat(s.value);
    const pos = i === 0 ? `top:12%;right:-2rem;animation-delay:.4s` : `bottom:14%;left:-2rem;animation-delay:1.2s`;
    return `<div class="fcard float text-right" style="${pos}"><div class="text-[11px] text-slate-400">${h(s.label || "")}</div><div class="text-base font-extrabold text-ink">${ps.num != null ? `${h(ps.prefix)}<span data-count="${ps.num}">0</span>${h(ps.suffix)}` : h(s.value)}</div></div>`;
  }).join("");

  const heroVisual = heroImg
    ? `<div class="glow relative mx-auto w-full max-w-md">
         <div class="overflow-hidden rounded-[1.6rem] shadow-2xl ring-1 ring-black/5"><img src="${attr(heroImg)}" alt="${h(ctx.businessName)}" class="aspect-[4/5] w-full object-cover"></div>
         ${fcards}
       </div>`
    : `<div class="glow grad relative mx-auto flex aspect-[4/5] w-full max-w-md items-center justify-center rounded-[1.6rem] text-white shadow-2xl"><span class="font-display text-6xl opacity-90">${h(ctx.businessName)}</span>${fcards}</div>`;

  const dark = theme.preset.heroBg === "dark";
  return `
<section id="top" class="relative overflow-hidden ${dark ? "grad text-white" : "grad-soft"}">
  <div class="aurora"><i></i><i></i><i></i></div>
  ${dark ? "" : `<div class="grid-tex"></div>`}
  <div class="relative mx-auto grid max-w-7xl items-center gap-10 px-5 py-16 md:px-8 lg:grid-cols-2 lg:py-28">
    <div data-reveal class="text-center lg:text-right">
      ${hero.eyebrow ? `<span class="${dark ? "eyebrow !text-white !bg-white/15 !border-white/25" : "eyebrow"}"><span class="relative flex h-2.5 w-2.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-c3 opacity-75"></span><span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-c3"></span></span>${h(hero.eyebrow)}</span>` : ""}
      <h1 class="mt-5 text-4xl font-extrabold leading-[1.08] tracking-tight ${dark ? "text-white" : "text-ink"} md:text-6xl">${headlineHtml}</h1>
      <p class="mx-auto mt-5 max-w-xl text-lg ${dark ? "text-white/85" : "text-body"} lg:mx-0">${h(hero.subheadline || "")}</p>
      <div class="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
        <a href="${attr(hero.ctaHref || "#contact")}" class="rounded-xl ${dark ? "bg-white text-ink" : "grad text-white"} px-7 py-3.5 font-extrabold shadow-lg transition hover:opacity-90 active:scale-95">${h(hero.ctaText || (lp.header && lp.header.ctaText) || "צור קשר")}</a>
        ${hero.secondaryCtaText ? `<a href="#services" class="rounded-xl px-7 py-3.5 font-bold ${dark ? "ring-1 ring-white/40 text-white" : "ring-1 ring-black/10 text-ink"} transition hover:bg-black/5">${h(hero.secondaryCtaText)}</a>` : ""}
      </div>
      ${hero.ctaSubtext ? `<p class="mt-3 text-sm ${dark ? "text-white/70" : "text-body/70"}">${h(hero.ctaSubtext)}</p>` : ""}
    </div>
    <div data-reveal class="relative flex items-center justify-center pt-6 lg:pt-0">${heroVisual}</div>
  </div>
</section>`;
}

function renderStats(ctx) {
  const st = ctx.lp.stats;
  if (!st || !(st.items || []).length) return "";
  const items = st.items.slice(0, 5);
  return `
<section class="border-y border-black/5 bg-white py-10">
  <div class="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-5 text-center md:grid-cols-${Math.min(items.length, 4)} md:px-8" data-reveal>
    ${items.map(s => { const ps = parseStat(s.value); return `<div><div class="text-3xl font-extrabold grad-text md:text-4xl">${ps.num != null ? `${h(ps.prefix)}<span data-count="${ps.num}">0</span>${h(ps.suffix)}` : h(s.value)}</div><div class="mt-1 text-sm font-semibold text-body/70">${h(s.label || "")}</div></div>`; }).join("")}
  </div>
</section>`;
}

const FALLBACK_ICONS = ["✦", "◆", "✶", "❖", "✷", "✧"];
function renderServices(ctx) {
  const sv = ctx.lp.services;
  if (!sv || !(sv.items || []).length) return "";
  const items = sv.items.slice(0, 6);
  return `
<section id="services" class="bg-soft py-16 md:py-24">
  <div class="mx-auto max-w-7xl px-5 md:px-8">
    <div class="text-center" data-reveal>
      <h2 class="text-3xl font-extrabold text-ink md:text-4xl">${h(sv.heading || "השירותים שלנו")}</h2>
      ${sv.subheading ? `<p class="mx-auto mt-3 max-w-2xl text-lg text-body/80">${h(sv.subheading)}</p>` : ""}
    </div>
    <div class="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-${items.length >= 3 ? 3 : items.length}" data-reveal>
      ${items.map((s, i) => {
        const img = imgFor(ctx.images, `services_${i + 1}`);
        return `<div class="gb lift overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          ${img ? `<div class="h-40 overflow-hidden"><img src="${attr(img)}" alt="${h(s.title || "")}" class="h-full w-full object-cover transition duration-500 hover:scale-105"></div>` : ""}
          <div class="p-6 text-right">
            <div class="grid h-12 w-12 place-items-center rounded-xl grad text-2xl text-white">${h(s.icon || FALLBACK_ICONS[i % FALLBACK_ICONS.length])}</div>
            <h3 class="mt-4 text-lg font-extrabold text-ink">${h(s.title || "")}</h3>
            <p class="mt-2 text-sm leading-relaxed text-body/80">${h(s.description || "")}</p>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>
</section>`;
}

function renderAbout(ctx) {
  const ab = ctx.lp.about;
  if (!ab || !(ab.body || ab.heading)) return "";
  const img = imgFor(ctx.images, "about");
  const points = (ab.points || []).filter(Boolean).slice(0, 4);
  const paras = String(ab.body || "").split(/\n+/).filter(Boolean);
  return `
<section id="about" class="bg-white py-16 md:py-24">
  <div class="mx-auto grid max-w-6xl items-center gap-12 px-5 md:px-8 ${img ? "lg:grid-cols-2" : ""}">
    <div data-reveal class="text-center lg:text-right">
      <span class="eyebrow">${h(ctx.businessName)}</span>
      <h2 class="mt-4 text-3xl font-extrabold text-ink md:text-4xl">${h(ab.heading || "קצת עלינו")}</h2>
      ${paras.map(p => `<p class="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-body/85 lg:mx-0">${h(p)}</p>`).join("")}
      ${points.length ? `<ul class="mx-auto mt-6 grid max-w-md gap-3 text-right text-body lg:mx-0">${points.map(pt => `<li class="flex items-center gap-2.5"><span class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white grad"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span>${h(typeof pt === "string" ? pt : (pt.title || pt.description || ""))}</li>`).join("")}</ul>` : ""}
    </div>
    ${img ? `<div data-reveal class="glow relative"><div class="overflow-hidden rounded-3xl shadow-2xl ring-1 ring-black/5"><img src="${attr(img)}" alt="${h(ab.heading || ctx.businessName)}" class="aspect-[4/5] w-full object-cover"></div></div>` : ""}
  </div>
</section>`;
}

function renderWhyUs(ctx) {
  const w = ctx.lp.why_us;
  if (!w || !(w.points || []).length) return "";
  const pts = w.points.slice(0, 4);
  return `
<section class="bg-soft py-16 md:py-24">
  <div class="mx-auto max-w-6xl px-5 md:px-8">
    <div class="text-center" data-reveal><h2 class="text-3xl font-extrabold text-ink md:text-4xl">${h(w.heading || "למה אנחנו")}</h2></div>
    <div class="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-${pts.length >= 4 ? 4 : pts.length}" data-reveal>
      ${pts.map((pt, i) => `<div class="lift rounded-2xl bg-white p-6 text-right shadow-sm ring-1 ring-black/5"><div class="text-3xl font-extrabold grad-text">0${i + 1}</div><h3 class="mt-3 text-lg font-extrabold text-ink">${h(pt.title || "")}</h3><p class="mt-2 text-sm leading-relaxed text-body/80">${h(pt.description || "")}</p></div>`).join("")}
    </div>
  </div>
</section>`;
}

function renderProcess(ctx) {
  const pr = ctx.lp.process;
  if (!pr || !(pr.steps || []).length) return "";
  const steps = pr.steps.slice(0, 6);
  const dark = ctx.theme.preset.heroBg === "dark";
  return `
<section id="process" class="relative overflow-hidden ${dark ? "bg-ink text-white" : "grad text-white"} py-20 md:py-28">
  <div class="aurora"><i></i><i></i></div>
  <div class="relative mx-auto max-w-7xl px-5 md:px-8">
    <div class="text-center" data-reveal><h2 class="text-3xl font-extrabold md:text-5xl">${h(pr.heading || "איך זה עובד")}</h2></div>
    <div class="mt-14 grid gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-${Math.min(steps.length, 5)}" data-reveal>
      ${steps.map((s, i) => `<div class="text-center"><div class="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/15 text-xl font-extrabold ring-1 ring-white/25">${h(s.step || i + 1)}</div><h3 class="mt-4 text-lg font-bold">${h(s.title || "")}</h3><p class="mx-auto mt-1.5 max-w-[15rem] text-sm leading-snug text-white/80">${h(s.description || "")}</p></div>`).join("")}
    </div>
  </div>
</section>`;
}

function renderGallery(ctx) {
  const g = ctx.lp.gallery || {};
  const imgs = (ctx.images || []).filter(i => /^gallery_\d+$/.test(i.section || "")).sort((a, b) => a.section.localeCompare(b.section, undefined, { numeric: true }));
  if (!imgs.length) return "";
  const tiles = imgs.map(im => `<div class="gimg shrink-0" style="width:18rem;height:13rem" data-lb="${attr(im.url)}"><img src="${attr(im.url)}" alt="${h(g.heading || ctx.businessName)}" loading="lazy"></div>`).join("");
  return `
<section id="gallery" class="bg-white py-16 md:py-24">
  <div class="mx-auto max-w-3xl px-5 text-center md:px-8" data-reveal>
    <h2 class="text-3xl font-extrabold text-ink md:text-4xl">${h(g.heading || "גלריה")}</h2>
    ${g.subheading ? `<p class="mx-auto mt-3 max-w-2xl text-lg text-body/80">${h(g.subheading)}</p>` : ""}
  </div>
  <div class="mq mt-12" data-reveal><div class="mq-track">${tiles}</div></div>
</section>`;
}

function renderTestimonials(ctx) {
  const t = ctx.lp.testimonials;
  if (!t || !(t.items || []).length) return "";
  const items = t.items.slice(0, 6);
  return `
<section class="bg-soft py-16 md:py-24">
  <div class="mx-auto max-w-7xl px-5 md:px-8">
    <div class="text-center" data-reveal><h2 class="text-3xl font-extrabold text-ink md:text-4xl">${h(t.heading || "מה הלקוחות אומרים")}</h2></div>
    <div class="mt-12 grid gap-5 md:grid-cols-${items.length >= 3 ? 3 : items.length}" data-reveal>
      ${items.map(it => {
        const rating = Math.max(0, Math.min(5, parseInt(it.rating, 10) || 5));
        return `<div class="lift rounded-2xl bg-white p-6 text-right shadow-sm ring-1 ring-black/5">
          <div class="text-c3" aria-label="דירוג">${"★".repeat(rating)}<span class="text-slate-200">${"★".repeat(5 - rating)}</span></div>
          <p class="mt-3 leading-relaxed text-body/90">"${h(it.quote || "")}"</p>
          <div class="mt-5 flex items-center gap-3"><span class="grid h-10 w-10 place-items-center rounded-full grad font-extrabold text-white">${h(String(it.name || "").trim().charAt(0) || "•")}</span><div><div class="font-bold text-ink">${h(it.name || "")}</div><div class="text-xs text-body/60">${h(it.role || "")}</div></div></div>
        </div>`;
      }).join("")}
    </div>
  </div>
</section>`;
}

function renderLead(ctx) {
  const ld = ctx.lp.lead || {};
  const heading = ld.heading || "רוצים שנחזור אליכם?";
  const cta = ld.ctaText || (ctx.lp.hero && ctx.lp.hero.ctaText) || "שליחה";
  return `
<section id="contact" class="relative overflow-hidden grad py-20 text-white md:py-28">
  <div class="aurora"><i></i><i></i></div>
  <div class="relative mx-auto grid max-w-5xl items-center gap-10 px-5 md:px-8 lg:grid-cols-2">
    <div data-reveal class="text-center lg:text-right">
      <h2 class="text-3xl font-extrabold md:text-5xl">${h(heading)}</h2>
      ${ld.subheading ? `<p class="mx-auto mt-4 max-w-xl text-lg text-white/85 lg:mx-0">${h(ld.subheading)}</p>` : ""}
      ${ctx.contactPhone ? `<a href="tel:${attr(intlPhone(ctx.contactPhone))}" dir="ltr" class="mt-6 inline-block text-2xl font-extrabold tracking-wide">${h(ctx.contactPhone)}</a>` : ""}
    </div>
    <form id="leadForm" novalidate data-reveal class="rounded-2xl bg-white p-6 shadow-2xl">
      <div class="grid gap-3 sm:grid-cols-2">
        <input id="leadName" name="name" type="text" required placeholder="שם מלא" class="rounded-xl bg-soft px-4 py-3 text-right text-ink ring-1 ring-black/10 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-c2">
        <input id="leadPhone" name="phone" type="tel" inputmode="tel" required placeholder="טלפון" dir="ltr" class="rounded-xl bg-soft px-4 py-3 text-right text-ink ring-1 ring-black/10 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-c2">
      </div>
      <button id="leadBtn" type="submit" class="mt-3 w-full rounded-xl grad px-5 py-3.5 font-extrabold text-white shadow-md transition hover:opacity-90 active:scale-95">${h(cta)}</button>
      <p id="leadMsg" class="mt-2.5 hidden text-center text-sm font-semibold text-ink"></p>
    </form>
  </div>
</section>`;
}

function renderFaq(ctx) {
  const f = ctx.lp.faq;
  if (!f || !(f.items || []).length) return "";
  return `
<section id="faq" class="bg-white py-16 md:py-24">
  <div class="mx-auto max-w-3xl px-5 md:px-8">
    <div class="text-center" data-reveal><h2 class="text-3xl font-extrabold text-ink md:text-4xl">${h(f.heading || "שאלות נפוצות")}</h2></div>
    <div class="mt-10 space-y-3" data-reveal>
      ${f.items.map(it => `<details class="group rounded-2xl bg-soft p-5 ring-1 ring-black/5"><summary class="flex cursor-pointer items-center justify-between gap-3 text-right font-bold text-ink"><span>${h(it.question || "")}</span><svg class="faq-ico shrink-0 text-c2 transition" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></summary><p class="mt-3 leading-relaxed text-body/80">${h(it.answer || "")}</p></details>`).join("")}
    </div>
  </div>
</section>`;
}

function renderFinalCta(ctx) {
  const fc = ctx.lp.final_cta;
  if (!fc || !(fc.heading || fc.subheading)) return "";
  const img = ctx.finalCtaImg;
  return `
<section class="relative overflow-hidden bg-ink py-20 text-center text-white md:py-28">
  ${img ? `<img src="${attr(img)}" alt="" class="absolute inset-0 h-full w-full object-cover opacity-30">` : ""}
  <div class="aurora"><i></i><i></i></div>
  <div class="relative mx-auto max-w-3xl px-5 md:px-8" data-reveal>
    <h2 class="text-3xl font-extrabold md:text-5xl">${h(fc.heading || "")}</h2>
    ${fc.subheading ? `<p class="mx-auto mt-4 max-w-xl text-lg text-white/85">${h(fc.subheading)}</p>` : ""}
    <a href="#contact" class="mt-8 inline-block rounded-xl bg-white px-8 py-4 font-extrabold text-ink shadow-lg transition hover:scale-105">${h(fc.ctaText || "צור קשר")}</a>
  </div>
</section>`;
}

function renderFooter(ctx) {
  const ft = ctx.lp.footer || {};
  const year = ctx.year;
  return `
<footer class="bg-ink py-14 text-white/80">
  <div class="mx-auto grid max-w-7xl gap-8 px-5 md:grid-cols-3 md:px-8">
    <div>
      <div class="flex items-center gap-2">${ctx.logoUrl ? `<img src="${attr(ctx.logoUrl)}" alt="${h(ctx.businessName)}" class="h-9 w-auto rounded-lg">` : ""}<span class="text-lg font-extrabold text-white">${h((ctx.lp.header && ctx.lp.header.logoText) || ctx.businessName)}</span></div>
      ${ft.tagline ? `<p class="mt-3 max-w-xs text-sm leading-relaxed text-white/60">${h(ft.tagline)}</p>` : ""}
    </div>
    <div>
      <div class="mb-3 text-xs font-extrabold uppercase tracking-widest text-white/50">צור קשר</div>
      ${ft.contactPhone ? `<a href="tel:${attr(intlPhone(ft.contactPhone))}" dir="ltr" class="block text-sm">${h(ft.contactPhone)}</a>` : ""}
      ${ft.contactEmail ? `<a href="mailto:${attr(ft.contactEmail)}" dir="ltr" class="block text-sm">${h(ft.contactEmail)}</a>` : ""}
    </div>
    <div>
      <div class="mb-3 text-xs font-extrabold uppercase tracking-widest text-white/50">פרטים</div>
      ${ft.address ? `<div class="text-sm">${h(ft.address)}</div>` : ""}
      ${ft.hours ? `<div class="mt-1 text-sm">${h(ft.hours)}</div>` : ""}
    </div>
  </div>
  <div class="mx-auto mt-10 max-w-7xl border-t border-white/10 px-5 pt-6 text-center text-xs text-white/40 md:px-8">${h(ft.copyright || `© ${year} ${ctx.businessName}. כל הזכויות שמורות.`)}</div>
</footer>`;
}

/* ──────────────────────────────────────────────────────────────────────
   Client-side JS
   ────────────────────────────────────────────────────────────────────── */

function buildScript(ctx) {
  const webhook = ctx.leadWebhook ? JSON.stringify(ctx.leadWebhook) : "null";
  const source = JSON.stringify(`LP:${ctx.businessName}`);
  return `<script>
(function(){
  /* mobile nav */
  var t=document.getElementById('navToggle');
  if(t){var m=document.getElementById('mnav'),o=document.getElementById('navOpen'),c=document.getElementById('navClose');
    function set(open){m.classList.toggle('hidden',!open);o.classList.toggle('hidden',open);c.classList.toggle('hidden',!open);t.setAttribute('aria-expanded',open);}
    t.addEventListener('click',function(){set(m.classList.contains('hidden'));});
    m.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){set(false);});});}
  /* marquee duplication */
  document.querySelectorAll('.mq-track').forEach(function(tr){tr.innerHTML+=tr.innerHTML;});
  /* single-open FAQ */
  var faqs=document.querySelectorAll('#faq details');
  faqs.forEach(function(d){d.addEventListener('toggle',function(){if(d.open)faqs.forEach(function(o){if(o!==d)o.open=false;});});});
  /* lightbox */
  var lb=document.getElementById('lb');
  if(lb){var lbi=lb.querySelector('img');
    document.querySelectorAll('[data-lb]').forEach(function(el){el.addEventListener('click',function(){lbi.src=el.getAttribute('data-lb');lb.classList.add('open');});});
    lb.addEventListener('click',function(){lb.classList.remove('open');});}
  /* count-up */
  function countUp(el){var target=parseFloat(el.getAttribute('data-count'))||0,dec=(String(target).split('.')[1]||'').length,t0=null,dur=1400;
    function step(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/dur,1),e=1-Math.pow(1-p,3),v=target*e;
      el.textContent=(dec?v.toFixed(dec):Math.round(v)).toLocaleString('en-US');if(p<1)requestAnimationFrame(step);}
    requestAnimationFrame(step);}
  /* reveal + trigger count-up */
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');e.target.querySelectorAll('[data-count]').forEach(countUp);io.unobserve(e.target);}});},{threshold:.12});
  document.querySelectorAll('[data-reveal]').forEach(function(el){io.observe(el);});
  /* lead form */
  var f=document.getElementById('leadForm');
  if(f){var nm=document.getElementById('leadName'),ph=document.getElementById('leadPhone'),bt=document.getElementById('leadBtn'),mg=document.getElementById('leadMsg');
    function msg(x,ok){mg.textContent=x;mg.classList.remove('hidden');mg.style.color=ok?'#0a8a4a':'#dc2626';}
    f.addEventListener('submit',function(e){e.preventDefault();
      var name=(nm.value||'').trim(),phone=(ph.value||'').replace(/[\\s\\-()]/g,'');
      if(name.length<2){msg('אנא הזינו שם',false);nm.focus();return;}
      if(!/^0\\d{8,9}$/.test(phone)){msg('אנא הזינו טלפון תקין',false);ph.focus();return;}
      var hook=${webhook};
      if(!hook){msg('תודה! נחזור אליכם בהקדם 🎉',true);f.reset();return;}
      bt.disabled=true;var o=bt.textContent;bt.textContent='שולח...';
      fetch(hook,{method:'POST',mode:'no-cors',body:new URLSearchParams({name:name,phone:phone,source:${source},page:location.href})})
        .then(function(){f.reset();msg('תודה! נחזור אליכם בהקדם 🎉',true);bt.textContent='נשלח ✓';})
        .catch(function(){bt.disabled=false;bt.textContent=o;msg('אופס, נסו שוב.',false);});
    });}
})();
</script>`;
}

/* ──────────────────────────────────────────────────────────────────────
   Top-level render
   ────────────────────────────────────────────────────────────────────── */

const DEFAULT_ORDER = ["hero", "stats", "services", "about", "why_us", "process", "gallery", "testimonials", "lead", "faq", "final_cta"];

const SECTION_FN = {
  hero: renderHero, stats: renderStats, services: renderServices, about: renderAbout,
  why_us: renderWhyUs, process: renderProcess, gallery: renderGallery,
  testimonials: renderTestimonials, lead: renderLead, faq: renderFaq, final_cta: renderFinalCta,
};

/**
 * @param {object} opts
 * @param {object} opts.landing_page  content JSON
 * @param {object} opts.design_theme  AI theme (colors, preset, order, hidden)
 * @param {array}  opts.images        [{section,url}]
 * @param {object} opts.brief         { businessName, industry, ... , logo, preferredColors }
 * @param {string} [opts.leadWebhook] URL the lead form POSTs to (no-cors)
 * @param {string} [opts.injectBeforeBodyEnd] extra HTML inserted before </body>
 *                  (the controller uses this for the approval bar)
 * @returns {string} full HTML document
 */
function renderWowLandingPage(opts) {
  opts = opts || {};
  const lp = opts.landing_page || {};
  const brief = opts.brief || {};
  const images = opts.images || [];
  const theme = resolveTheme(brief, opts.design_theme || {});

  const businessName = brief.businessName || (lp.header && lp.header.logoText) || "העסק שלך";
  const logoUrl = typeof brief.logo === "string" && brief.logo && !brief.logo.startsWith("data:") ? brief.logo : null;
  const contactPhone = (lp.footer && lp.footer.contactPhone) || brief.contactPhone || brief.phone || "";

  const ctx = {
    lp, theme, brief, images, businessName, logoUrl, contactPhone,
    heroImg: imgFor(images, "hero"),
    finalCtaImg: imgFor(images, "final_cta"),
    tagline: (lp.hero && lp.hero.headline) || (lp.footer && lp.footer.tagline) || "",
    metaDescription: (lp.hero && lp.hero.subheadline) || (lp.about && lp.about.body) || businessName,
    leadWebhook: opts.leadWebhook || null,
    year: opts.year || 2026,
  };

  const order = theme.sectionOrder || DEFAULT_ORDER;
  const hidden = theme.hiddenSections;
  const body = order
    .filter(k => !hidden.includes(k))
    .map(k => (SECTION_FN[k] ? SECTION_FN[k](ctx) : ""))
    .join("\n");

  const waHref = contactPhone
    ? `https://wa.me/${intlPhone(contactPhone)}?text=${encodeURIComponent("היי, הגעתי דרך האתר ואשמח לפרטים על " + businessName)}`
    : null;

  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
${buildHead(ctx)}
</head>
<body class="bg-white">
${renderHeader(ctx)}
<main>
${body}
</main>
${renderFooter(ctx)}
${waHref ? `<a class="wa-float" href="${attr(waHref)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 0 1 8.413 3.488 11.82 11.82 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.51 5.26l-.999 3.648 3.978-1.607zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.521.149-.174.198-.298.298-.496.099-.198.05-.372-.025-.521-.074-.149-.669-1.612-.916-2.207-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413z"/></svg></a>` : ""}
<div id="lb"><img alt=""></div>
${opts.injectBeforeBodyEnd || ""}
${buildScript(ctx)}
</body>
</html>`;
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET,
  pickPreset,
  resolveTheme,
  renderWowLandingPage,
  /* exported for unit tests */
  _helpers: { h, hexToRgb, intlPhone, parseStat },
};
