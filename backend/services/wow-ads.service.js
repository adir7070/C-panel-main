/**
 * WOW Ads — 10 marketing ads generation pipeline
 *
 * Pipeline (per session):
 *   1. OpenAI gpt-4o → 10 ad texts (Hebrew JSON)
 *   2. OpenAI gpt-4o → 10 image prompts ("nano prompts"), parallel
 *   3. OpenAI gpt-image-1 → 10 PNG images (1024×1024 upscaled to 1080),
 *      quality:"high", sequential w/ retry. When reference images exist
 *      (logo + client photos) we use images.edit; otherwise images.generate.
 *
 * Storage:
 *   - Mongo collection: `wow_ads_sessions`
 *     { _id, sessionId, phone, status, brief, generatedAds[], totalAds,
 *       completedCount, error?, createdAt, updatedAt }
 *   - Backblaze: `wow-ads/{phone}/{sessionId}/ad_{n}.png`
 */

const { OpenAI, toFile } = require("openai");
const sharp           = require("sharp");
const { getDB }       = require("../config/db");
const backblazeService = require("./backblaze.service");
const { uploadImage } = backblazeService;
const { formatBrandPalette } = require("../utils/brand-palette");
const {
  generateCreativeDirection,
  formatCreativeDirection,
  reviewGeneratedAd,
} = require("./wow-ads-direction.service");
const { buildPalette } = require("./wow-ads-palette.service");
const { renderAdLayout, RENDERER_VERSION } = require("./wow-ads-layout-renderer.service");

const AD_SIZE = 1080; // square output enforced regardless of what the image model returns

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete, geminiChat } = require("./text-gen.service");
// Gemini (gemini-3-pro-image-preview) is the PRIMARY image model; OpenAI is fallback.
const { generateImageBuffer: geminiGenerateImage, GEMINI_IMAGE_MODEL: GEMINI_IMG_MODEL } = require("./gemini-image-gen.service");

const OPENAI_MODEL       = process.env.OPENAI_ADS_MODEL  || "gpt-4o";
/* Image model — OpenAI gpt-image-2 alias (NOT the dated snapshot).
   Reverted from the 2026-04-21 snapshot pin on 2026-06-18 after the
   pin coincided with regression in the regular quota=10 leads flow
   (timeouts on a previously-stable path). Sticking with the floating
   alias matches the historically-working configuration. gpt-image-1
   stays out per user direction. */
const OPENAI_IMAGE_MODEL          = process.env.OPENAI_IMAGE_MODEL          || "gpt-image-2";
const OPENAI_FALLBACK_IMAGE_MODEL = process.env.OPENAI_FALLBACK_IMAGE_MODEL || "gpt-image-2";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";
const OPENAI_IMAGE_SIZE  = process.env.OPENAI_IMAGE_SIZE  || "1024x1024";
/* Vision review threshold — ads scoring below this get ONE auto-retry
   with the reviewer's retryInstruction injected back into the prompt. */
const REVIEW_PASS_SCORE = parseInt(process.env.WOW_ADS_PASS_SCORE || "82", 10);

/* Hybrid renderer flag — DISABLED BY DEFAULT.
   When OFF (default), the image model (gpt-image-2) paints the entire ad
   — including logo, headline, CTA, feature pills, fonts, decorations,
   multicolor headlines, scattered motifs. This matches how ChatGPT-style
   reference output (KLIQ 51-example set) was produced and gives the model
   access to its full font + design vocabulary.
   When ON, the deterministic SVG renderer takes over for logo/text/CTA/
   pills — guaranteed contrast and pixel-exact placement but limited to a
   small fixed font + icon library (max 2 fonts + 30 vector icons).
   Set WOW_ADS_ENABLE_RENDERER=true to opt back in to renderer mode. */
const USE_RENDERER = process.env.WOW_ADS_ENABLE_RENDERER === "true";

const sessionsCol = () => getDB().collection("wow_ads_sessions");

/* ────────────────────────────────────────────────────────────────────
   PROMPTS
   ──────────────────────────────────────────────────────────────────── */

/* Distribute N ads across the three types in roughly the same ratio as
   the original 10-ad mix (7 regular / 2 crazy / 1 carousel = 70/20/10).
   Always keep at least 1 carousel when N >= 5; smaller batches stay pure
   regular + crazy to avoid wasting a slot on a carousel of 1 image. */
function distributeAdTypes(n) {
  if (n <= 0) return { regular: 0, crazy: 0, carousel: 0 };
  if (n <= 2) return { regular: n, crazy: 0, carousel: 0 };
  if (n <= 4) return { regular: n - 1, crazy: 1, carousel: 0 };
  const carousel = Math.max(1, Math.round(n * 0.10));
  const crazy    = Math.max(1, Math.round(n * 0.20));
  const regular  = Math.max(0, n - carousel - crazy);
  return { regular, crazy, carousel };
}

function buildAdsTextPrompt({ businessProfileShort, servicesAndDeals, count, hasPromotion, language }) {
  // Non-Hebrew clients get a native-language prompt; Hebrew stays byte-identical.
  if (!require("./ad-languages.service").isHebrew(language)) {
    return buildAdsTextPromptIntl({ businessProfileShort, servicesAndDeals, count, hasPromotion, language });
  }
  const mix = distributeAdTypes(count);
  /* Promo rule (CampaignMaster pattern): when a deal exists, surface it in
     ~20% of the ads — the rest stay benefits-only. For our 10-ad default
     that's exactly 2, but for arbitrary N we keep the same ratio with a
     minimum of 1 so the promo is always represented. */
  const promoCount = hasPromotion ? Math.max(1, Math.round(count * 0.2)) : 0;
  return `תפקידך:
אתה קופירייטר לקמפיינים ממומנים בפייסבוק ובאינסטגרם.
אתה לא משרד פרסום.
אתה נשמע כמו בן אדם אמיתי — שייקי, חד, ישיר.

המטרה שלך היא אחת:
לעצור גלילה עם מסר חד שצמוד לשירות האמיתי של העסק.

📥 נתונים להזנה:
איפיון עסק:
${businessProfileShort}

שירותים ומבצעים:
${servicesAndDeals}

🎯 חוקי כתיבה (חובה):
- הכותרת חייבת לנקוב בשירות ספציפי מהרשימה — לא ניסוח כללי
- השתמש בשמות השירותים, במחירים, ובמאפיינים הייחודיים שמופיעים בנתונים
- כתוב כמו בעל העסק עצמו מדבר עם הלקוח: ישיר, אמיתי, בלי שטויות
- כותרות שייקיות: קצרות, חדות, מעוררות תגובה רגשית מיידית
- אסור כלישאות: "פתרון מקצועי / שירות איכותי / ניסיון רב שנים" — הם נשמעים גנריים
- אם יש מבצע — הוא חייב להיות ספציפי: מחיר, הטבה, תנאי

🚫 חוק קריטי — אסור להמציא מוצרים, שירותים או תיאורים שלא מופיעים בנתונים:
- אסור לחבר שני מושגים לתיאור מומצא (למשל: "ריסים חצי צפוף", "צבע עין מתוח", "פנים חצי שעה").
- אסור להוסיף תיאור (צפוף/מלא/מוארך/חדש/מתקדם) למוצר אם המילה לא מופיעה מילולית ברשימה.
- אם המושג שאתה רוצה לכתוב אינו קיים מילולית ב-"שירותים ומבצעים" → השתמש בשם השירות המקורי בלי שינוי.
- כל מילה בכותרת חייבת להיות מילה אמיתית בעברית. אסור צירופים שלא משמשים בשפת היומיום.
- במקרה של ספק: השתמש בשם השירות בדיוק כפי שכתוב, גם אם זה פחות "יצירתי".

🇮🇱 איכות עברית:
- בדוק שכל משפט הגיוני בקריאה רמה. אם נשמע מוזר → תכתוב מחדש.
- אסור תרגום מילולי מאנגלית ("צד עין" / "side eye" — לא קיים בעברית).
- שמות שירותים שמכילים מספר (X70₪) → המספר חייב להיצמד למחיר אמיתי שמופיע בנתונים.
- אסור צירופים תרגומיים שמרגישים "תרגום מ-Google" ולא משהו שישראלי אמיתי יגיד:
  • "לזוגות מתחילים" / "ללקוחות מתחילים" / "למשפחות מתחילות" — אין דבר כזה בעברית (לא מתרגמים "beginner couples" כך). אם הכוונה "צעירים בקשר" → כתוב "לזוגות צעירים" / "לזוגות בתחילת הדרך".
  • "ברמה אחרת" כסיומת — מוזר ושחוק. כתוב חוויה ספציפית: "ברומא / בליל ירח / על המים".
  • "פתרון מקצועי" / "ניסיון רב שנים" / "צוות מקצועי" — כלישאות ריקות שאסור להן להופיע.
- 🚨 אסור צורות פועל מומצאות / שגויות:
  • "נשכחי" / "תזכרי-תזכרו" שלא בהקשר פנייה ישירה / "יישכחי" / "תיהנו לכם" — צורות שלא קיימות בעברית תקנית.
  • לפני שאתה כותב פועל, ודא שהוא קיים מילולית בעברית מודרנית. במקרה של ספק: השתמש בצורה הפשוטה והנפוצה ביותר ("לא תשכחו", "שתזכרו לכל החיים", "בלתי נשכח").
  • דוגמת תרגום שכשל: "nightlife you won't forget" — נכון: "חיי לילה בלתי נשכחים" / "לילות שתזכרו לתמיד". שגוי לחלוטין: "חיי לילה שלא נשכחי".
  • העדף שמות תואר על פני זמן עתיד פסיבי: "בלתי נשכח" > "לא יישכח" > NEVER "לא נשכחי".
- מבחן השפיים: קרא בקול. אם זה לא נשמע כמו משהו שחבר היה אומר לחבר — שכתב.
${hasPromotion ? `
⚠️ כלל מבצע (חובה):
יש מבצע ספציפי בקלט. הוא חייב להופיע **בדיוק ב-${promoCount} מתוך ${count} מודעות** — לא יותר, לא פחות.
שאר ${count - promoCount} המודעות לא יזכירו מחיר/מבצע/הנחה — רק תועלת או רגש ספציפיים לשירות.
` : ""}
🧱 מבנה קבוע לכל מודעה (חובה):
החזר מערך JSON בלבד של ${count} אובייקטים:

{
  "ads": [
    {
      "id": 1,
      "type": "regular",
      "headline": "כותרת חדה וספציפית לשירות (עד 6 מילים)",
      "description": "טקסט קצר שמדגיש תועלת ספציפית + מידע על העסק (1-2 משפטים)",
      "cta": "טקסט כפתור (2-3 מילים)"
    }
  ]
}

חוקים:
- בעברית בלבד
- type יכול להיות: regular, crazy, או carousel
- וריאציה: ${mix.regular} רגילים, ${mix.crazy} מטורפים, ${mix.carousel} קרוסלה
- אסור Markdown או הסברים — JSON תקני בלבד`;
}

/* Multi-language ad-copy prompt — English instructions, native-language OUTPUT.
   Mirrors buildAdsTextPrompt's structure + anti-fabrication rules but drops the
   Hebrew-specific quality rules in favour of a generic native-fluency directive.
   Used for every non-Hebrew client. */
function buildAdsTextPromptIntl({ businessProfileShort, servicesAndDeals, count, hasPromotion, language }) {
  const { getLang, copyLanguageDirective } = require("./ad-languages.service");
  const L = getLang(language);
  const mix = distributeAdTypes(count);
  const promoCount = hasPromotion ? Math.max(1, Math.round(count * 0.2)) : 0;
  return `ROLE:
You are a senior direct-response copywriter for paid Facebook/Instagram campaigns. You sound like a real person — sharp, direct, punchy. Not an agency.

Your single goal: stop the scroll with a sharp message tied to the business's REAL service.

📥 INPUT DATA:
Business profile:
${businessProfileShort}

Services & deals:
${servicesAndDeals}

🎯 WRITING RULES (mandatory):
- The headline MUST name a specific service from the list — never a generic phrase.
- Use the real service names, prices and unique features from the data.
- Write the way the business owner would talk to a customer: direct, real, no fluff.
- Punchy headlines: short, sharp, emotionally immediate.
- No clichés ("professional solution / quality service / years of experience") — they sound generic.
- If there's a deal, it must be specific: price, offer, condition.

🚫 CRITICAL — never invent products, services or descriptions not in the data:
- Don't combine two concepts into an invented description.
- Don't add a qualifier (dense/full/extended/new/advanced) to a product unless the word literally appears in the list.
- If a concept isn't literally in "Services & deals" → use the original service name unchanged.
- When in doubt: use the service name exactly as written, even if it's less "creative".

🌐 LANGUAGE (critical):
${copyLanguageDirective(language)}
- Every sentence must read as natural, native ${L.name} — not a machine translation. Read it aloud: if a native ${L.name} speaker wouldn't say it, rewrite it.
- Use idioms and phrasing a local ${L.name} copywriter would actually use.
${hasPromotion ? `
⚠️ DEAL RULE (mandatory):
There is a specific deal in the input. It must appear in EXACTLY ${promoCount} of ${count} ads — no more, no less.
The other ${count - promoCount} ads must NOT mention any price/deal/discount — only a specific benefit or emotion tied to the service.
` : ""}
🧱 FIXED STRUCTURE per ad (mandatory):
Return a JSON object only, with an "ads" array of ${count} objects:

{
  "ads": [
    {
      "id": 1,
      "type": "regular",
      "headline": "sharp service-specific headline (max 6 words), in ${L.name}",
      "description": "short text highlighting a specific benefit + business info (1-2 sentences), in ${L.name}",
      "cta": "button text (2-3 words), in ${L.name}"
    }
  ]
}

Rules:
- ALL copy in ${L.name} only.
- type can be: regular, crazy, or carousel.
- Variation: ${mix.regular} regular, ${mix.crazy} crazy, ${mix.carousel} carousel.
- No Markdown or explanations — valid JSON only.`;
}

/**
 * Detect "go vibrant" hints in the brief's color note. When the brief says
 * things like "צבעוני / משוגע / חי / תוסס / קיצי / vibrant / tropical /
 * neon / pop", we inject an explicit saturated palette directive so Gemini
 * doesn't fall back to muted neutrals (its default). CampaignMaster pattern.
 */
const VIBRANT_HINTS = ["צבעוני", "משוגע", "חי", "תוסס", "קיצי", "tropical", "vibrant", "bright", "pop", "neon"];
function vibrantOverride(rawNote) {
  if (!rawNote) return null;
  const lc = String(rawNote).toLowerCase();
  if (!VIBRANT_HINTS.some(w => lc.includes(w))) return null;
  return `Brand color direction: VIBRANT TROPICAL POP — saturated bright palette (sunset orange #FF6B35, citrus yellow #FFD23F, electric turquoise #06D6A0, hot pink #FF4D9D, sky blue #4CC9F0). High color contrast, bold blocks of color, NOT muted or beige. Think summer beach poster, juice-stand graphics, neon retro signage. The ad should LOOK joyful at a glance.`;
}

/* Maps the renderer's panelLayoutType to a description of where the
   model should LEAVE EMPTY SPACE so the SVG renderer can paint the
   brand panel on top without clashing with the photo subject. */
const HERO_NEGATIVE_SPACE_HINT = {
  "curved-split-left-text": "Leave the LEFT 50-55% of the canvas as clean negative space (soft, low-contrast, suitable for text overlay) — keep the photographic subject confined to the RIGHT half.",
  "diagonal-left-panel":    "Leave the LEFT 50% of the canvas as clean negative space — the subject lives on the RIGHT side and the composition should naturally tilt the eye rightward.",
  "soft-blob-left-panel":   "Leave the LEFT 50% of the canvas as soft uncluttered space — the subject lives on the RIGHT side.",
  "arch-left-panel":        "Leave the LEFT 50% of the canvas as quiet bright space — the subject lives on the RIGHT, ideally framed by a natural arch shape if possible.",
  "bottom-heavy-editorial": "The subject + scene fills the TOP 65% of the canvas. Leave the BOTTOM 35% as clean low-contrast negative space — the SVG renderer will paint a brand panel + CTA + 3 pills along the bottom.",
};

function buildNanoPromptPrompt(ad, ctx, direction = null) {
  const palette = formatBrandPalette(ctx.preferredColors, {
    defaults: { primary: "#1E3A8A", secondary: "#06B6D4", accent: "#10B981" },
  });
  /* Vibrant override wins over the hex palette if the design-style note
     screams "go bright". Otherwise the regular palette is used as-is. */
  const vibrant = vibrantOverride(ctx.designStyle) || vibrantOverride(ctx.colorHint);
  /* Brand colors are MANDATORY — phrased as imperative rules, not
     suggestions. Gemini was treating "Brand colors: X — use these in
     the ad design" as a soft hint and defaulting to muted neutrals.
     Listing the colors as forbidden-to-deviate fixes that. */
  const colorNote = vibrant
    ? vibrant
    : (palette
      ? `MANDATORY BRAND COLORS — the brand's palette is ${palette}. EVERY visible color element (background, headline color, body text color, CTA button fill, decorative shapes, gradients, accent details) MUST be drawn from this exact palette. DO NOT introduce other hues. DO NOT default to beige, taupe, off-white, or generic muted neutrals when the brand colors above are vivid. If a passage of the design needs a neutral, use the darkest or lightest brand color, not an invented gray.
CRITICAL — these hex codes are INSTRUCTIONS for YOU, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw color swatches, NEVER draw a row of color chips, NEVER draw a brand-palette legend or design-spec bar anywhere on the canvas. The hex values are invisible to the viewer — they only tell you what colors to USE in the photo, text, and CTA.`
      : "Use professional brand-friendly colors with strong contrast.");

  // Language of the on-image copy. Hebrew keeps every legacy string verbatim;
  // other languages swap the Hebrew-specific directives (RTL, transliteration,
  // kosher) for language-appropriate ones. See services/ad-languages.service.js.
  const { getLang, imageTextDirective, isHebrew } = require("./ad-languages.service");
  const _L = getLang(ctx.language);
  const _heb = isHebrew(ctx.language);

  const logoNote = ctx.hasLogo
    ? (_heb
      ? `LOGO: The brand logo image is the LAST attached reference. Reproduce the EXACT logo mark and brand name from the reference image (do NOT redesign it). Place it in the UPPER-LEFT of the canvas inside the brand panel — and append the brand's Hebrew transliteration name directly beside or under the logo (e.g. "Luna Bake | לונה בייק", "Smile Craft | סמייל קראפט", "PlayBox | פלייבוקס") in a clean Hebrew sans-serif.`
      : `LOGO: The brand logo image is the LAST attached reference. Reproduce the EXACT logo mark and brand name from the reference image (do NOT redesign it). Place it in the UPPER area of the brand panel. Keep the brand name exactly as it appears in the logo — do NOT transliterate or translate it.`)
    : "";

  const sceneNote = ctx.hasScene
    ? `Reference photos of the actual business are attached. Use them as the source of truth for the SUBJECT scene that occupies the RIGHT half of the canvas — reproduce the actual space, products, decor, lighting, and people from those photos. Do NOT invent a generic or stock scene. The attached photos ARE this business.
IRON LAW — SINGLE UNIFIED SUBJECT: The right-half subject is ONE coherent moment in ONE place at ONE time of day. NEVER stitch multiple reference photos into a collage. If multiple references are attached, pick ONE as the anchor scene and ignore the others.`
    : "";
  const analysisBlock = ctx.nanoPromptTips?.length
    ? `\nBUSINESS ANALYSIS — APPLY THESE TIPS WHEN WRITING THE GEMINI PROMPT:\n${ctx.nanoPromptTips.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";
  const geminiTipsBlock = ctx.geminiTips?.length
    ? `\n\nBUSINESS VISUAL TIPS FOR GEMINI (include these in the generated prompt):\n${ctx.geminiTips.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";
  const userChangeNote = ctx.userChangeRequest
    ? `\nCRITICAL USER CHANGE REQUEST (apply this above all else, even if it contradicts the rules below): ${ctx.userChangeRequest}`
    : "";
  const slideNote = ad._slideContext
    ? `\nCAROUSEL SLIDE CONTEXT — render a SINGLE full-bleed scene (NEVER a 2×2 panel grid). ${ad._slideContext}`
    : "";

  /* If the upstream user-change-request injects "CRITICAL RETRY FIX" copy,
     it overrides this. Otherwise the direction block is the source of truth
     for layout/typography/scene — replaces the old hardcoded split-layout
     section so every ad in a batch can have a different visual language. */
  const directionBlock = direction
    ? `\n\n${formatCreativeDirection(direction)}`
    : "";

  /* Hero-only mode — when the deterministic SVG renderer is active, the
     model paints ONLY the photographic hero scene. All text/logo/CTA/pills
     are rendered downstream in code, so asking the model to draw them too
     would produce duplicate-and-misaligned chaos. Returns a fully different
     prompt focused on scene + negative space. */
  if (ctx.heroOnly) {
    const layoutHint = HERO_NEGATIVE_SPACE_HINT[direction?.panelLayoutType]
      || HERO_NEGATIVE_SPACE_HINT["curved-split-left-text"];
    return `You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for OpenAI's image API to generate the HERO PHOTO for a ${_heb ? "Hebrew RTL" : `${_L.name} (${_L.dir.toUpperCase()})`} Instagram ad. A downstream SVG renderer will paint the brand logo, headline, description, CTA, and 3 feature pills onto the resulting image — your job is to produce a clean photographic background that LEAVES ROOM for those elements without competing with them.

Business: ${ctx.servicesAndDeals}
${colorNote}
${sceneNote}${analysisBlock}${geminiTipsBlock}${userChangeNote}${slideNote}${directionBlock}

═══════ HERO-ONLY MODE — IRON LAWS ═══════
🚫 IRON LAW #1 — NO TEXT IN THE IMAGE: Do NOT render any Hebrew letters, Latin letters, numerals, signs, posters, menus, chalkboards with text, or labeled products. NO headline, NO description, NO CTA button, NO words anywhere in the output. The image is a pure photographic background.
🚫 IRON LAW #2 — LOGO ONLY AS ORGANIC IN-SCENE ELEMENT: The brand logo is provided as a reference SO THAT you can show it where it naturally belongs in the real business — on workers' uniforms, on a shop sign behind the counter, embroidered on an apron, printed on equipment, etched on a glass door, painted on a vehicle. This kind of organic integration is DESIRABLE and elevates the ad's authenticity. STRICTLY FORBIDDEN: any rendered logo OUTSIDE the photographic scene — no logo overlaid on negative space, no logo on a designed card or badge, no large "brand mark + transliteration" graphic block, no logo in a corner watermark, no logo with text appearing in empty canvas areas. The deterministic SVG renderer paints the brand-panel logo separately; if you add a designed logo card the two will collide.
🚫 IRON LAW #3 — NO UI / NO DESIGN ELEMENTS: NO buttons, NO icons, NO feature pills, NO badges, NO scrollbars, NO graphic dividers — none of those exist in the source photo. The output looks like a real photograph, not an Instagram template.
🚫 IRON LAW #4 — NEGATIVE SPACE FOR THE PANEL: ${layoutHint}
🚫 IRON LAW #5 — PHOTOREAL SUBJECT: The output MUST look like a professional photograph shot on a real camera (Getty/Magnum editorial quality). NO cartoon, illustrated, painted, CGI, 3D render, Pixar-style, cel-shaded, plastic skin, anime, vector art, flat-design. Real humans, real places, real light.
🚫 IRON LAW #6 — HUMAN ANATOMY: Every person in frame has EXACTLY 1 head, 1 neck, 2 arms, 2 hands with 5 fingers each, 2 legs, 2 feet. Faces symmetric, natural features. ANY anatomical error = failed ad.
🚫 IRON LAW #7 — KOSHER FOOD ONLY (ISRAELI MARKET): All food and drink shown in the image MUST be kosher. STRICTLY FORBIDDEN: meat + dairy together in any frame, on any plate, on any table, or in any product (no cheeseburger, no meat pizza with cheese, no chicken in cream sauce, no bacon with cheese, no meat lasagna with cheese, no meat sandwich with cheese slice, no carpaccio with parmesan, no milk/yogurt drink served alongside meat). Also forbidden: pork in any form (no bacon, ham, prosciutto, salami with pork, pepperoni, pulled pork), shellfish (no shrimp, lobster, crab, calamari, octopus, mussels), eel, catfish. If a meat dish appears, dairy MUST NOT appear in the same frame; if a dairy dish appears, meat MUST NOT appear in the same frame. When in doubt, render parve (neither meat nor dairy: vegetables, grains, fish with fins+scales, fruit) or pick a clearly-dairy or clearly-meat scene and keep it pure.
═══════════════════════════════════════════

Visual rules:
- Use the brand's color palette as the dominant tonal mood of the photo (soft cream + brand cyan, warm amber + dark charcoal, etc.). The negative-space side of the photo should naturally land in a tone that text in the brand's darkest color will read against (light area for dark text, dark area for light text).
- Lighting: warm key + soft fill, color-graded to harmonize with the brand colors. Deep focus across the subject — no DOF blur.
- Composition: 1:1 square (1024×1024), the subject occupies the side opposite to the panel negative space.
- The viewer should feel they're inside the actual business — shop / clinic / studio / kitchen / showroom — with rich material detail (wood grain, fabric weave, ceramic glaze, skin texture). NOT a smooth plasticky surface anywhere.

Output ONE single-line English prompt, no quotes, no \\n, no extra prose.`;
  }

  /* Contact-info block — only rendered when the manager opted in on
     the characterization form. Phrased as a mandatory render so the
     image model doesn't silently swallow it; we want the actual
     phone/address string to appear on the creative. */
  const contactInfoBlock = (() => {
    const lines = [];
    if (ctx.includePhoneInAds && ctx.businessPhone) {
      lines.push(`CONTACT PHONE — MANDATORY: Display the phone number "${ctx.businessPhone}" prominently on the ad (typically next to the CTA, or as a small footer badge). Use the same clean sans-serif as the rest of the copy. The exact digits must render character-by-character — do NOT swap digits, do NOT shorten, do NOT translate to words.`);
    }
    if (ctx.includeAddressInAds && ctx.address) {
      lines.push(`CONTACT ADDRESS — MANDATORY: Display the address "${ctx.address}" prominently on the ad (typically as a small footer line, optionally with a 📍 location-pin icon). Render the text verbatim — do NOT translate, do NOT abbreviate.`);
    }
    return lines.length ? `\n\n${lines.join("\n\n")}` : "";
  })();

  // Language-conditional prompt blocks — Hebrew keeps the original strings
  // verbatim; other languages get language-appropriate equivalents.
  const textRenderingBlock = _heb
    ? `═══════ HEBREW TEXT — PIXEL-PERFECT RENDERING ═══════
All copy is in HEBREW (right-to-left). The model frequently swaps similar Hebrew letters or invents words — these are the #1 and #2 failure modes.

IRON-CLAD CONTRACT — render ONLY what is written in the source copy above:
• The EXACT character sequence for headline / description / CTA is fixed. Do not add a word. Do not remove a word. Do not substitute a word. Do not "fix" spelling. Do not "improve" wording.
• Each Hebrew letter MUST be a recognizable letter from the standard Hebrew alphabet (א, ב, ג, ד, ה, ו, ז, ח, ט, י, כ, ל, מ, נ, ס, ע, פ, צ, ק, ר, ש, ת + finals ך, ם, ן, ף, ץ). NO invented glyphs. NO half-letters. NO Latin letters inside Hebrew words.
• Do NOT swap similar-looking letters: ב/כ, ד/ר, ה/ח, ו/ז/ן, ם/ס, ע/צ, ש/ם.
• Before drawing each Hebrew word, mentally compare character-by-character to the source. If even ONE character differs — DROP THE ENTIRE WORD and leave a space where it would have gone. Half-rendered or wrong-character Hebrew is far worse than missing text.
• If the rendered string would not be a real Hebrew word found in everyday spoken Hebrew → drop it. Better blank than gibberish.
• Use a CLEAN, MODERN Hebrew sans-serif font (Heebo / Assistant / Rubik style). Bold, high-contrast.
• NO decorative, calligraphic, script, handwritten, distorted, or stylized typography — these break Hebrew character recognition.
• Maintain proper RTL flow: text reads right-to-left, words spaced naturally.
• ALL text elements MUST flow strictly RIGHT-TO-LEFT. Within the left brand panel, headlines and body text are right-aligned to the panel's right inner edge (the edge nearest the subject scene). NEVER render Hebrew text flowing left-to-right under any circumstance.
═══════════════════════════════════════════════════════`
    : `═══════ ${_L.name.toUpperCase()} TEXT — PIXEL-PERFECT RENDERING ═══════
${imageTextDirective(ctx.language)}

IRON-CLAD CONTRACT — render ONLY what is written in the source copy above:
• The EXACT character sequence for headline / description / CTA is fixed. Do not add, remove, substitute, or "fix" any word or its spelling.
• Render every ${_L.name} character correctly and legibly. Before drawing each word, compare it character-by-character to the source; if even one character would come out wrong or as gibberish, DROP the whole word and leave a space. Better blank than wrong.
• Use a CLEAN, MODERN sans-serif that fully supports the ${_L.script} script. Bold, high-contrast. NO decorative, calligraphic, script, handwritten, distorted, or stylized typography.
• Words spaced naturally; text ${_L.dir === "rtl" ? "reads right-to-left and is right-aligned" : "reads left-to-right and is left-aligned"} within its text zone.
═══════════════════════════════════════════════════════`;

  const logoIronLaw = _heb
    ? `- 🚫 IRON LAW #2 — LOGO + HEBREW TRANSLITERATION TOGETHER: Reproduce the brand logo's EXACT mark and colors from the attached logo reference image, AND render the Hebrew transliteration directly beside or under it (the direction supplies the exact Hebrew text — use it verbatim character-by-character). Pattern examples seen in premium reference ads: "Luna Bake | לונה בייק", "Smile Craft | סמייל קראפט", "PAWS & CO | אהבה. טיפול. משפחה.", "RideOn | רייידאון". A bare Latin logo with NO Hebrew rendering beside it = FAILED. Logo+transliteration appear EXACTLY ONCE as one combined brand mark.`
    : `- 🚫 IRON LAW #2 — LOGO: Reproduce the brand logo's EXACT mark and colors from the attached logo reference image. Keep the brand name exactly as it appears in the logo — do NOT transliterate or translate it. The logo appears EXACTLY ONCE as one clean brand mark.`;

  const kosherIronLaw = _heb
    ? `- 🚫 IRON LAW #9 — KOSHER FOOD ONLY (ISRAELI MARKET): All food and drink shown in the image MUST be kosher. STRICTLY FORBIDDEN: meat + dairy together in any frame, on any plate, on any table, or in any product (no cheeseburger, no meat pizza with cheese, no chicken in cream sauce, no bacon with cheese, no meat lasagna with cheese, no meat sandwich with cheese slice, no carpaccio with parmesan, no milk/yogurt drink served alongside meat). Also forbidden: pork in any form (no bacon, ham, prosciutto, salami with pork, pepperoni, pulled pork), shellfish (no shrimp, lobster, crab, calamari, octopus, mussels), eel, catfish. If a meat dish appears, dairy MUST NOT appear in the same frame; if a dairy dish appears, meat MUST NOT appear in the same frame. When in doubt, render parve (neither meat nor dairy: vegetables, grains, fish with fins+scales, fruit) or pick a clearly-dairy or clearly-meat scene and keep it pure.`
    : "";

  return `You are a Creative Designer for paid Facebook & Instagram ads.
Write ONE single-line English prompt for OpenAI's image API to generate a final 1080×1080 ${_heb ? "Hebrew RTL" : `${_L.name} (${_L.dir.toUpperCase()})`} Instagram ad.

The ad must display the EXACT copy word-for-word:
Headline: "${ad.headline}"
Description: "${ad.description}"
CTA button: "${ad.cta}"
Ad type: ${ad.type}

Design style: ${ctx.designStyle || "modern"}
Services context: ${ctx.servicesAndDeals}
${colorNote}
${logoNote}
${sceneNote}${analysisBlock}${geminiTipsBlock}${userChangeNote}${slideNote}${directionBlock}${contactInfoBlock}

═══════ PREMIUM AD QUALITY BAR ═══════
Target output: a polished agency-level finished creative. Premium commercial advertising quality, strong visual hierarchy, crisp typography, clean spacing, high-end composition, realistic subject, polished lighting, professional branding. NOT a generic AI-image template. The viewer should believe this came from a top Tel Aviv brand studio.

Layout: FOLLOW THE CREATIVE DIRECTION ABOVE EXACTLY. Do NOT default to the same split layout used by every other ad in the batch. The direction's layoutType is the source of truth — if it says "bold typographic poster", build a typographic poster; if it says "center product hero", center the product; if it says "dark premium cinematic", go dark cinematic. Variety across the batch is mandatory.

${textRenderingBlock}

IRON LAWS (auto-fail conditions — independent of which layout the direction picks):
- 🚫 IRON LAW #1 — FOLLOW THE DIRECTION: The CREATIVE DIRECTION block above is the single source of truth for layout, scene, color treatment, typography, decorations, dividerShape, and copy weight. Do NOT substitute a generic split-layout or your default template if the direction names a different layoutType. Implement EVERY direction field exactly.
${logoIronLaw}
- 🚫 IRON LAW #3 — HEADLINE ACCENT WORD: The direction names ONE specific word from the headline (headlineAccentWord) that MUST receive visual emphasis — either rendered in the brand accent color, OR underlined with a brush-style highlight in the accent color, OR wrapped in a colored highlight shape. The rest of the headline stays in the brand's darkest color. A headline rendered entirely in one flat color with no accent = FAILED.
- 🚫 IRON LAW #4 — INDUSTRY-SPECIFIC DECORATIONS: Scatter the decoration motifs named in the direction (paw prints for pet shops, sparkles for dental, wheat sprigs for bakeries, gear strokes for bike shops, etc.) around the brand panel as small line-art elements in the brand accent color. They are what makes the ad feel native to its industry instead of generic. Empty decoration arrays are allowed only for the most minimalist layouts ("minimal clean SaaS" / "no divider — photo dominant").
- 🚫 IRON LAW #5 — PHOTOREAL SUBJECT: When the direction calls for a photographic subject (person, product, space) it MUST look like a professional photograph (Getty/Magnum editorial quality). STRICTLY FORBIDDEN for the photographic subject: cartoon, illustrated, painted, CGI, 3D render, Pixar-style, cel-shaded, plastic skin, anime, vector art, flat-design avatars. Decorative vector elements (sparkles, line-art icons, badges, brand ornaments — see IRON LAW #4) are allowed alongside a photoreal subject — but the subject itself must be photographic.
- 🚫 IRON LAW #6 — HUMAN ANATOMY: Every person in frame has EXACTLY 1 head, 1 neck, 2 arms, 2 hands with 5 fingers each, 2 legs, 2 feet. Faces symmetric, natural features. NO duplicated body parts, NO floating limbs, NO conjoined figures, NO melted features. ANY anatomical error = failed ad.
- 🚫 IRON LAW #7 — EACH TEXT ELEMENT RENDERS EXACTLY ONCE: The headline appears ONE time. The description appears ONE time (or is omitted entirely if direction.copyWeight is "low"). The CTA button appears ONE time. Each feature-pill label appears ONE time. NEVER duplicate, mirror, repeat, or echo any text element.
- 🚫 IRON LAW #8 — NO HEX CODES OR DESIGN-SPEC ARTIFACTS ON CANVAS: The brand-color hex codes given to you are INSTRUCTIONS for which colors to USE, not content to render. NEVER draw the hex strings (#F4F4F4, etc.), NEVER draw a row of color swatches, NEVER draw a palette legend or design-spec bar anywhere on the canvas.
${kosherIronLaw}

Output rules:
- Output ONE single-line English prompt, no quotes, no \\n, no extra prose.

Direction-agnostic constraints (apply regardless of layoutType):
- CTA must be clear and visually distinct (button, badge, or strong typographic treatment per the direction).
- Visual hierarchy: the eye should land on ONE primary element first (usually the headline), then the subject, then the CTA. Avoid competing focal points.
- Do not overcrowd: prefer generous negative space over packed text and decoration.
- NO thin horizontal divider lines as decoration (no <hr> lines, no thin gold rule lines under titles). Use spacing, ornaments, color blocks, or curves for separation.
- Aspirational feel: looks premium and on-brand — like a real campaign from a top Tel Aviv brand studio, not a stock template.
- 🚫 NO INVENTED CONTACT INFO / URL: Render ONLY the contact details explicitly provided in this prompt. NEVER fabricate or render a website URL, domain (e.g. "www.brand.co.il"), email address, social handle, phone number, or street address that was not given above. If no phone/website/address was provided, the ad shows NONE of them — do not invent plausible-looking contact info to fill space. The only text allowed on the ad is the headline, description, CTA, brand name/logo, feature pills, and any contact detail explicitly supplied.

ABSOLUTE LAYOUT CONSTRAINTS:
- The canvas is an EXACT 1:1 square — 1080×1080 only. No portrait or landscape output.
- LOGO + transliteration: TOPMOST PIXEL sits at least 5% below the top edge.
- HEADLINE: the headline is the design's hero — it MAY extend to 2-3% from the inner edge of its enclosing zone (panel inner edge or canvas edge if no panel). Headlines clipped at the edge are a failure; headlines that confidently fill their column to a 2-3% margin are correct. The premium reference ads (KLIQ output) intentionally let the headline crowd the panel edge for visual impact — do the same.
- DESCRIPTION / BODY text: sits at least 5% inset from each enclosing edge.
- CTA button + feature-pill labels: sit at least 6% inset from each canvas edge — these must never crowd the edge.
- No text character may touch or bleed OFF any canvas edge under any circumstance.
- If text doesn't fit — REDUCE FONT SIZE before pushing text toward edges, and never let characters get clipped.

═══════ MATERIAL & DETAIL REINFORCEMENT ═══════
- RICH MATERIAL DETAIL: visible textures (wood grain, fabric weave, metal sheen, ceramic glaze, skin texture). NOT a smooth plasticky surface anywhere on the photographic subject.
- SPECIFIC OVER GENERIC: a particular ceramic vase with morning light catching its rim, NOT "some flowers". A specific brand of polish bottle reflecting the salon light, NOT "skincare products".
- The viewer should be able to scan the subject and discover small detailed objects (a pair of glasses on the counter, a folded towel, a half-burnt candle). Reward repeat viewing.`;
}

/* ────────────────────────────────────────────────────────────────────
   AI HELPERS
   ──────────────────────────────────────────────────────────────────── */

async function generateAdsTexts(brief, count = 10) {
  const businessProfileShort = [
    brief.businessName && `שם: ${brief.businessName}`,
    brief.businessField && `תחום: ${brief.businessField}`,
    brief.businessNiche && `נישה: ${brief.businessNiche}`,
    brief.about && `על העסק: ${brief.about}`,
    brief.targetAudience?.length && `קהל יעד: ${brief.targetAudience.join(", ")}`,
  ].filter(Boolean).join("\n");

  const servicesAndDeals = [
    brief.services && `שירותים: ${brief.services}`,
    brief.promotion && `מבצע נוכחי: ${brief.promotion}`,
  ].filter(Boolean).join("\n") || "ללא מבצע פעיל";

  const { getLang } = require("./ad-languages.service");
  const L = getLang(brief.language);
  const prompt = buildAdsTextPrompt({
    businessProfileShort,
    servicesAndDeals,
    count,
    hasPromotion: !!brief.promotion,
    language: brief.language,
  });

  const completion = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: L.code === "he"
        ? `You are an Israeli copywriter. Always respond with valid JSON containing an 'ads' array of ${count} items.`
        : `You are a native ${L.name} direct-response copywriter. Write ALL ad copy in ${L.name} only. Always respond with valid JSON containing an 'ads' array of ${count} items.` },
      { role: "user",   content: prompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const ads = Array.isArray(parsed.ads) ? parsed.ads : Array.isArray(parsed) ? parsed : [];
  if (ads.length < count) throw new Error(`OpenAI returned only ${ads.length} ads, expected ${count}`);

  return { ads: ads.slice(0, count), servicesAndDeals };
}

const BUSINESS_ANALYST_SYSTEM = `You are a precision visual marketing analyst. Your output feeds directly into AI image generation — every wrong detail produces a wrong image that fails the client.

You receive: a business profile (services, vehicles, capacity, style) + optional logo + optional reference photos.

YOUR PRIMARY JOB: Read every service detail with surgical precision and translate it into exact visual instructions. Generic tips destroy the ad. Wrong visuals (wrong vehicle, wrong room, wrong scale) make the client look unprofessional.

Return ONLY valid JSON:
{
  "nanoPromptTips": ["...", "...", "..."],
  "geminiTips": ["...", "...", "..."]
}

━━━ SERVICE PRECISION — THE MOST IMPORTANT RULE ━━━
Before writing any tip, extract the EXACT physical details of every service:
- Transport business: What is the EXACT vehicle type? Minibus (8 seats) ≠ bus (50 seats) ≠ sedan ≠ van. If the profile says "minibus for 8 passengers" — tips must say "minibus, approximately 8 seats" and EXPLICITLY PROHIBIT a full-size bus, coach, or minivan unless that is what is described.
- Beauty/wellness: Is it one operator or a full salon? 1 chair or 20? Nail bar or full spa? Be exact.
- Food: Specific dishes? Hummus spot ≠ restaurant ≠ bakery. Name the exact food.
- Retail: What exact products? Small boutique ≠ large store.
- Always ask: what would the image AI default to if given no guidance? THAT is what you must correct with explicit "do NOT show X, show Y instead."

━━━ nanoPromptTips (for the GPT that writes the Gemini prompt) ━━━
Tips that guide SCENE CHOICE and COMPOSITION:
1. The EXACT physical setting: where does this service happen? Describe it precisely.
2. The EXACT subject: what vehicle / space / product / person appears? Be hyper-specific (e.g., "a silver Mercedes Vito minibus, seats ~8 passengers" not "a vehicle").
3. The EXACT wrong visual to avoid: what would the AI default to that is wrong for this business? State it explicitly.
4. The target customer: who is in the scene, what are they doing, what emotion do they show?
5. The unique visual angle: one specific composition or moment that belongs only to this business.

━━━ geminiTips (passed verbatim into the Gemini image generation prompt) ━━━
Tips that control RENDERING QUALITY and ACCURACY:
1. Exact vehicle/product/space specification with size, color, model if known from profile or photos.
2. The scene setting: time of day, location, weather/light that suits this business.
3. The people: who, how many, what they wear, what they are doing — be cinematic and specific.
4. Any unique visual from the reference photos (specific decor color, logo on vehicle, uniform color).
5. What must be EXCLUDED: name the wrong visual explicitly (e.g., "NOT a full-size bus or coach — only a compact minibus").
6. The emotional quality: what should the viewer FEEL looking at this image? Warm? Excited? Reassured?

Rules:
- Minimum 4 tips per list, maximum 6
- Every tip is 100% specific to THIS business — zero generic marketing language
- If reference photos provided: base visual tips on exactly what you see in them
- English only
- The wrong-visual prohibition tip is MANDATORY whenever the AI could default to the wrong scale/type`;

async function analyzeBusinessForAds(brief, logoBuffer, imageBuffers) {
  try {
    const imageContent = [];
    if (logoBuffer) {
      imageContent.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${logoBuffer.toString("base64")}` },
      });
    }
    for (const buf of imageBuffers) {
      imageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` },
      });
    }
    const textContent = {
      type: "text",
      text: `Business profile:\n${JSON.stringify({
        businessName:    brief.businessName,
        businessField:   brief.businessField,
        businessNiche:   brief.businessNiche,
        about:           brief.about,
        services:        brief.services,
        targetAudience:  brief.targetAudience,
        designStyle:     brief.designStyle,
        preferredColors: brief.preferredColors,
        promotion:       brief.promotion,
      }, null, 2)}`,
    };

    const completion = await chatComplete({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: BUSINESS_ANALYST_SYSTEM },
        { role: "user",   content: [textContent, ...imageContent] },
      ],
    });

    const raw    = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return {
      nanoPromptTips: Array.isArray(parsed.nanoPromptTips) ? parsed.nanoPromptTips.slice(0, 6) : [],
      geminiTips:     Array.isArray(parsed.geminiTips)     ? parsed.geminiTips.slice(0, 6)     : [],
    };
  } catch (err) {
    console.warn("[wow-ads] analyzeBusinessForAds failed — continuing without tips:", err.message);
    return { nanoPromptTips: [], geminiTips: [] };
  }
}

async function generateNanoPrompt(ad, ctx, direction = null) {
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "You output a single-line English prompt only. No quotes, no newlines, no commentary." },
      { role: "user",   content: buildNanoPromptPrompt(ad, ctx, direction) },
    ],
  });
  return (completion.choices[0]?.message?.content || "").trim().replace(/[\r\n]+/g, " ");
}

/* Resolve a stored asset (proxy URL, full URL, or B2 path) to a Buffer. */
async function fetchAssetBuffer(ref) {
  if (!ref || typeof ref !== "string") return null;
  try {
    // data: URL — decode base64 directly, no HTTP needed
    if (ref.startsWith("data:")) {
      const commaIdx = ref.indexOf(",");
      if (commaIdx === -1) return null;
      return Buffer.from(ref.slice(commaIdx + 1), "base64");
    }
    // Proxy URL like https://.../api/img?url=<b2-path>  → download direct from B2
    const proxyMatch = ref.match(/\/api\/img\?url=([^&]+)/);
    if (proxyMatch) {
      const path = decodeURIComponent(proxyMatch[1]);
      const { buffer } = await backblazeService.downloadImageByPath(path);
      return buffer;
    }
    if (/^https?:\/\//i.test(ref)) {
      const resp = await fetch(ref);
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer());
    }
    // Plain B2 path
    const cleanPath = ref.replace(/^\/+/, "");
    const { buffer } = await backblazeService.downloadImageByPath(cleanPath);
    return buffer;
  } catch (err) {
    console.warn(`[wow-ads] fetchAssetBuffer failed for ${ref.substring(0, 80)}:`, err.message);
    return null;
  }
}

/**
 * Squareize a Gemini-generated image to AD_SIZE×AD_SIZE.
 *
 * Strategy:
 *   1. Within ±2% of square → simple resize-fill (negligible stretch).
 *   2. Anything else → resize-fit with blurred-extended background. The
 *      Gemini image fits ENTIRELY inside the canvas (`fit: "inside"`),
 *      preserving every pixel of text/composition. A copy of itself,
 *      enlarged and blurred, fills the surrounding canvas so the result
 *      still reads as full-bleed.
 *
 * Why no more center-crop:
 *   The previous implementation did `fit: "cover"` for ratios between
 *   0.60 and 1.67, which CHOPS OFF the top, bottom, or sides — exactly
 *   where Gemini often parks the headline (we kept seeing "שע..." with
 *   the first character clipped). Letting Gemini decide where to place
 *   text and then cropping our way to a square was incompatible. The
 *   right fix is to preserve the image whole and accept a soft-blurred
 *   border, which is far less destructive than a 10-15% edge crop.
 */
async function squareizePreservingText(rawBuffer) {
  const meta = await sharp(rawBuffer).metadata();
  const w = meta.width  || AD_SIZE;
  const h = meta.height || AD_SIZE;
  const ratio = w / h;

  /* Already square (within ±2%) — straight fill. */
  if (ratio > 0.98 && ratio < 1.02) {
    return sharp(rawBuffer).resize(AD_SIZE, AD_SIZE, { fit: "fill" }).png().toBuffer();
  }

  /* Off-square — never crop. Fit the whole image inside the canvas
     and synthesize a blurred-enlarged background so the edges still
     feel cinematic instead of dead-white. */
  const background = await sharp(rawBuffer)
    .resize(AD_SIZE, AD_SIZE, { fit: "cover", position: "center" })
    .blur(48)
    .modulate({ brightness: 0.9 })
    .toBuffer();
  const foreground = await sharp(rawBuffer)
    .resize(AD_SIZE, AD_SIZE, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  return sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .png()
    .toBuffer();
}

/**
 * Stamp the original brand logo onto the top-right corner of an ad image,
 * inside a soft white rounded-rect "card" so the logo is always visible
 * regardless of the underlying ad background (sky, dark scenes, etc).
 *
 * Why deterministic compositing instead of trusting Gemini's prompt:
 *   - Gemini sometimes places the logo elsewhere, recolors it, distorts
 *     proportions, or skips it on dense compositions. For paid creative
 *     deliverables that's unacceptable. sharp guarantees pixel-exact
 *     placement of the original logo file.
 *
 * Layout: logo width = 14% of canvas (~150px), with a 12px white pad on
 * each side, 24px corner radius, dropped 32px from top + right edges.
 * Soft fail: if compositing throws, return the unmodified ad.
 */

/**
 * Auto-remove a uniform background color from a logo image.
 *
 * Strategy: sample the 4 corners + 4 edge midpoints. If they're all close
 * to the same color (max channel-sum distance < 30 across all samples),
 * we treat that color as the background and make every pixel within
 * HARD_THRESH of it fully transparent, with a soft ramp out to SOFT_THRESH
 * for clean anti-aliased edges instead of a hard cut.
 *
 * Why: account managers upload logos as JPG or as PNG with a baked-in
 * white/cream rectangle. The compositor stamped them raw onto ads → ugly
 * opaque block over the creative. Now the block dissolves into the ad and
 * only the actual logo glyph remains, so overlap with headline text is
 * also non-destructive (headline shows through the empty pixels).
 *
 * Bails (returns original buffer) when corners aren't uniform — that
 * means the logo's background is already transparent or has visual
 * content reaching the edges, and we'd risk destroying real pixels.
 */
async function removeUniformBackground(logoBuffer) {
  try {
    const { data, info } = await sharp(logoBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels < 4 || width < 4 || height < 4) return logoBuffer;

    const pix = (x, y) => {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    /* Sample 8 perimeter points — corners + edge midpoints. If any of
       these is already transparent (alpha < 250), the logo already has
       an alpha channel and we should leave it alone. */
    const samples = [
      pix(0, 0), pix(width - 1, 0), pix(0, height - 1), pix(width - 1, height - 1),
      pix(Math.floor(width / 2), 0), pix(Math.floor(width / 2), height - 1),
      pix(0, Math.floor(height / 2)), pix(width - 1, Math.floor(height / 2)),
    ];
    if (samples.some(s => s[3] < 250)) {
      console.log("[wow-ads] logo already has alpha — skip background removal");
      return logoBuffer;
    }

    /* Uniformity check: max sum-of-channel distance between any two corners.
       Cream/white backgrounds vary slightly so we allow up to ~30 total. */
    let maxDist = 0;
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const d = Math.abs(samples[i][0] - samples[j][0])
                + Math.abs(samples[i][1] - samples[j][1])
                + Math.abs(samples[i][2] - samples[j][2]);
        if (d > maxDist) maxDist = d;
      }
    }
    /* More tolerant uniformity check — many client logos have subtle
       gradient or noise in their backgrounds (cream → off-cream, light
       pink → light peach). Accept up to 90 channel-sum distance so we
       still strip those backgrounds instead of bailing and shipping
       the logo with a visible box around it. */
    if (maxDist > 90) {
      /* Even when corners aren't uniform (e.g. logo has a subtle drop
         shadow that darkens bottom edges), check whether the MAJORITY
         of perimeter samples are still near-white. If 5+ of 8 read as
         near-white (≥235 across channels), the design intent is clearly
         "white card" and we strip pure white only. This catches logos
         that the uniformity gate would otherwise let through unkeyed. */
      const nearWhiteCount = samples.filter(s => s[0] >= 235 && s[1] >= 235 && s[2] >= 235).length;
      if (nearWhiteCount >= 5) {
        console.log(`[wow-ads] logo non-uniform (maxDist=${maxDist}) but ${nearWhiteCount}/8 samples near-white — stripping pure white`);
        const out = Buffer.from(data);
        const HARD_W = 60;
        const SOFT_W = 160;
        for (let i = 0; i < out.length; i += channels) {
          const dist = Math.abs(out[i] - 255) + Math.abs(out[i + 1] - 255) + Math.abs(out[i + 2] - 255);
          if (dist <= HARD_W) out[i + 3] = 0;
          else if (dist < SOFT_W) out[i + 3] = Math.round(((dist - HARD_W) / (SOFT_W - HARD_W)) * out[i + 3]);
        }
        return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
      }
      console.log(`[wow-ads] logo edges genuinely non-uniform (maxDist=${maxDist}) — keep as-is`);
      return logoBuffer;
    }

    const bgR = Math.round(samples.reduce((a, s) => a + s[0], 0) / samples.length);
    const bgG = Math.round(samples.reduce((a, s) => a + s[1], 0) / samples.length);
    const bgB = Math.round(samples.reduce((a, s) => a + s[2], 0) / samples.length);
    console.log(`[wow-ads] removing logo background rgb(${bgR},${bgG},${bgB}) — maxDist=${maxDist}`);

    /* Aggressive thresholds. Client logos overwhelmingly arrive with
       solid-but-noisy backgrounds (white, cream, pink, light pastel). */
    const HARD = 70;
    const SOFT = 180;
    const out = Buffer.from(data);
    const removeColor = (r, g, b) => {
      for (let i = 0; i < out.length; i += channels) {
        if (out[i + 3] === 0) continue; // already cleared
        const dist = Math.abs(out[i] - r) + Math.abs(out[i + 1] - g) + Math.abs(out[i + 2] - b);
        if (dist <= HARD) {
          out[i + 3] = 0;
        } else if (dist < SOFT) {
          out[i + 3] = Math.round(((dist - HARD) / (SOFT - HARD)) * out[i + 3]);
        }
      }
    };
    removeColor(bgR, bgG, bgB);

    /* ── PASS 2: inset-ring detection ──────────────────────────────────
       The Yuval-K-Beauty style logo: WHITE canvas corners (stripped by
       pass 1) + a CREAM/PASTEL rounded "card" with the icon+text inside.
       After pass 1 the corners are gone but the card stays as a visible
       rectangle. Sample 8 points at 8% inset from each edge. If they're
       still opaque AND uniform AND DIFFERENT from the center of the
       image — that's the card surface, remove it too.

       Safety gate: compare the inset color to a 30×30px center patch.
       If they're close (distance ≤ 80), the "card" is actually the
       logo's main fill color and we'd destroy real content — skip. */
    const ix = Math.max(1, Math.floor(width  * 0.08));
    const iy = Math.max(1, Math.floor(height * 0.08));
    const pixOut = (x, y) => {
      const i = (y * width + x) * channels;
      return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    };
    const insetSamples = [
      pixOut(ix, iy), pixOut(width - 1 - ix, iy),
      pixOut(ix, height - 1 - iy), pixOut(width - 1 - ix, height - 1 - iy),
      pixOut(Math.floor(width / 2), iy), pixOut(Math.floor(width / 2), height - 1 - iy),
      pixOut(ix, Math.floor(height / 2)), pixOut(width - 1 - ix, Math.floor(height / 2)),
    ];
    const insetOpaque = insetSamples.filter(s => s[3] > 200);
    if (insetOpaque.length >= 6) {
      let maxDist2 = 0;
      for (let i = 0; i < insetOpaque.length; i++) {
        for (let j = i + 1; j < insetOpaque.length; j++) {
          const d = Math.abs(insetOpaque[i][0] - insetOpaque[j][0])
                  + Math.abs(insetOpaque[i][1] - insetOpaque[j][1])
                  + Math.abs(insetOpaque[i][2] - insetOpaque[j][2]);
          if (d > maxDist2) maxDist2 = d;
        }
      }
      if (maxDist2 < 60) {
        const ringR = Math.round(insetOpaque.reduce((a, s) => a + s[0], 0) / insetOpaque.length);
        const ringG = Math.round(insetOpaque.reduce((a, s) => a + s[1], 0) / insetOpaque.length);
        const ringB = Math.round(insetOpaque.reduce((a, s) => a + s[2], 0) / insetOpaque.length);

        const cx = Math.floor(width / 2);
        const cy = Math.floor(height / 2);
        const centerSamples = [];
        for (let dy = -10; dy <= 10; dy += 5) {
          for (let dx = -10; dx <= 10; dx += 5) {
            const sx = Math.max(0, Math.min(width  - 1, cx + dx));
            const sy = Math.max(0, Math.min(height - 1, cy + dy));
            centerSamples.push(pixOut(sx, sy));
          }
        }
        const centerR = Math.round(centerSamples.reduce((a, s) => a + s[0], 0) / centerSamples.length);
        const centerG = Math.round(centerSamples.reduce((a, s) => a + s[1], 0) / centerSamples.length);
        const centerB = Math.round(centerSamples.reduce((a, s) => a + s[2], 0) / centerSamples.length);
        const centerDist = Math.abs(centerR - ringR) + Math.abs(centerG - ringG) + Math.abs(centerB - ringB);

        /* Override safety gate when ring is near-white. Customers
           overwhelmingly upload logos on white cards/shadows, and the
           safety gate trips on those because the gaps between Hebrew
           letters + bright icon backgrounds make the center patch
           also read as near-white. White is never legitimate logo
           content fill — removeColor's ±70 tolerance protects any dark
           text / colored icon strokes. */
        const ringIsNearWhite = ringR > 235 && ringG > 235 && ringB > 235;
        if (centerDist > 80 || ringIsNearWhite) {
          const why = ringIsNearWhite
            ? `near-white override (centerDist=${centerDist})`
            : `centerDist=${centerDist}`;
          console.log(`[wow-ads] pass 2: removing inner card rgb(${ringR},${ringG},${ringB}) — ${why}`);
          removeColor(ringR, ringG, ringB);
        } else {
          console.log(`[wow-ads] pass 2: ring matches logo center (centerDist=${centerDist}) — skip to protect content`);
        }
      } else {
        console.log(`[wow-ads] pass 2: inset ring not uniform (maxDist=${maxDist2}) — no second pass needed`);
      }
    }

    return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
  } catch (err) {
    console.warn("[wow-ads] removeUniformBackground failed, using original:", err.message);
    return logoBuffer;
  }
}

async function compositeLogoTopRight(adBuffer, logoBuffer) {
  if (!logoBuffer) {
    console.warn("[wow-ads] ⚠️ compositeLogoTopRight: logoBuffer is null — ad ships WITHOUT logo");
    return adBuffer;
  }
  try {
    console.log(`[wow-ads] compositing logo (${Math.round(logoBuffer.length / 1024)}kb) onto top-right corner`);
    const edgePad     = 28;                              // distance from canvas edge
    const targetLogoW = Math.round(AD_SIZE * 0.12);      // ~130px on 1080
    // Strip the logo's solid background (white/cream/etc) before resizing so
    // the chroma-key reads the original full-resolution pixels — better edge
    // detection than chroma-keying a downscaled blurry version.
    const keyed = await removeUniformBackground(logoBuffer);
    const sized = await sharp(keyed)
      .resize(targetLogoW, targetLogoW, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta  = await sharp(sized).metadata();
    const logoW = meta.width  || targetLogoW;
    const logoH = meta.height || targetLogoW;

    const logoLeft = AD_SIZE - logoW - edgePad;
    const logoTop  = edgePad;                            // top-right corner

    /* Logo placed directly on the ad — no white card, no visible
       background. Client uploads with whatever background and our
       removeUniformBackground() strips it before this step. */
    return sharp(adBuffer)
      .composite([
        { input: sized, top: logoTop, left: logoLeft },
      ])
      .png()
      .toBuffer();
  } catch (err) {
    console.error("[wow-ads] ❌ logo composite FAILED — ad ships without logo:", err.message);
    return adBuffer;
  }
}

function detectMime(buf) {
  if (!buf || buf.length < 4) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[4] === 0x57) return "image/webp";
  return "image/jpeg";
}

/**
 * Single OpenAI image-generation call. Uses the OpenAI SDK's default
 * timeout (10 minutes). The 75s hard cap added on 2026-06-18 was
 * reverted same-day — it broke the regular leads flow by killing
 * slow-but-eventually-successful calls. Cascade in generateAdImageBuffer
 * (3 attempts × 2 models) is the retry safety net.
 */
async function callImageModel({ model, prompt, refs }) {
  const params = {
    model,
    prompt,
    quality: OPENAI_IMAGE_QUALITY,
    size: OPENAI_IMAGE_SIZE,
  };
  const resp = refs.length > 0
    ? await openai.images.edit({ ...params, image: refs })
    : await openai.images.generate(params);
  const b64 = resp?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${model} returned no image data`);
  return Buffer.from(b64, "base64");
}

/**
 * Generate a single 1080×1080 ad image.
 *
 * Model cascade (OpenAI only):
 *   - Primary:  OPENAI_IMAGE_MODEL          (default: gpt-image-2)
 *   - Fallback: OPENAI_FALLBACK_IMAGE_MODEL (default: gpt-image-1)
 *
 * Each model gets up to 3 attempts with backoff before falling through.
 * Logo + client photos are passed as references via openai.images.edit so
 * the model can integrate them naturally into the scene.
 */
async function generateAdImageBuffer(prompt, logoBuffer = null, imageBuffers = []) {
  /* Build the OpenAI File array — client photos first, logo last so the
     prompt's "the last reference image is the brand logo" hint binds. */
  const refs = [];
  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    refs.push(await toFile(buf, `ref-${i + 1}.png`, { type: detectMime(buf) }));
  }
  if (logoBuffer) {
    refs.push(await toFile(logoBuffer, "logo.png", { type: detectMime(logoBuffer) }));
  }

  /* Surface prompt size + a head/tail preview so we can diagnose hangs
     in production — when gpt-image-2 EDIT silently times out, having
     the exact prompt that was sent makes the difference between
     guessing and knowing. Kept terse to avoid filling the log buffer. */
  const promptLen = prompt?.length ?? 0;
  const promptHead = (prompt || "").slice(0, 240).replace(/\s+/g, " ");
  const promptTail = promptLen > 480 ? (prompt || "").slice(-200).replace(/\s+/g, " ") : "";
  console.log(`[wow-ads] prompt size=${promptLen} head="${promptHead}"${promptTail ? ` tail="${promptTail}"` : ""}`);

  const mode = refs.length > 0 ? "EDIT" : "GENERATE";
  const refInfo = refs.length > 0
    ? `${imageBuffers.length} client photo(s)${logoBuffer ? " + logo" : ""}`
    : "text-only";

  /* 3 attempts per model with backoff — restored on 2026-06-18 after
     the single-attempt variant introduced earlier the same day broke
     the regular quota=10 leads flow. Transient OpenAI hiccups (slow
     responses, 5xx) recover on retry; the OpenAI SDK's default 10-min
     per-call timeout catches hung calls. */
  async function tryModel(model) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[wow-ads] ${model} ${mode} (${refInfo}) — attempt ${attempt}`);
        const raw = await callImageModel({ model, prompt, refs });
        return await squareizePreservingText(raw);
      } catch (err) {
        const wait = [800, 2400, 5200][attempt - 1] || 1500;
        console.warn(`[wow-ads] ${model} attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 3) throw err;
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  /* PRIMARY: Gemini gemini-3-pro-image-preview (client photos + logo as refs).
     3 attempts with backoff, then fall back to the OpenAI gpt-image-2 cascade
     if Gemini errors or has an outage. */
  const geminiRefs = [...imageBuffers, ...(logoBuffer ? [logoBuffer] : [])];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[wow-ads] gemini ${GEMINI_IMG_MODEL} ${mode} (${refInfo}) — attempt ${attempt}`);
      const raw = await geminiGenerateImage(prompt, geminiRefs);
      const buffer = await squareizePreservingText(raw);
      return { buffer, modelUsed: GEMINI_IMG_MODEL, fallbackUsed: false };
    } catch (err) {
      console.warn(`[wow-ads] gemini attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 3) break;
      await new Promise(r => setTimeout(r, [800, 2400, 5200][attempt - 1] || 1500));
    }
  }
  console.warn(`[wow-ads] Gemini exhausted — falling back to OpenAI ${OPENAI_IMAGE_MODEL}`);
  try {
    const buffer = await tryModel(OPENAI_IMAGE_MODEL);
    return { buffer, modelUsed: OPENAI_IMAGE_MODEL, fallbackUsed: true };
  } catch (primaryErr) {
    console.warn(`[wow-ads] OpenAI ${OPENAI_IMAGE_MODEL} exhausted — falling back to ${OPENAI_FALLBACK_IMAGE_MODEL}`);
    const buffer = await tryModel(OPENAI_FALLBACK_IMAGE_MODEL);
    return { buffer, modelUsed: OPENAI_FALLBACK_IMAGE_MODEL, fallbackUsed: true };
  }
}

/* ────────────────────────────────────────────────────────────────────
   PIPELINE
   ──────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────
   CAROUSEL — generate N separate slides for ad.type === "carousel"
   ────────────────────────────────────────────────────────────────────
   A carousel ad on Facebook/Instagram is multiple images the user can
   swipe through. Gemini, given a single prompt with "carousel" as a hint,
   tends to draw all 4 frames as a 2×2 grid in ONE image — which isn't a
   real carousel, just a collage. To make a true carousel we generate
   N separate full-bleed scenes that share a theme + brand colors. */

const CAROUSEL_SLIDE_COUNT = 4;

const SLIDE_DIRECTIONS = [
  "Slide 1 of 4 — HERO scene establishing the offer with the headline. Wide, inviting, sets the tone.",
  "Slide 2 of 4 — FEATURE scene showing the product/service in action or its main benefit. Different angle from slide 1.",
  "Slide 3 of 4 — SOCIAL PROOF or RESULT scene (happy customer, before/after, milestone, testimonial framing). Different composition again.",
  "Slide 4 of 4 — CTA scene with the call-to-action button as the focal point, urgency cue, ready-to-click feel.",
];

async function generateCarouselSlides({ ad, ctx, logoBuffer, imageBuffers, sessionId, phone }) {
  const slides = [];
  /* Slide-level creative direction: reuse the carousel ad's direction if
     one was generated for it earlier in the pipeline, otherwise let the
     prompt run direction-less. The slide context note still varies per
     slide (HERO / FEATURE / SOCIAL PROOF / CTA) so frames stay distinct.
     Force heroOnly=false for carousels — the renderer's 5 panel shapes
     don't map cleanly to the 4 slide narrative roles (HERO/FEATURE/
     SOCIAL PROOF/CTA), so we keep carousels on the model-paints-everything
     path until we design slide-specific panel layouts. */
  const direction = ad.creativeDirection || null;
  const slideCtx = { ...ctx, heroOnly: false };
  for (let s = 0; s < CAROUSEL_SLIDE_COUNT; s++) {
    const slideAd = {
      ...ad,
      type: "regular",
      _slideContext: SLIDE_DIRECTIONS[s] || `Slide ${s + 1} of ${CAROUSEL_SLIDE_COUNT}.`,
    };
    let slidePrompt;
    try {
      slidePrompt = await generateNanoPrompt(slideAd, slideCtx, direction);
    } catch (err) {
      slides.push({ id: s + 1, error: `prompt failed: ${err.message}` });
      continue;
    }
    try {
      const { buffer: buf, modelUsed, fallbackUsed } = await generateAdImageBuffer(
        slidePrompt, logoBuffer, imageBuffers
      );
      const fullPath = `wow-ads/${phone}/${sessionId}/ad_${ad.id}_slide_${s + 1}.png`;
      await uploadImage(fullPath, buf, "image/png");
      slides.push({
        id: s + 1,
        imageUrl: `/api/img?url=${encodeURIComponent(fullPath)}`,
        nanoPrompt: slidePrompt,
        modelUsed,
        fallbackUsed,
      });
    } catch (err) {
      slides.push({ id: s + 1, error: err.message || "image generation failed", nanoPrompt: slidePrompt });
    }
    /* Same per-image cool-down as the rest of the pipeline. */
    await new Promise(r => setTimeout(r, 800));
  }
  return slides;
}

async function runAdsPipeline(sessionId, phone, brief, quota = 10, slotKey = null, meta = null) {
  /* Clamp the quota to a sane range — anything outside [1, 30] is almost
     certainly a mistake (negative = no work; >30 = enormous OpenAI cost
     and likely a quota field misread). 10 is the baseline for legacy
     packages without an explicit count. */
  const targetCount = Math.min(Math.max(parseInt(quota, 10) || 10, 1), 30);

  /* Idempotent upsert: state fields go through $setOnInsert so a re-entry
     after a server restart doesn't clobber in-flight progress. brief and
     updatedAt always refresh. This is what makes runAdsPipeline safe to
     call as a "resume" — Mongo keeps the already-generated ads/prompts
     and the pipeline below skips work it can detect as already done. */
  const onInsert = {
    sessionId, phone,
    slotKey: slotKey || null,
    status: "generating_texts",
    /* packageId — `pkg_<kind>_<purchasedAt>` from the user's activePackage
       at the moment generation started. The "packages history" view on
       the products screen groups sessions by this so a client who bought
       3 packages gets 3 separate cards, each with its own products. */
    packageId: brief?.packageId || null,
    generatedAds: [],
    totalAds: targetCount,
    completedCount: 0,
    productStatus:          "sent_for_creation",
    productStatusUpdatedAt: new Date(),
    createdAt: new Date(),
  };

  /* Special-campaign metadata MUST be written in THIS same atomic upsert,
     not by a separate parallel write. Previously the controller fired a
     second `$setOnInsert: { campaignName, campaignOverrides }` upsert in
     parallel; if it inserted the doc first, the $setOnInsert above became
     a no-op and status/slotKey/phone were never stored. A deploy mid
     text-generation then left the session with no status, so the resume
     scanner (which queries by status) skipped it and the special campaign
     never resumed. Folding the metadata here removes the race entirely. */
  if (meta) {
    if (meta.campaignName) onInsert.campaignName = meta.campaignName;
    onInsert.campaignOverrides = meta.campaignOverrides || null;
    onInsert.campaignCreatedAt = new Date();
  }

  await sessionsCol().updateOne(
    { sessionId },
    {
      $setOnInsert: onInsert,
      $set: { brief, updatedAt: new Date() },
    },
    { upsert: true }
  );

  /* Re-read the session AFTER the upsert so we can detect what's already
     done from a prior partial run. existingAds may be empty (fresh session)
     OR fully populated with prompts and imageUrls (resume after restart). */
  const existing = await sessionsCol().findOne({ sessionId });
  const existingAds = Array.isArray(existing?.generatedAds) ? existing.generatedAds : [];

  try {
    /* Step 1 — generate N ad texts. Resume-safe: if Mongo already has the
       full ads array (from a prior run), reuse it instead of regenerating.
       Saves an OpenAI call + ensures the same texts after restart. */
    let texts, servicesAndDeals;
    if (existingAds.length >= targetCount) {
      console.log(`[wow-ads] ${sessionId} resume — reusing ${existingAds.length} existing ad texts`);
      texts = existingAds;
      servicesAndDeals = brief.services || "";
    } else {
      ({ ads: texts, servicesAndDeals } = await generateAdsTexts(brief, targetCount));
    }
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { generatedAds: texts, status: "generating_prompts", updatedAt: new Date() } }
    );

    /* Pre-load brand assets so we can both inform the prompt step and feed
       the actual image bytes to Gemini. Without this Gemini can't really
       use the logo — text-only "include logo from URL X" hints get ignored. */
    const logoBuffer = brief.logo ? await fetchAssetBuffer(brief.logo) : null;
    const imageBuffers = [];
    for (const url of (brief.images || []).slice(0, 5)) {
      const buf = await fetchAssetBuffer(url);
      if (buf) imageBuffers.push(buf);
    }
    console.log(`[wow-ads] ${sessionId}: assets loaded — logo=${logoBuffer ? "yes" : "no"}, scenes=${imageBuffers.length}`);

    const analysis = await analyzeBusinessForAds(brief, logoBuffer, imageBuffers);
    console.log(`[wow-ads] ${sessionId}: business analysis — nanoTips=${analysis.nanoPromptTips.length}, geminiTips=${analysis.geminiTips.length}`);

    const ctx = {
      designStyle:    brief.designStyle,
      preferredColors: brief.preferredColors,
      language:       brief.language || "he",
      hasLogo:        logoBuffer !== null,
      hasScene:       imageBuffers.length > 0,
      imageCount:     imageBuffers.length,
      servicesAndDeals,
      nanoPromptTips: analysis.nanoPromptTips,
      geminiTips:     analysis.geminiTips,
      /* Contact-info opt-ins from the characterization form. When
         either flag is true, buildNanoPromptPrompt renders an explicit
         instruction telling the image model to surface the exact
         phone/address string on the creative. Default off — most
         clients don't want phone/address on every ad. */
      includePhoneInAds:   brief.includePhoneInAds   === true,
      includeAddressInAds: brief.includeAddressInAds === true,
      businessPhone:       brief.businessPhone || "",
      address:             brief.address       || "",
      /* When the renderer is enabled, the nano-prompt is asked for a
         hero-only photo (no text/logo/CTA in the model output). When
         disabled, the model paints the full ad as before. */
      heroOnly:       USE_RENDERER,
    };

    /* Step 2a — creative directions in parallel — one per ad.
       Resume-safe: ads that already have creativeDirection from a prior
       run keep theirs; we only generate for the missing ones. */
    const directions = {};
    for (const ad of texts) {
      if (ad.creativeDirection) directions[ad.id] = ad.creativeDirection;
    }
    const adsNeedingDirections = texts.filter(ad => !directions[ad.id]);
    if (adsNeedingDirections.length > 0) {
      console.log(`[wow-ads] ${sessionId} generating ${adsNeedingDirections.length}/${texts.length} missing creative directions`);
      const directionResults = await Promise.allSettled(
        adsNeedingDirections.map((ad) => {
          const idx = texts.findIndex(t => t.id === ad.id);
          return generateCreativeDirection({
            brief, ad, index: idx, totalCount: texts.length,
          }).then(d => ({ adId: ad.id, direction: d }));
        })
      );
      for (const r of directionResults) {
        if (r.status === "fulfilled" && r.value.direction) {
          directions[r.value.adId] = r.value.direction;
        }
      }
    } else {
      console.log(`[wow-ads] ${sessionId} resume — all ${texts.length} creative directions already present`);
    }
    const dirCount = Object.keys(directions).length;
    console.log(`[wow-ads] ${sessionId}: creative directions — ${dirCount}/${texts.length} ready${dirCount < texts.length ? " (others fall back to plain prompt)" : ""}`);

    /* Step 2b — nano prompts in parallel. Resume-safe: ads that already
       have a nanoPrompt keep it; we only generate for the missing ones. */
    const prompts = {};
    for (const ad of texts) {
      if (ad.nanoPrompt) prompts[ad.id] = ad.nanoPrompt;
    }
    const adsNeedingPrompts = texts.filter(ad => !prompts[ad.id]);
    const promptErrors = [];
    if (adsNeedingPrompts.length > 0) {
      console.log(`[wow-ads] ${sessionId} generating ${adsNeedingPrompts.length}/${texts.length} missing nano prompts`);
      const promptResults = await Promise.allSettled(
        adsNeedingPrompts.map(ad => generateNanoPrompt(ad, ctx, directions[ad.id] || null)
          .then(p => ({ adId: ad.id, prompt: p })))
      );
      for (let i = 0; i < promptResults.length; i++) {
        const r = promptResults[i];
        if (r.status === "fulfilled") {
          prompts[r.value.adId] = r.value.prompt;
        } else {
          const adId = adsNeedingPrompts[i]?.id ?? i;
          const reason = r.reason?.message || String(r.reason);
          promptErrors.push(`ad #${adId}: ${reason}`);
        }
      }
    } else {
      console.log(`[wow-ads] ${sessionId} resume — all ${texts.length} nano prompts already present`);
    }
    if (promptErrors.length) {
      console.error(`[wow-ads] ${promptErrors.length}/${texts.length} nano prompts failed for ${sessionId}:`, promptErrors);
    }
    if (Object.keys(prompts).length === 0) {
      // Surface the underlying OpenAI error to the user instead of the silent "no nano prompt"
      const firstReason = promptResults.find(r => r.status === "rejected")?.reason?.message || "OpenAI nano-prompt step failed";
      throw new Error(`לא הצלחתי לייצר promptים לתמונות: ${firstReason}`);
    }

    const adsWithPrompts = texts.map(ad => ({
      ...ad,
      nanoPrompt:        prompts[ad.id] || null,
      creativeDirection: directions[ad.id] || null,
    }));
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { generatedAds: adsWithPrompts, status: "generating_images", updatedAt: new Date() } }
    );

    /* Step 3 — images sequentially with delay.
       All client reference photos are passed to every ad so the model
       has the full visual context regardless of ad index.
       Resume-safe: ads that already have imageUrl are skipped. After a
       server restart mid-session, the loop picks up exactly where it left
       off (e.g. ad 9 + 10 were missing → only those two re-run). */
    for (let i = 0; i < adsWithPrompts.length; i++) {
      const ad = adsWithPrompts[i];
      if (ad.imageUrl) {
        console.log(`[wow-ads] ${sessionId} skip ad ${ad.id} — imageUrl already present (resume)`);
        continue;
      }
      if (!ad.nanoPrompt) {
        ad.error = "no nano prompt";
      } else if (ad.type === "carousel") {
        /* Carousel ads → 4 separate full-bleed slides instead of one image. */
        try {
          const slides = await generateCarouselSlides({
            ad, ctx, logoBuffer, imageBuffers, sessionId, phone,
          });
          ad.slides = slides;
          /* First successful slide doubles as imageUrl so legacy UI paths
             that read ad.imageUrl still show a thumbnail. */
          const firstOk = slides.find(s => s.imageUrl);
          if (firstOk) ad.imageUrl = firstOk.imageUrl;
          else         ad.error    = "all carousel slides failed";
        } catch (err) {
          ad.error = err.message || "carousel generation failed";
        }
      } else {
        try {
          /* In renderer mode the logo IS passed to the image model — this
             enables organic integration on workers' uniforms, shop signs,
             equipment, etc. (which actually elevates the ad). What we
             ban via the prompt is the model painting a DESIGNED logo card
             with Hebrew transliteration into the negative space — the
             SVG renderer owns that layer. The hero-only prompt's IRON
             LAW #2 is responsible for keeping the model's logo use to
             "natural in-scene only". */
          /* First attempt — straight from the nano prompt. */
          let { buffer: heroBuf, modelUsed, fallbackUsed } = await generateAdImageBuffer(
            ad.nanoPrompt, logoBuffer, imageBuffers
          );
          /* If the renderer is enabled, compose the deterministic brand
             panel on top of the hero. Otherwise the model already painted
             the finished ad and we ship the buffer as-is.
             buildPalette is called per-ad so each direction can have its
             own color story (some ads in a batch could pivot palette via
             userChangeRequest or visualType variation). */
          let buf = heroBuf;
          let renderedWithLayout = false;
          let renderError = null;
          if (USE_RENDERER) {
            try {
              const palette = await buildPalette({
                preferredColors: brief.preferredColors,
                logoBuffer,
                visualType: ad.creativeDirection?.visualType || "clean",
              });
              const result = await renderAdLayout({
                generatedImageBuffer: heroBuf,
                logoBuffer,
                ad,
                direction: ad.creativeDirection || null,
                palette,
              });
              buf = result.buffer;
              renderedWithLayout = true;
              ad.panelPalette = palette;
              ad.rendererVersion = result.rendererVersion;
              /* Persist the raw hero image too — debugging aid. If a final
                 ad looks wrong, the team can compare hero vs final to
                 isolate "was it the model or the renderer?". Same B2
                 bucket, distinct filename so the proxy URL is stable. */
              try {
                const heroPath = `wow-ads/${phone}/${sessionId}/ad_${ad.id}_hero.png`;
                await uploadImage(heroPath, heroBuf, "image/png");
                ad.rawHeroImageUrl = `/api/img?url=${encodeURIComponent(heroPath)}`;
              } catch (heroUploadErr) {
                console.warn(`[wow-ads] ad ${ad.id} raw hero upload failed: ${heroUploadErr.message}`);
              }
            } catch (rendErr) {
              renderError = rendErr.message || "renderer failed";
              console.warn(`[wow-ads] ad ${ad.id} renderer failed (${renderError}) — shipping raw hero`);
            }
          }
          ad.renderedWithLayout = renderedWithLayout;
          if (renderError) ad.renderError = renderError;
          /* Vision review — pass/fail + retry instruction.
             reviewGeneratedAd fails soft (returns null on error) so a
             flaky review call never blocks shipping the image. */
          const review = await reviewGeneratedAd({ imageBuffer: buf, ad, brief });
          /* Score history — both attempts captured for telemetry even if
             the retry loses. Lets the admin KPIs distinguish "would have
             retried" from "did retry and accepted". */
          ad.initialQaScore = review?.score ?? null;
          ad.finalQaScore   = review?.score ?? null;
          ad.finalImageAttempt = 1;
          ad.qaScore   = review?.score ?? null;
          ad.qaIssues  = review?.issues ?? [];
          ad.qaApproved = review?.approve === true;
          ad.qaVersion  = review?.reviewVersion ?? null;
          ad.modelUsed    = modelUsed;
          ad.fallbackUsed = fallbackUsed;
          if (review && !review.approve && review.score < REVIEW_PASS_SCORE && review.retryInstruction) {
            console.log(`[wow-ads] ad ${ad.id} scored ${review.score} — retrying once with reviewer fix`);
            const retryPrompt = `${ad.nanoPrompt}

CRITICAL RETRY FIX — the previous attempt was rejected by review. Apply these fixes:
${review.retryInstruction}

Previous issues to NOT repeat:
${(review.issues || []).map(i => `- ${i}`).join("\n")}`;
            try {
              /* Single-shot retry — no 3-attempt cascade, no fallback
                 to gpt-image-1. The retry is a "give the QA-rejected
                 ad one more chance" path; if that one chance times
                 out or errors we keep the first attempt rather than
                 burn 12 minutes exhausting both models. */
              const refsForRetry = [];
              for (let i = 0; i < imageBuffers.length; i++) {
                refsForRetry.push(await toFile(imageBuffers[i], `ref-${i + 1}.png`, { type: detectMime(imageBuffers[i]) }));
              }
              if (logoBuffer) {
                refsForRetry.push(await toFile(logoBuffer, "logo.png", { type: detectMime(logoBuffer) }));
              }
              console.log(`[wow-ads] ad ${ad.id} retry — single-shot ${OPENAI_IMAGE_MODEL}`);
              const retryRaw = await callImageModel({ model: OPENAI_IMAGE_MODEL, prompt: retryPrompt, refs: refsForRetry });
              const retryHero = await squareizePreservingText(retryRaw);
              const retryModel = OPENAI_IMAGE_MODEL;
              const retryFallback = false;
              /* Apply the same renderer overlay to the retry hero so we're
                 comparing apples to apples in the second review. */
              let retryBuf = retryHero;
              if (USE_RENDERER && renderedWithLayout) {
                try {
                  const retryPalette = ad.panelPalette || await buildPalette({
                    preferredColors: brief.preferredColors,
                    logoBuffer,
                    visualType: ad.creativeDirection?.visualType || "clean",
                  });
                  const r = await renderAdLayout({
                    generatedImageBuffer: retryHero,
                    logoBuffer,
                    ad,
                    direction: ad.creativeDirection || null,
                    palette: retryPalette,
                  });
                  retryBuf = r.buffer;
                } catch (rerrErr) {
                  console.warn(`[wow-ads] ad ${ad.id} retry renderer failed — comparing raw hero`);
                  retryBuf = retryHero;
                }
              }
              const retryReview = await reviewGeneratedAd({ imageBuffer: retryBuf, ad, brief });
              /* Take the retry only if it actually scored higher — otherwise
                 keep the first attempt. Prevents a worse second image from
                 overwriting a marginally-okay first one. */
              if (retryReview && (retryReview.score ?? 0) > (review.score ?? 0)) {
                buf = retryBuf;
                ad.qaScore    = retryReview.score;
                ad.qaIssues   = retryReview.issues;
                ad.qaApproved = retryReview.approve === true;
                ad.qaRetried  = true;
                ad.finalQaScore  = retryReview.score;
                ad.finalImageAttempt = 2;
                ad.modelUsed    = retryModel;
                ad.fallbackUsed = retryFallback;
              } else {
                ad.qaRetriedRejected = true;
              }
            } catch (retryErr) {
              console.warn(`[wow-ads] ad ${ad.id} retry failed: ${retryErr.message} — keeping first attempt`);
            }
          }
          const fullPath = `wow-ads/${phone}/${sessionId}/ad_${ad.id}.png`;
          await uploadImage(fullPath, buf, "image/png");
          ad.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
        } catch (err) {
          ad.error = err.message || "image generation failed";
        }
      }
      await sessionsCol().updateOne(
        { sessionId },
        {
          $set: {
            generatedAds: adsWithPrompts,
            completedCount: adsWithPrompts.filter(a => a.imageUrl).length,
            updatedAt: new Date(),
          },
        }
      );
      await new Promise(r => setTimeout(r, 1000));
    }

    /* Step 4 — auto-generate promotion-ready post bodies for every ad
       that ended up with an image. The manager used to have to click
       "צור תיאור פרסומי" per ad — now it's there from the start.
       Run in parallel via Promise.allSettled so a single OpenAI hiccup
       on one ad doesn't block the others; per-ad failure just leaves
       that ad without a promo (manager can hit "צור מחדש"). */
    const promoTargets = adsWithPrompts.filter(a => a.imageUrl);
    if (promoTargets.length > 0) {
      console.log(`[wow-ads] ${sessionId}: auto-generating ${promoTargets.length} promotion descriptions`);
      const promoResults = await Promise.allSettled(
        promoTargets.map(a => generatePromotionDescription(sessionId, a.id, brief)),
      );
      const promoFailed = promoResults.filter(r => r.status === "rejected").length;
      if (promoFailed > 0) {
        console.warn(`[wow-ads] ${sessionId}: ${promoFailed}/${promoTargets.length} promo generations failed`);
      }
    }

    await sessionsCol().updateOne(
      { sessionId },
      { $set: {
          status: "done",
          productStatus:          "pending_manager_approval",
          productStatusUpdatedAt: new Date(),
          updatedAt:              new Date(),
        }
      }
    );
  } catch (err) {
    console.error(`[wow-ads] pipeline failed for ${sessionId}:`, err);
    // OpenAI out-of-credit (429) is NOT a real failure — park the session in
    // "waiting_credits" (all client data preserved on the session) so the credit
    // watchdog resumes it automatically once credits are topped up, instead of
    // burning the 3-strike retry budget and giving up.
    const quotaBlocked = isQuotaError(err);
    await sessionsCol().updateOne(
      { sessionId },
      { $set: {
          status: quotaBlocked ? "waiting_credits" : "error",
          error: err.message || "unknown error",
          updatedAt: new Date(),
      } }
    );
    if (quotaBlocked) console.log(`[wow-ads:credit] ${sessionId} (${phone}) parked → waiting_credits (OpenAI quota)`);
  }
}

async function regenerateSingleAd(sessionId, adId, userChangeRequest = null) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error("ad not found");

  /* Re-read the client's current logo URL from business_profiles instead
     of using the stale snapshot in sess.brief.logo. The session was frozen
     at creation time, but the manager may have generated a new logo since
     (e.g. via the LogoGenerator) — the old URL would point to a logo that
     was replaced. Falls back to the snapshot if the live read fails. */
  let liveLogoUrl = sess.brief?.logo || null;
  try {
    const bp = await getDB().collection("business_profiles")
      .findOne({ phone: sess.phone }, { projection: { logoUrl: 1 } });
    if (bp?.logoUrl && !String(bp.logoUrl).startsWith("data:")) {
      liveLogoUrl = bp.logoUrl;
    }
  } catch (err) {
    console.warn(`[wow-ads] regenerate: could not refresh logo for ${sess.phone}:`, err.message);
  }
  const logoBuffer = liveLogoUrl ? await fetchAssetBuffer(liveLogoUrl) : null;
  if (liveLogoUrl && !logoBuffer) {
    console.warn(`[wow-ads] regenerate: logo fetch returned null for ${sess.phone} url=${liveLogoUrl}`);
  }
  const briefImages = Array.isArray(sess.brief?.images) ? sess.brief.images.slice(0, 5) : [];
  const imageBuffers = [];
  for (const url of briefImages) {
    const buf = await fetchAssetBuffer(url);
    if (buf) imageBuffers.push(buf);
  }

  // Build a fresh nano prompt when the user supplied a change request OR when
  // none exists yet. Otherwise reuse the existing prompt for cheap re-rolls.
  const ctx = {
    designStyle: sess.brief?.designStyle,
    preferredColors: sess.brief?.preferredColors,
    hasLogo: logoBuffer !== null,
    hasScene: imageBuffers.length > 0,
    imageCount: imageBuffers.length,
    servicesAndDeals: sess.brief?.services || "",
    userChangeRequest: userChangeRequest || null,
    heroOnly: USE_RENDERER,
  };
  /* Direction: when the user supplied a change request, regenerate a fresh
     direction so the new prompt can pivot away from whatever the previous
     direction locked in (e.g. user said "less industrial, more luxury").
     Without a change request, reuse the stored direction for consistency. */
  let direction = ad.creativeDirection || null;
  if (userChangeRequest) {
    try {
      direction = await generateCreativeDirection({
        brief: { ...sess.brief, userChangeRequest },
        ad, index: 0, totalCount: 1,
      });
      ad.creativeDirection = direction;
    } catch (err) {
      console.warn(`[wow-ads] regenerate: direction refresh failed, keeping stored direction: ${err.message}`);
    }
  }
  if (userChangeRequest || !ad.nanoPrompt) {
    ad.nanoPrompt = await generateNanoPrompt(ad, ctx, direction);
  }

  // Match the new pipeline rule: each photo is used in exactly one ad
  // (the first N), no rotation — so ad #N gets photo #N if it exists, else null.
  const idx = sess.generatedAds.findIndex(a => Number(a.id) === Number(adId));
  const sceneBuffer = idx >= 0 && idx < imageBuffers.length ? imageBuffers[idx] : null;

  if (ad.type === "carousel") {
    /* Carousel regenerate: rebuild all 4 slides. Same data shape as initial
       generation. The single ad.imageUrl points to slide 1 for legacy UIs. */
    const slides = await generateCarouselSlides({
      ad, ctx, logoBuffer, imageBuffers, sessionId, phone: sess.phone,
    });
    ad.slides = slides;
    const firstOk = slides.find(s => s.imageUrl);
    ad.imageUrl = firstOk?.imageUrl || ad.imageUrl;
  } else {
    /* generateAdImageBuffer expects an ARRAY of image buffers as its 3rd
       arg, not a single buffer. Passing null would crash at
       `imageBuffers.length > 0` with "Cannot read properties of null".
       Wrap the optional single buffer in an array (or an empty one).
       Logo IS passed to hero generation so the model can integrate it
       naturally on uniforms / signs / equipment in the scene — the
       deterministic renderer paints the brand panel logo separately. */
    const scenes = sceneBuffer ? [sceneBuffer] : [];
    const { buffer: heroBuf, modelUsed, fallbackUsed } = await generateAdImageBuffer(
      ad.nanoPrompt, logoBuffer, scenes
    );
    ad.modelUsed    = modelUsed;
    ad.fallbackUsed = fallbackUsed;
    let buf = heroBuf;
    if (USE_RENDERER) {
      try {
        const palette = await buildPalette({
          preferredColors: sess.brief?.preferredColors,
          logoBuffer,
          visualType: ad.creativeDirection?.visualType || "clean",
        });
        const result = await renderAdLayout({
          generatedImageBuffer: heroBuf,
          logoBuffer,
          ad,
          direction: ad.creativeDirection || null,
          palette,
        });
        buf = result.buffer;
        ad.panelPalette = palette;
        ad.rendererVersion = result.rendererVersion;
        ad.renderedWithLayout = true;
        try {
          const heroPath = `wow-ads/${sess.phone}/${sessionId}/ad_${adId}_hero_${Date.now()}.png`;
          await uploadImage(heroPath, heroBuf, "image/png");
          ad.rawHeroImageUrl = `/api/img?url=${encodeURIComponent(heroPath)}`;
        } catch (heroUploadErr) {
          console.warn(`[wow-ads] regenerate ad ${adId} raw hero upload failed: ${heroUploadErr.message}`);
        }
      } catch (rendErr) {
        ad.renderError = rendErr.message || "renderer failed";
        ad.renderedWithLayout = false;
        console.warn(`[wow-ads] regenerate ad ${adId} renderer failed: ${rendErr.message} — shipping raw hero`);
      }
    }
    const fullPath = `wow-ads/${sess.phone}/${sessionId}/ad_${adId}_${Date.now()}.png`;
    await uploadImage(fullPath, buf, "image/png");
    ad.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
  }

  ad.regeneratedAt = new Date().toISOString();
  /* Clear flags set by markAdRegenerating in the kickoff path. */
  delete ad.regenerating;
  delete ad.error;
  if (userChangeRequest) ad.lastUserPrompt = userChangeRequest;

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedAds: sess.generatedAds, updatedAt: new Date() } }
  );

  return ad;
}

/**
 * Heroku has a hard 30s router timeout (H12 → 503). Gemini image generation
 * + B2 round-trips routinely exceed that. The kickoff helpers below let the
 * controller flip an "ad is regenerating" flag on the session and respond
 * 202 immediately, while the actual work runs async — frontend polling
 * already refreshes the session every 3.5s and reflects the result.
 */
async function markAdRegenerating(sessionId, adId) {
  await sessionsCol().updateOne(
    { sessionId, "generatedAds.id": Number(adId) },
    {
      $set: { "generatedAds.$.regenerating": true, updatedAt: new Date() },
      $unset: { "generatedAds.$.error": "" },
    }
  );
}

async function failAdRegenerate(sessionId, adId, errMsg) {
  await sessionsCol().updateOne(
    { sessionId, "generatedAds.id": Number(adId) },
    {
      $set: {
        "generatedAds.$.regenerating": false,
        "generatedAds.$.error": errMsg || "regenerate failed",
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Generate a rich, promotion-ready Hebrew description for a single ad.
 * Uses the existing image text (headline + short description + CTA) as a
 * seed and expands it into a 4-6 line Facebook/Meta post body the manager
 * can copy-paste directly when promoting the ad. Saved as
 * ad.promotionDescription so the original on-image description stays
 * untouched.
 */
function buildPromotionCopyPrompt({ ad, businessName, businessField, services, promotion, targetAudience }) {
  return `אתה קופירייטר לפייסבוק ואינסטגרם. כתוב טקסט פרסומי בעברית ל-"${businessName || "העסק"}" שמתלווה לתמונת מודעה ממומנת.

הטקסט שכבר נמצא על התמונה (אל תחזור עליו מילה במילה — תרחיב סביבו):
- כותרת: "${ad.headline || ""}"
- תיאור קצר על התמונה: "${ad.description || ""}"
- כפתור: "${ad.cta || ""}"

הקשר העסק:
${businessField ? `- תחום: ${businessField}` : ""}
${services ? `- שירותים: ${services}` : ""}
${promotion ? `- מבצע: ${promotion}` : ""}
${targetAudience ? `- קהל יעד: ${targetAudience}` : ""}

החזר טקסט פרסומי שמוכן להעתקה ל-Meta Ads Manager או לפייסבוק עצמו, באורך 4-6 שורות, מבנה:
1. שורת פתיחה שעוצרת גלילה (שאלה / כאב / סקרנות) — אל תהיה גנרי
2. 2-3 שורות שמרחיבות את הערך / היתרונות / המבצע — דברי על מה שהלקוח מקבל בפועל, לא על "אנחנו"
3. שורת CTA חזקה עם דחיפות עדינה
4. אופציונלי: 3-4 האשטגים רלוונטיים בסוף

חוקים:
- בעברית בלבד, טון אישי וכן (לא משרד פרסום)
- בלי "אנחנו מציעים", "המומחים שלנו", או קלישאות שיווקיות אחרות
- אל תכתוב שוב את הכותרת מהתמונה — הקורא כבר ראה אותה
- כן השתמש באמוג'י 1-2 (לא יותר), במקום שמתאים
- ללא Markdown, ללא **bold**, ללא תווי עיצוב

החזר רק את הטקסט, ללא הסברים, ללא כותרת, ללא ציטוט.`;
}

async function generatePromotionDescription(sessionId, adId, brief) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error("ad not found");

  const completion = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "אתה קופירייטר ישראלי בכיר. החזר טקסט פרסומי בעברית בלבד, ללא הסברים, ללא כותרת." },
      { role: "user",   content: buildPromotionCopyPrompt({
          ad,
          businessName:   brief?.businessName,
          businessField:  brief?.businessField,
          services:       brief?.services,
          promotion:      brief?.promotion,
          targetAudience: Array.isArray(brief?.targetAudience) ? brief.targetAudience.join(", ") : brief?.targetAudience,
        }) },
    ],
  });

  const text = (completion.choices[0]?.message?.content || "").trim();
  if (!text) throw new Error("OpenAI returned empty promotion text");

  const generatedAt = new Date().toISOString();
  /* Per-element update via positional $ — race-safe when N of these run
     in parallel (e.g. the auto-generation phase at the end of
     runAdsPipeline). Replacing the whole generatedAds array would
     clobber concurrent writes. */
  await sessionsCol().updateOne(
    { sessionId, "generatedAds.id": Number(adId) },
    {
      $set: {
        "generatedAds.$.promotionDescription":            text,
        "generatedAds.$.promotionDescriptionGeneratedAt": generatedAt,
        updatedAt: new Date(),
      },
    }
  );

  ad.promotionDescription            = text;
  ad.promotionDescriptionGeneratedAt = generatedAt;
  return ad;
}

async function updateAdText(sessionId, adId, fields) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error("ad not found");

  const ALLOWED = ["headline", "description", "cta"];
  let touched = false;
  for (const key of ALLOWED) {
    if (typeof fields?.[key] === "string") {
      ad[key] = fields[key];
      touched = true;
    }
  }
  if (!touched) throw new Error("no editable fields supplied");

  ad.editedAt = new Date().toISOString();

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedAds: sess.generatedAds, updatedAt: new Date() } }
  );

  return ad;
}

/* If a server restart killed an async pipeline, the session is stuck at a
   non-terminal status forever. Auto-flip to "error" once it looks abandoned
   so the UI shows the regenerate button instead of polling forever. This
   EXACT reason string is the signal the boot resume scanner uses to
   AUTO-RECOVER a session that only "errored" because a deploy cycled the
   dyno — so keep the two in sync via this shared constant. */
const RESTART_STUCK_REASON = "תהליך הייצור נתקע (כנראה השרת התרענן באמצע). לחץ 'ייצר מחדש'.";
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 min — way longer than a healthy run
async function autoFailIfStuck(sess) {
  if (!sess || sess.status === "done" || sess.status === "error") return sess;
  const lastTouch = sess.updatedAt ? new Date(sess.updatedAt).getTime() : 0;
  if (Date.now() - lastTouch < STUCK_THRESHOLD_MS) return sess;

  console.warn(`[wow-ads] auto-failing stuck session ${sess.sessionId} (status=${sess.status})`);
  await sessionsCol().updateOne(
    { sessionId: sess.sessionId },
    { $set: { status: "error", error: RESTART_STUCK_REASON, updatedAt: new Date() } }
  );
  return { ...sess, status: "error", error: RESTART_STUCK_REASON };
}

async function getSession(sessionId) {
  const sess = await sessionsCol().findOne({ sessionId });
  return autoFailIfStuck(sess);
}

async function getLatestSessionForPhone(phone, slotKey = null) {
  let filter;
  if (slotKey) {
    filter = { phone, slotKey };
  } else {
    /* Backward compat: sessions created before slotKey existed have no
       slotKey field. Treat those (and slotKey:null) as the "default"
       session so existing clients aren't broken. */
    filter = { phone, $or: [{ slotKey: { $exists: false } }, { slotKey: null }] };
  }
  const sess = await sessionsCol().find(filter).sort({ createdAt: -1 }).limit(1).next();
  return autoFailIfStuck(sess);
}

/* ─────── Approval workflow (manager → client) ─────── */

async function setManagerApproval(sessionId, adId, approved) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error("ad not found");

  if (approved) {
    ad.managerApprovedAt = new Date().toISOString();
    delete ad.managerRejectedAt;
  } else {
    delete ad.managerApprovedAt;
  }

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedAds: sess.generatedAds, updatedAt: new Date() } }
  );
  return ad;
}

async function setClientApprovalToken(sessionId) {
  const token = `wat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await sessionsCol().updateOne(
    { sessionId },
    { $set: {
      clientApprovalToken: token,
      clientApprovalStatus: "sent",
      clientSentAt: new Date(),
      updatedAt: new Date(),
    } }
  );
  return token;
}

async function getSessionByClientApprovalToken(token) {
  return sessionsCol().findOne({ clientApprovalToken: token });
}

async function setClientApprovalDecision(token, decision, feedback) {
  const $set = {
    clientApprovalStatus: decision,
    clientRespondedAt: new Date(),
    updatedAt: new Date(),
  };
  if (feedback) $set.clientFeedback = feedback;
  await sessionsCol().updateOne({ clientApprovalToken: token }, { $set });
}

async function setAdImageFromUpload(sessionId, adId, buffer, mimeType) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error("ad not found");

  // Force 1080x1080 without ever edge-cropping (manager-uploaded ads might
  // already contain text near the edges that we MUST preserve).
  const square = await squareizePreservingText(buffer);
  const fullPath = `wow-ads/${sess.phone}/${sessionId}/ad_${adId}_uploaded_${Date.now()}.png`;
  await uploadImage(fullPath, square, "image/png");
  ad.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
  ad.uploadedAt = new Date().toISOString();
  delete ad.error;

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedAds: sess.generatedAds, updatedAt: new Date() } }
  );
  return ad;
}

async function setAdImageFromUrl(phone, adId, imageUrl) {
  const sess = await getLatestSessionForPhone(phone);
  if (!sess) throw new Error("no active ads session for this phone");
  const ad = sess.generatedAds.find(a => Number(a.id) === Number(adId));
  if (!ad) throw new Error(`ad ${adId} not found in session`);
  ad.imageUrl = imageUrl;
  ad.uploadedAt = new Date().toISOString();
  delete ad.error;
  await sessionsCol().updateOne(
    { sessionId: sess.sessionId },
    { $set: { generatedAds: sess.generatedAds, updatedAt: new Date() } }
  );
  return ad;
}

/**
 * Resume a single session that was interrupted (server restart / dyno cycle
 * after a Heroku push). The pipeline below — and the per-step skip-if-done
 * checks added in runAdsPipeline — handle the resume logic. This is a thin
 * wrapper that loads the brief from Mongo and re-enters runAdsPipeline.
 *
 * Idempotent: calling resume on a session that's already done or errored
 * is a no-op.
 */
async function resumeAdsSession(sessionId) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) {
    console.warn(`[wow-ads:resume] session ${sessionId} not found`);
    return { skipped: "not found" };
  }
  if (sess.status === "done") return { skipped: "already done" };
  if (sess.status === "error") return { skipped: "errored" };
  if (!sess.brief) {
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { status: "error", error: "no brief on resume", updatedAt: new Date() } }
    );
    return { skipped: "no brief" };
  }
  console.log(`[wow-ads:resume] resuming ${sessionId} (status=${sess.status}, ads=${sess.generatedAds?.length || 0}/${sess.totalAds})`);
  return runAdsPipeline(sessionId, sess.phone, sess.brief, sess.totalAds || 10, sess.slotKey);
}

/**
 * Startup scanner: finds every session that was mid-flight when the server
 * stopped and resumes each one. Used by server.js as a startup hook so a
 * `git push heroku main` mid-generation doesn't lose the in-progress work.
 *
 * Fire-and-forget per session — they all run in parallel against the
 * upstream APIs (OpenAI / Mongo) so no shared state to serialize.
 */
async function resumeStuckAdsSessions() {
  try {
    /* Resume two kinds of session left behind by a dyno cycle:
       1. still in-flight (status generating_*), and
       2. auto-failed by the restart watchdog (status "error" with the
          RESTART_STUCK_REASON) — these only "errored" because the deploy
          interrupted them, so they are fully recoverable. Genuine pipeline
          errors carry a different message and are intentionally left
          failed (the UI shows the regenerate button for those). */
    const stuck = await sessionsCol().find({
      $or: [
        { status: { $in: ["generating_texts", "generating_prompts", "generating_images"] } },
        { status: "error", error: RESTART_STUCK_REASON },
      ],
    }).toArray();
    if (stuck.length === 0) {
      console.log(`[wow-ads:resume] no stuck sessions found`);
      return { resumed: 0 };
    }
    console.log(`[wow-ads:resume] found ${stuck.length} stuck sessions to resume`);
    for (const sess of stuck) {
      /* Clear the restart auto-fail before re-entry: both resumeAdsSession
         and the pipeline's idempotent $setOnInsert bail on status "error".
         The true resume point is derived from generatedAds (skip-if-done),
         so the in-flight status we restore here is just a starting label. */
      if (sess.status === "error") {
        await sessionsCol().updateOne(
          { sessionId: sess.sessionId },
          { $set: { status: "generating_texts", updatedAt: new Date() }, $unset: { error: "" } }
        ).catch(() => {});
      }
      resumeAdsSession(sess.sessionId).catch(err =>
        console.error(`[wow-ads:resume] ${sess.sessionId} failed:`, err.message)
      );
    }
    return { resumed: stuck.length };
  } catch (err) {
    console.error(`[wow-ads:resume] scanner failed:`, err.message);
    return { resumed: 0, error: err.message };
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Auto-retry watchdog — webinar safety net.

   Genuine pipeline failures (e.g. OpenAI 429 "out of credit") are left in
   status "error" and are NOT touched by resumeStuckAdsSessions (which only
   recovers restart-interrupted sessions). This periodic scan gives those
   genuine failures up to MAX_RETRIES automatic re-tries with a cooldown, so
   a mid-webinar credit top-up recovers every stuck campaign on its own —
   no manual "regenerate" needed.

   Flow: fail → wait RETRY_COOLDOWN → re-run the SAME session (brief reused,
   pipeline is resume-safe/idempotent) → repeat until success or 3 tries.
─────────────────────────────────────────────────────────────────────── */
const RETRY_MAX            = 3;              // re-tries after the first failure
const RETRY_COOLDOWN_MS    = 3 * 60e3;       // wait a few minutes before each retry
const RETRY_MAX_AGE_MS     = 60 * 60e3;      // only retry failures from the last hour

/* ── OpenAI credit-outage handling ──────────────────────────────────────
   When OpenAI returns 429 "insufficient_quota / exceeded your current quota",
   the pipeline parks the session in status "waiting_credits" (NOT "error") so
   the 3-strike retry budget isn't burned. A cheap probe checks whether credit
   is back; when it is, EVERY waiting session resumes automatically — no manual
   regenerate, however long the outage lasted (no retry cap, no age limit). */
function isQuotaError(err) {
  const status = err?.status || err?.response?.status;
  const msg  = (err?.message || err?.response?.data?.error?.message || "").toLowerCase();
  const code = (err?.code || err?.response?.data?.error?.code || "").toLowerCase();
  return status === 429 || code === "insufficient_quota" ||
    /insufficient_quota|exceeded your current quota|current quota|billing hard limit/i.test(msg);
}

/* One cheap 1-token probe — true if OpenAI will accept a call right now. A
   non-quota error is treated as "credit is fine" (a different problem the real
   run should surface), so we never get stuck on an unrelated hiccup. */
async function openaiHasCredit() {
  try {
    await openai.chat.completions.create({ model: OPENAI_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    return true;
  } catch (err) {
    return !isQuotaError(err);
  }
}

/* Gemini reachability probe. The pipeline (both ad text AND images) falls back
   to Gemini when OpenAI is out of credit, so a parked session can resume the
   moment EITHER provider is reachable — not only when OpenAI credit returns. */
async function geminiHasCredit() {
  try {
    await geminiChat({ messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    return true;
  } catch {
    return false;
  }
}

/* Resume every session parked in "waiting_credits" once OpenAI credit is back. */
async function resumeCreditBlockedSessions() {
  try {
    const waiting = await sessionsCol().find({
      status: "waiting_credits",
      brief: { $exists: true, $ne: null },
    }).limit(100).toArray();
    if (waiting.length === 0) return { resumed: 0 };
    /* Resume as soon as EITHER provider is up — the pipeline auto-falls-back to
       Gemini for text + images, so OpenAI credit is no longer required. */
    const providerUp = (await openaiHasCredit()) || (await geminiHasCredit());
    if (!providerUp) {
      console.log(`[wow-ads:credit] ${waiting.length} session(s) waiting — both OpenAI and Gemini unavailable`);
      return { resumed: 0, waiting: waiting.length };
    }
    let fired = 0;
    for (const sess of waiting) {
      /* Atomic claim so a parallel dyno can't double-fire the same session. */
      const claim = await sessionsCol().updateOne(
        { sessionId: sess.sessionId, status: "waiting_credits" },
        { $set: { status: "generating_texts", updatedAt: new Date() }, $unset: { error: "" } },
      );
      if (claim.modifiedCount !== 1) continue;
      console.log(`[wow-ads:credit] credit restored → resuming ${sess.sessionId} (${sess.phone})`);
      runAdsPipeline(sess.sessionId, sess.phone, sess.brief, sess.totalAds || 10, sess.slotKey)
        .catch(e => console.error(`[wow-ads:credit] ${sess.sessionId} threw:`, e.message));
      fired++;
    }
    // Also resume ORGANIC sessions parked on the same credit outage (one probe,
    // both pipelines). runOrganicAdsPipeline is resume-safe/idempotent.
    try {
      const orgCol = getDB().collection("wow_organic_ads_sessions");
      const orgWaiting = await orgCol.find({ status: "waiting_credits", brief: { $exists: true, $ne: null } }).limit(100).toArray();
      if (orgWaiting.length) {
        const { runOrganicAdsPipeline } = require("./wow-organic-ads.service");
        for (const s of orgWaiting) {
          const claim = await orgCol.updateOne(
            { sessionId: s.sessionId, status: "waiting_credits" },
            { $set: { status: "generating", updatedAt: new Date() }, $unset: { error: "" } },
          );
          if (claim.modifiedCount !== 1) continue;
          console.log(`[wow-organic-ads:credit] credit restored → resuming ${s.sessionId} (${s.phone})`);
          runOrganicAdsPipeline(s.sessionId, s.phone, s.brief, s.totalPosts || s.quota || 5)
            .catch(e => console.error(`[wow-organic-ads:credit] ${s.sessionId} threw:`, e.message));
          fired++;
        }
      }
    } catch (e) { console.error(`[wow-ads:credit] organic resume:`, e.message); }
    if (fired) console.log(`[wow-ads:credit] resumed ${fired} credit-blocked session(s)`);
    return { resumed: fired };
  } catch (err) {
    console.error(`[wow-ads:credit] resume scanner failed:`, err.message);
    return { resumed: 0, error: err.message };
  }
}

async function retryFailedAdsSessions() {
  try {
    const now = Date.now();
    const candidates = await sessionsCol().find({
      status: "error",
      error: { $ne: RESTART_STUCK_REASON },     // restart-stuck handled by resumeStuckAdsSessions
      brief: { $exists: true, $ne: null },      // need a brief to re-run
      updatedAt: {
        $lt:  new Date(now - RETRY_COOLDOWN_MS),
        $gte: new Date(now - RETRY_MAX_AGE_MS),
      },
      $or: [{ retryCount: { $exists: false } }, { retryCount: { $lt: RETRY_MAX } }],
    }).toArray();

    if (candidates.length === 0) return { retried: 0 };

    let fired = 0;
    for (const sess of candidates) {
      const attempt = (sess.retryCount || 0) + 1;
      /* Atomic claim: flip away from "error" so the next scan tick (and any
         parallel dyno) can't double-fire the same session. */
      const claim = await sessionsCol().updateOne(
        { sessionId: sess.sessionId, status: "error" },
        {
          $set:   { status: "generating_texts", lastRetryAt: new Date(), updatedAt: new Date() },
          $unset: { error: "" },
          $inc:   { retryCount: 1 },
        },
      );
      if (claim.modifiedCount !== 1) continue;  // lost the race — skip
      console.log(`[wow-ads:retry] auto-retry ${attempt}/${RETRY_MAX} for ${sess.sessionId} (${sess.phone})`);
      runAdsPipeline(sess.sessionId, sess.phone, sess.brief, sess.totalAds || 10, sess.slotKey)
        .catch(err => console.error(`[wow-ads:retry] ${sess.sessionId} attempt ${attempt} threw:`, err.message));
      fired++;
    }
    if (fired) console.log(`[wow-ads:retry] fired ${fired} auto-retries`);
    return { retried: fired };
  } catch (err) {
    console.error(`[wow-ads:retry] scanner failed:`, err.message);
    return { retried: 0, error: err.message };
  }
}

/* Start the periodic watchdog. Idempotent — safe to call once at startup. */
let _retryTimer = null;
function startAdsRetryWatchdog(intervalMs = 60e3) {
  if (_retryTimer) return;
  _retryTimer = setInterval(() => {
    retryFailedAdsSessions().catch(() => {});
    resumeCreditBlockedSessions().catch(() => {}); // resume 429/credit-parked sessions
  }, intervalMs);
  if (_retryTimer.unref) _retryTimer.unref();
  console.log(`[wow-ads:retry] watchdog started (every ${Math.round(intervalMs / 1000)}s, max ${RETRY_MAX} retries + credit-resume)`);
}

module.exports = {
  runAdsPipeline,       // (sessionId, phone, brief, quota, slotKey?)
  generateAdsTexts,     // (brief, count) — copy step; exported for testing/debug

  resumeAdsSession,     // (sessionId) — re-enter the pipeline at the right step
  resumeStuckAdsSessions, // startup scanner
  retryFailedAdsSessions, // manual trigger of one retry sweep
  resumeCreditBlockedSessions, // resume sessions parked on OpenAI 429/out-of-credit
  startAdsRetryWatchdog,  // periodic auto-retry + credit-resume (webinar safety net)
  regenerateSingleAd,
  markAdRegenerating,
  failAdRegenerate,
  updateAdText,
  generatePromotionDescription,
  getSession,
  getLatestSessionForPhone,
  setManagerApproval,
  setClientApprovalToken,
  getSessionByClientApprovalToken,
  setClientApprovalDecision,
  setAdImageFromUpload,
  setAdImageFromUrl,
};
