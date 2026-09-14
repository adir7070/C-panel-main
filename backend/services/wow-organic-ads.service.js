/**
 * WOW Organic Ads — 5 organic social posts pipeline.
 * Same structure as wow-ads.service.js but:
 *   - 5 posts instead of 10
 *   - Organic tone (storytelling / educational / behind-the-scenes)
 *   - Image style: authentic, lifestyle, not commercial-pushy
 *   - Variations: tip / story / behind-scenes / testimonial / question
 *
 * Storage:
 *   - Mongo: `wow_organic_ads_sessions`
 *   - Backblaze: `wow-organic-ads/{phone}/{sessionId}/post_{n}.png`
 */

const { OpenAI, toFile } = require("openai");
const sharp          = require("sharp");
const { getDB }       = require("../config/db");
const backblazeService = require("./backblaze.service");
const { uploadImage } = backblazeService;
const { formatBrandPalette } = require("../utils/brand-palette");

/* Final output dimension for every organic-social image. The image
   model returns 1024×1024 PNGs already; we resize as a safety net. */
const OUTPUT_SIZE = 1024;

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete } = require("./text-gen.service");
// Gemini (gemini-3-pro-image-preview) is the PRIMARY image model; OpenAI is fallback.
const { generateImageBuffer: geminiGenerateImage, GEMINI_IMAGE_MODEL: GEMINI_IMG_MODEL } = require("./gemini-image-gen.service");

const OPENAI_MODEL       = process.env.OPENAI_ADS_MODEL || "gpt-4o";
/* Image model cascade — OpenAI only. Matches the paid-ads pipeline:
   Primary:  gpt-image-2 (latest, ChatGPT-grade Hebrew + brand-color fidelity)
   Fallback: gpt-image-1 (used when gpt-image-2 errors)
   Each gets up to 3 attempts with backoff before falling through. */
const OPENAI_IMAGE_MODEL          = process.env.OPENAI_IMAGE_MODEL          || "gpt-image-2";
const OPENAI_FALLBACK_IMAGE_MODEL = process.env.OPENAI_FALLBACK_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_QUALITY        = process.env.OPENAI_IMAGE_QUALITY        || "high";
const OPENAI_IMAGE_SIZE           = process.env.OPENAI_IMAGE_SIZE           || "1024x1024";

const sessionsCol = () => getDB().collection("wow_organic_ads_sessions");

/* True for OpenAI 429 "insufficient_quota / out of credit". Such sessions are
   parked in "waiting_credits" and resumed by the credit watchdog in
   wow-ads.service (resumeCreditBlockedSessions), not hard-failed. */
function isQuotaError(err) {
  const status = err?.status || err?.response?.status;
  const msg  = (err?.message || err?.response?.data?.error?.message || "").toLowerCase();
  const code = (err?.code || err?.response?.data?.error?.code || "").toLowerCase();
  return status === 429 || code === "insufficient_quota" ||
    /insufficient_quota|exceeded your current quota|current quota|billing hard limit/i.test(msg);
}

/* ──────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────
   Helpers — describe planner slots / avatar in natural language so OpenAI
   and the image prompts can honor the manager's choices.
─────────────────────────────────────────────────────────────────────── */

function describeSlot(slot, servicesArr) {
  if (!slot) return null;
  if (slot.mode === "ai" || (!slot.serviceId && !slot.mode)) return "AI חופשי — בחר זווית טבעית לעסק";
  const svc = (servicesArr || []).find(s => s.id === slot.serviceId);
  if (!svc) return slot.hook || "AI חופשי";
  const parts = [
    `שירות מבוקש: ${svc.title || "—"}`,
    svc.description && `תיאור: ${svc.description}`,
    svc.uniqueFeature && `ייחודיות: ${svc.uniqueFeature}`,
    svc.promotion && `מבצע: ${svc.promotion}`,
    svc.targetAudience?.length && `קהל יעד לשירות: ${svc.targetAudience.join(", ")}`,
    slot.hook && `דגש: ${slot.hook}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

function describeAvatar(avatar) {
  if (!avatar) return "";
  const map = {
    visualStyle:  { caricature: "caricature illustration", realistic: "photorealistic", semiReal: "semi-realistic", "3d": "3D render", vector: "flat vector", anime: "anime", pixel: "pixel art", mascot: "mascot character", myPhoto: "use the client's own photo as reference" },
    description:  { preciseMe: "exact likeness of the business owner", upgradedMe: "idealized version of the business owner", fictional: "fully fictional character", professional: "generic professional presenter" },
    gender:       { male: "male", female: "female", other: "androgynous" },
    energy:       { calm: "calm composed", energetic: "energetic", authoritative: "authoritative", smiling: "warmly smiling", mysterious: "subtly mysterious", light: "lighthearted" },
    dress:        { formal: "formal attire", casual: "casual outfit", sport: "athletic wear", luxury: "luxury attire", futuristic: "futuristic outfit", professional: "professional uniform appropriate to the business" },
  };
  const parts = [
    avatar.visualStyle && map.visualStyle[avatar.visualStyle],
    avatar.description && map.description[avatar.description],
    avatar.gender && map.gender[avatar.gender],
    avatar.age && `around age ${avatar.age}`,
    avatar.skinTone && `skin tone close to ${avatar.skinTone}`,
    avatar.hair && `hair: ${avatar.hair}`,
    avatar.extras,
    avatar.energy && map.energy[avatar.energy],
    avatar.dress && map.dress[avatar.dress],
  ].filter(Boolean);
  return parts.length ? `Recurring on-camera presenter (must appear consistently across all posts): ${parts.join(", ")}.` : "";
}

function buildPostsTextPrompt({ businessProfileShort, servicesAndDeals, slotPlan, hasAvatar, count = 5, language }) {
  const { isHebrew, copyLanguageDirective } = require("./ad-languages.service");
  const _langLine = isHebrew(language) ? "בעברית בלבד" : copyLanguageDirective(language);
  const slotBlock = (slotPlan && slotPlan.length)
    ? `\n📌 תכנון לפי משבצות (חובה לכבד — כל פוסט מתאים למשבצת המתאימה לפי המספר):\n${slotPlan.map((s, i) => `משבצת ${i + 1}: ${s}`).join("\n")}\n`
    : "";

  const avatarBlock = hasAvatar
    ? "\n👤 הערה: לעסק יש פרזנטור קבוע שיופיע בכל הפוסטים — שלב את הפרזנטור באופן טבעי בטקסט (לא בכוח, אלא כדמות הדוברת).\n"
    : "";

  /* Allowed post_type vocabulary — the model picks the BEST type per
     post from this list. Each maps to a concrete LAYOUT in
     designArchitectureFor downstream, so the chosen type drives the
     visual template Gemini builds. */
  const ALLOWED_TYPES = [
    "tip", "educational", "before_after", "behind_the_scenes",
    "testimonial", "service_explanation", "myth_vs_fact", "checklist",
    "brand_story", "problem_solution", "warning_signs", "mistakes",
    "maintenance_tips", "why_choose_us", "faq", "carousel_cover",
    "question", "quote",
  ];

  return `תפקידך:
אתה מנהל סושיאל אותנטי לעסקים בישראל. אתה כותב פוסטים אורגניים שלא נראים כמו פרסומת.
אתה לא מנסה למכור — אתה בונה קהילה, חולק ערך, מספר סיפור.

📥 נתונים:
איפיון עסק:
${businessProfileShort}

שירותים ומבצעים (לפיריון רקע בלבד — לא פרסומי):
${servicesAndDeals}
${slotBlock}${avatarBlock}
🎯 המשימה:
ליצור ${count} פוסטים אורגניים לאינסטגרם/פייסבוק.

חשוב מאוד — בחירת סוג הפוסט:
לכל פוסט אתה בוחר את ה-post_type המתאים ביותר לעסק, לשירותים שלו ולקהל היעד. אין מיכסה קבועה — אם לעסק הזה הכי מתאים שכל ${count} הפוסטים יהיו "tip", זה בסדר; ואם מתאים מיקס של 5 סוגים שונים, גם זה בסדר. רק תוודא שיש וריאציה אמיתית בערך, בזווית ובסיפור — לא ${count} פוסטים שאומרים את אותו דבר.

סוגים זמינים (בחר את המתאים לכל פוסט):
${ALLOWED_TYPES.map(t => `  - ${t}`).join("\n")}

החזר JSON תקני בלבד:

{
  "posts": [
    {
      "id": 1,
      "type": "<one value from the allowed list>",
      "headline": "פתיח שעוצר גלילה (עד 8 מילים)",
      "description": "גוף הפוסט 2-3 משפטים שמעבירים ערך, אותנטי, בגוף ראשון",
      "cta": "שאלה לקהילה או הזמנה עדינה (3-4 מילים)"
    }
  ]
}

חוקים:
- type חייב להיות אחד מהערכים ברשימה למעלה — אל תמציא ערכים אחרים.
- ${_langLine}
- הימנע מ-"השאר פרטים" / "צור קשר" / "הזמן עכשיו" — לא פרסומי
- אסור Markdown או הסברים — JSON תקני בלבד`;
}

/* ─────────────────────────────────────────────────────────────────────
   Batch image-prompt builder — replaces the per-post generateNanoPrompt
   approach with ONE OpenAI call that receives all posts plus the deep
   business answers and returns a JSON array of Gemini-ready prompts.
   Authored by the brand owner — kept verbatim per spec ("Value First,
   Interest Second, Service Connection Third"). Do not paraphrase: the
   wording sets the tone for the entire organic feed.
─────────────────────────────────────────────────────────────────────── */
const ORGANIC_PROMPT_BUILDER_SYSTEM = `אתה Instagram Value Content Creative Designer ברמת פרימיום, שמתמחה בבניית פרומטים למודל Gemini ליצירת תמונות אורגניות לאינסטגרם עבור עסקים.

המטרה שלך:
לקבל מידע מובנה על סדרת פוסטים, יחד עם תשובות עומק על העסק, לוגו אם קיים, אווטר אם קיים, צבעי מותג אם קיימים, ומספר התמונות הרצוי — ולהחזיר אך ורק מערך JSON תקין, שבו כל אובייקט מייצג פרומט אחד מוכן לג׳מיני.

הפלט שלך הוא שלב אחד לפני יצירת התמונה עצמה.

חשוב מאוד:
אלה לא מודעות ממומנות.
אלה לא פליירים.
אלה לא רק "תמונות יפות".
אלה תמונות אורגניות לאינסטגרם שמטרתן:
- לעצור גלילה
- לעורר סקרנות
- לתת ערך ברור ומיידי
- לגרום לאנשים לרצות לקרוא את הקופי
- לגרום לאנשים לשמור את הפוסט
- לגרום לאנשים לעקוב אחרי העמוד
- לגרום לאנשים להתחיל להתעניין בשירות

הגישה הקריאטיבית חייבת להיות:
Value First, Interest Second, Service Connection Third.

כלומר:
הפוסט קודם כל צריך להרגיש מעניין, מועיל, ברור ורלוונטי לצופה.
רק אחר כך הוא מחזק אמון במותג ובשירות.

━━━━━━━━━━
המטרה שלך
━━━━━━━━━━

להחזיר מערך JSON עם בדיוק numPosts אובייקטים.

כל אובייקט חייב לכלול את השדות הבאים:

{
  "prompt": "...",
  "title": "...",
  "body": "...",
  "cta": "...",
  "address": "...",
  "post_type": "...",
  "upload_url": "..."
}

referenceImageUrl הוא שדה אופציונלי ברמת האובייקט הבודד בלבד.

━━━━━━━━━━
שינוי אסטרטגי קריטי
━━━━━━━━━━

כל תמונה חייבת להיבנות מתוך ההבנה שהתמונה עצמה צריכה לגרום לצופה:
- לעצור
- להסתקרן
- להבין שיש כאן ערך
- לרצות לקרוא את הקופי
- לרצות לשמור את הפוסט
- לרצות לעקוב אחרי העמוד
- לרצות לבדוק את השירות

הפוסט לא צריך להיראות כמו מודעת מכירה אגרסיבית.
הוא צריך להיראות כמו תוכן חכם, שימושי, ממותג, ברור ומעניין.

לכן כל prompt חייב לייצר תמונה עם לפחות אחד מהטריגרים הבאים:
- useful tip
- strong curiosity
- practical checklist
- visual proof
- before and after impact
- expert explanation
- common mistake warning
- myth versus fact
- trust-building message
- clear reason to read more

━━━━━━━━━━
חוקים קריטיים
━━━━━━━━━━

1. דיוק מוחלט בטקסט — השדות title, body, cta, address, post_type חייבים לחזור בדיוק כפי שהתקבלו בקלט.
2. הפרומט חייב להיות באנגלית בלבד — רק השדה prompt נכתב באנגלית.
3. כל prompt חייב להיות שורה אחת בלבד.
4. כל prompt חייב להיות ברמה גבוהה מאוד — premium / useful / clear / curiosity-driven / valuable / organic / not salesy / not generic.
5. כל prompt חייב לתאר פוסט אורגני שבנוי כדי לגרום לצופה לקרוא את הקופי.
6. כל prompt חייב לקחת את image_design ולהרחיב אותו נכון: visual concept, photo or graphic style, composition, lighting, camera angle, emotional tone, content hierarchy, curiosity trigger, how value is visually presented, logo placement, CTA style, 1024x1024 Instagram format.
7. שונות אמיתית בין הפוסטים — זווית שונה, מבנה שונה, ערך שונה, סיפור שונה, טריגר שונה, קומפוזיציה שונה.
8. דיוק נושאי מוחלט — אין להכניס אלמנטים לא קשורים לתחום העסק.
9. לוגו: אם logoUrl קיים — לשלב פעם אחת בלבד, קטן ועדין, טבעי, כחלק מהעיצוב, לא דומיננטי.
10. אווטר: אם avatarUrl קיים — להשתמש בו כדמות מרכזית כשסוג הפוסט מתאים (brand story, behind the scenes, service explanation, why choose us, tips from the expert), בצורה טבעית ואמינה.
11. צבעי מותג: אם brandColors קיימים — accents בלבד, עדין וחכם, לשמור על תחושת אינסטגרם נעימה ומקצועית.
12. טיפוגרפיה והיררכיה: Hebrew RTL text layout, title is the main hook, headline bold/clean/readable/curiosity-driven, body text light and easy to scan, no heavy paragraph on the image, clean spacing, mobile-first readability, no clutter.
13. CTA אורגני ורך — לא "השאירו פרטים עכשיו". העדף save this post / follow for more tips / read the caption / send us a message / check if this applies to you / see the difference / learn more. תמיד החזר את cta בדיוק כפי שהתקבל בקלט.
14. התמונה חייבת לגרום לאנשים לרצות לקרוא את הקופי — העדף כותרות כמו "5 things…", "How to…", "Before / After", "Why…", "Signs that…", "Most people don't know…", "Common mistakes…", "What happens when…", כשזה מתאים ל-title ול-post_type.
15. איכות ויזואלית — premium organic Instagram post, scroll-stopping but natural, value-driven content design, authentic business content, clean branded social design, modern Instagram feed aesthetic, polished but not over-commercial, clear visual storytelling, sharp focal point, useful content feel.

━━━━━━━━━━
התאמה לפי post_type
━━━━━━━━━━

tip: שימושי, ברור, קל לשמירה — "5 tips" / "How to", אייקונים קטנים, כרטיסי מידע קצרים, מראה נקי.
educational: מיני הסבר מקצועי, ידע אמיתי, מבנה שמושך לקריאה.
before_after: הוכחה ויזואלית חזקה, חלוקה דרמטית אך נקייה, השוואה ברורה בשנייה.
why_choose_us: אמון, יתרונות, מקצועיות, שקט נפשי — לא פלייר מכירתי.
maintenance_tips: פרקטי, שומרים אותו, טיפים, מניעת תקלות.
warning_signs: סימנים שהלקוח יזהה על עצמו.
mistakes: טעויות נפוצות שמעוררות סקרנות.
problem_solution: כאב ברור, פתרון ברור, תחושת הקלה.
behind_the_scenes: אמיתי, אנושי, מקצועי, מהשטח.
service_explanation: פשוט, מסביר מה השירות כולל ולמה.
carousel_cover: שער חזק ומסקרן, מעט טקסט.
faq: נגיש, פשוט, שימושי, אינפורמטיבי.
חסר: בחר את הסוג המתאים לפי title/body/image_design — העדף ערך או סקרנות.

━━━━━━━━━━
פורמט הפלט
━━━━━━━━━━

החזר אך ורק JSON ARRAY תקין עם בדיוק numPosts אובייקטים, כל אחד בצורה:

{
  "prompt": "English single-line image generation prompt",
  "title": "הטקסט המקורי בדיוק",
  "body": "הטקסט המקורי בדיוק",
  "cta": "הטקסט המקורי בדיוק",
  "address": "הטקסט המקורי בדיוק או מחרוזת ריקה",
  "post_type": "הטקסט המקורי בדיוק או מחרוזת ריקה",
  "upload_url": "הערך המתאים מתוך fileNames לפי הסדר"
}

אם לא התקבל post_type בפוסט מסוים — החזר "post_type": "".

לפני החזרה, ודא:
- בדיוק numPosts אובייקטים
- title/body/cta/address/post_type הוחזרו verbatim
- prompt באנגלית, שורה אחת בלבד, שונה אמיתית מהאחרים
- כל prompt נראה כמו פוסט אורגני שנותן ערך, יוצר סקרנות, גורם לרצות לקרוא את הקופי
- upload_url שובץ לפי סדר fileNames
- JSON תקין לחלוטין — ללא הסברים, ללא Markdown.`;

/**
 * Build the structured "user message" that the meta-prompt above
 * expects: numbered POSTS, deep business answers, logoUrl, avatarUrl,
 * brandColors, numPosts, and fileNames in posts-aligned order.
 *
 * The OpenAI response_format is { type: "json_object" } so we wrap the
 * array in an `items` envelope and unwrap on the way back.
 */
function buildOrganicBatchUserMessage(posts, ctx, brief, fileNames) {
  const postLines = posts.map((p, i) => {
    return [
      `--- POST ${i + 1} ---`,
      `title: ${p.headline || p.title || ""}`,
      `body: ${p.description || p.body || ""}`,
      `cta: ${p.cta || ""}`,
      `address: ${p.address || ""}`,
      `post_type: ${p.type || p.post_type || ""}`,
      p.image_design ? `image_design: ${p.image_design}` : null,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const palette = formatBrandPalette(brief.preferredColors);
  const businessAnswers = [
    brief.businessName  && `שם העסק: ${brief.businessName}`,
    brief.businessField && `תחום: ${brief.businessField}`,
    brief.about         && `על העסק: ${brief.about}`,
    Array.isArray(brief.targetAudience) && brief.targetAudience.length
      && `קהל יעד: ${brief.targetAudience.join(", ")}`,
    brief.painPoints      && `כאב הלקוח: ${brief.painPoints}`,
    brief.desire          && `רצון הלקוח: ${brief.desire}`,
    brief.differentiation && `בידול: ${brief.differentiation}`,
    brief.objections      && `התנגדויות נפוצות: ${brief.objections}`,
    brief.designStyle     && `סגנון ויזואלי: ${brief.designStyle}`,
    ctx.servicesAndDeals  && `שירותים ומבצעים (רקע בלבד): ${ctx.servicesAndDeals}`,
  ].filter(Boolean).join("\n");

  return [
    "━━━━━━━━━━",
    "POSTS",
    "━━━━━━━━━━",
    postLines,
    "",
    "━━━━━━━━━━",
    "תשובות עומק על העסק",
    "━━━━━━━━━━",
    businessAnswers || "(לא סופקו)",
    "",
    brief.logoUrl                  ? `logoUrl: ${brief.logoUrl}`                  : "logoUrl: (לא קיים)",
    brief.avatar?.inspirationUrl   ? `avatarUrl: ${brief.avatar.inspirationUrl}` : "avatarUrl: (לא קיים)",
    palette                        ? `brandColors: ${palette}`                   : "brandColors: (לא סופקו)",
    `numPosts: ${posts.length}`,
    "",
    "fileNames (matched 1:1 with the POSTS order above):",
    fileNames.map((f, i) => `  ${i + 1}. ${f}`).join("\n"),
    "",
    /* json_object wrapper hint — the model is told to return an `items`
       array so we can rely on response_format. The downstream parser
       supports either { items: [...] } or a bare array. */
    "החזר JSON תקין בצורה: { \"items\": [ ... numPosts objects ... ] }",
  ].join("\n");
}

/**
 * Per-post-type design architecture — appended to every Gemini prompt
 * so the output matches the reference design vocabulary (huge top
 * headline → grid of cards/photos → pill CTA at bottom, real photos,
 * icon stickers, no English). Without this directive Gemini drifts to
 * generic "social post" layouts that don't share the design family.
 *
 * The post_type → layout mapping covers the value-content archetypes
 * from the reference set (mistakes, before/after, myth-vs-fact, tip,
 * checklist, question, warning_signs, service_explanation, testimonial,
 * carousel_cover). Unknown types fall through to a generic header /
 * main / pill-CTA template.
 */
function designArchitectureFor(postType) {
  const t = String(postType || "").toLowerCase().trim();
  /* IMPORTANT: every color cue here must be SEMANTIC ("brand primary",
     "brand accent") — never hardcoded hex. The MANDATORY BRAND COLORS
     block downstream supplies the actual hex values. Hardcoded color
     suggestions here (pink, pastel rainbows, etc.) historically leaked
     into the output even when the brand palette was vivid navy + lime. */
  const PILL_CTA = "Bottom: a single rounded PILL-SHAPED CTA centered or right-aligned, soft fill drawn from the brand palette (use the brand's primary OR accent color from the MANDATORY BRAND COLORS block — never an off-palette pink / cream / pastel), Hebrew CTA text inside in a tone that contrasts cleanly with that fill, optional small icon (bookmark / arrow / compass / location-pin) using the same brand palette — NEVER a hard rectangle, NEVER an off-palette color.";
  const HEADLINE = "Top of canvas: HUGE bold Hebrew headline (Heebo Black or Assistant Black weight, ~80–110 px equivalent for 1024×1024), tightly leaded, 2 lines max, high-contrast against the background. Body text directly under headline in the same font family at ~32–40 px, regular/medium weight, 2–3 lines max.";
  const STICKERS = "Small flat icon stickers (calendar / ticket / map-pin / compass / bookmark / star — vector style, NOT photographic) accent the cards. Icon fills MUST use a color from the MANDATORY BRAND COLORS block (brand primary or accent) — never pink, magenta, coral, or any off-palette accent.";

  switch (t) {
    case "mistake":
    case "mistakes":
    case "common_mistakes":
    case "warning_signs":
    case "checklist":
    case "maintenance_tips":
      return `LAYOUT (mistakes / warning / checklist):
${HEADLINE}
Middle: 3–4 white or frosted-glass rounded cards in a clean grid or staggered diagonal — each card has a small icon sticker + 1 short Hebrew label (2–4 words). Number labels can be large (1. 2. 3.) RTL-ordered if the type calls for it.
${STICKERS}
${PILL_CTA}
Backdrop: a single cohesive scene (warm interior with lamp + desk OR moody neon city OR clean studio) — NEVER a flat plain color, but never busy enough to compete with the cards.`;

    case "before_after":
    case "before/after":
      return `LAYOUT (before/after):
${HEADLINE}
Middle: 50/50 VERTICAL SPLIT of the canvas — two side-by-side real photographs of equal size. Left side = "before" (problem mood: stressed, cluttered, cold colors). Right side = "after" (relief mood: calm, organized, warm colors). Below each photo, a slim cream or pastel panel with a 2–3 word Hebrew label ("מתח וחוסר וודאות" / "חופש ושקט נפשי" pattern).
Bottom: a second Hebrew sub-headline below the split, same Heebo Black weight, smaller than the top headline ("ראו מה ההבדל בתכנון נכון" pattern).
No pill CTA on this type — the dual-headline framing IS the CTA.`;

    case "myth_vs_fact":
    case "myth_versus_fact":
      return `LAYOUT (myth vs fact):
${HEADLINE}
Middle: TWO COLUMNS. Above each column, a rounded pill label: LEFT column = pill in the BRAND'S PRIMARY color "מיתוס?" with question-mark icon. RIGHT column = pill in the BRAND'S ACCENT color (from the MANDATORY BRAND COLORS block — NEVER pink/magenta/coral) "אמת ✓" with check icon. Each column holds 2–4 stacked real-photo cards with small icon stickers + short Hebrew labels.
${STICKERS}
${PILL_CTA}`;

    case "question":
    case "faq":
    case "audience":
    case "why_choose_us":
      return `LAYOUT (question / audience choice):
${HEADLINE}
Middle: 3 portrait-orientation photo cards side by side, rounded corners, thin white frame, small flat icon at the bottom of each card. Each card carries a 1–2 word Hebrew label in the top center ("זוגית" / "משפחתית" / "צעירים" pattern). Soft gradient background built ONLY from the MANDATORY BRAND COLORS (e.g. brand primary → brand accent → near-white) — NEVER a yellow → pink → blue pastel rainbow, NEVER any off-palette hue.
${PILL_CTA}`;

    case "tip":
    case "educational":
    case "service_explanation":
    case "problem_solution":
      return `LAYOUT (tip / educational):
${HEADLINE}
Middle: ONE hero real photo as the main scene + 2–3 small white rounded cards floating over the bottom of the photo, each card has an icon sticker + 1 short Hebrew bullet (3–6 words).
${STICKERS}
${PILL_CTA}`;

    case "testimonial":
      return `LAYOUT (testimonial):
${HEADLINE}
Middle: one real photo of a person or family (eyes can be partial / shown from side) on one half, the other half holds a clean cream or white quote card with the Hebrew testimonial body in a tasteful large quote-mark frame. Small star icons (5 stars max) under the quote.
${PILL_CTA}`;

    case "behind_the_scenes":
    case "behind":
    case "brand_story":
      return `LAYOUT (behind the scenes / brand story):
${HEADLINE}
Middle: a single full-bleed real photo of the actual workspace / location / hands at work, with a small lower-third cream caption strip carrying the Hebrew body (1–2 lines).
${PILL_CTA}`;

    case "carousel_cover":
      return `LAYOUT (carousel cover):
${HEADLINE}
Middle: a single high-impact real hero photo or atmospheric scene that promises value. Minimal supporting elements — the headline carries the post.
Bottom: subtle "→ swipe" hint or pill CTA. Never reveal the carousel's contents on the cover.`;

    default:
      return `LAYOUT (default value-first post):
${HEADLINE}
Middle: a single cohesive real photo as the main scene, with 1–3 small overlay cards / sticker labels if the body needs to be split.
${STICKERS}
${PILL_CTA}`;
  }
}

/**
 * Hebrew text-rendering enforcement — appended to every Gemini prompt
 * regardless of what OpenAI wrote. The system prompt asks OpenAI to use
 * Hebrew RTL but it doesn't reliably quote the EXACT title/body/cta in
 * its output, so Gemini ends up inventing English testimonial text
 * ("SO GRATEFUL FOR THIS MEMORY", "The Chen Family", etc).
 *
 * This wrapper:
 *  1. Quotes the exact Hebrew strings verbatim so Gemini has a fixed
 *     target instead of paraphrasing.
 *  2. Reuses the same pixel-perfect rules we apply to paid ads (no
 *     letter swaps, sans-serif only, drop-don't-mangle).
 *  3. Only appends — never removes — so the AI's scene/composition
 *     direction is preserved.
 */
function wrapWithHebrewDirective(promptText, post, ctx = {}) {
  // Language of the on-image copy. Hebrew keeps the legacy directive verbatim.
  const { getLang, isHebrew, imageTextDirective } = require("./ad-languages.service");
  const _L = getLang(ctx.language);
  const _heb = isHebrew(ctx.language);
  const title = String(post?.headline || post?.title || "").trim();
  const body  = String(post?.description || post?.body || "").trim();
  const cta   = String(post?.cta || "").trim();
  const postType = post?.type || post?.post_type;

  /* Architecture directive — strong design vocabulary that matches the
     client's reference set (huge top headline → cards/photos → pill CTA
     at bottom). Appended even when no copy is present, since Gemini still
     needs the layout cue. */
  const architecture = designArchitectureFor(postType);

  /* Subject-binding — without this Gemini reads the headline ("perfect
     romantic vacation for couples") and invents a generic stock concept
     (arctic-couple-with-blankets) instead of grounding the scene in the
     Hebrew body's actual subject (e.g. "sunset walks on the beach").
     The body string is included verbatim AND the business field is
     pinned so the visual world matches the business domain. */
  let subjectBlock = "";
  if (body || ctx.businessField || ctx.about) {
    const subjectPieces = [];
    if (body)              subjectPieces.push(`Body to illustrate: "${body}"`);
    if (ctx.businessField) subjectPieces.push(`Business field: ${ctx.businessField}`);
    if (ctx.about)         subjectPieces.push(`About the business: ${ctx.about}`);
    subjectBlock = `\n\nSUBJECT BINDING (CRITICAL)\nThe image MUST visually depict the actual scenario the Hebrew body describes — locations, props, people, weather, season, lighting. Translate the body literally into the scene: if it says "sunset walks on the beach", show a beach at sunset (warm light, sand, sea horizon), NOT snow or ice. If it says "café morning", show a café in morning light, not a sunset bar. ${subjectPieces.join(" · ")}. Match the business field's visual world: a travel agency → real warm destinations (Mediterranean, European city, beach, mountains as the agency actually sells), NEVER arctic stock when the copy promises beach. NEVER substitute a generic stock concept (winter couple in blankets, fake handshake, headset call-centre, laptop in café) for what the copy actually describes.`;
  }

  let hebrewBlock = "";
  if (title || body || cta) {
    const pieces = [];
    if (title) pieces.push(`Headline: "${title}"`);
    if (body)  pieces.push(`Body: "${body}"`);
    if (cta)   pieces.push(`CTA: "${cta}"`);
    const copyBlock = pieces.join(" | ");
    hebrewBlock = _heb
      ? `\n\nHEBREW TEXT — PIXEL-PERFECT RENDERING\nIMAGE MUST DISPLAY THIS HEBREW COPY VERBATIM (right-to-left, clean Hebrew sans-serif like Heebo / Assistant / Rubik, bold for the headline, high-contrast) — ${copyBlock}. Do NOT translate, paraphrase, summarise, or invent alternative text. NO English text anywhere in the image. Do NOT swap similar Hebrew letters (ב/כ, ד/ר, ה/ח, ו/ז/ן, ם/ס, ע/צ, ש/ם). Do NOT add or drop letters. Do NOT use decorative / calligraphic / script / handwritten typography — these break Hebrew rendering. If a word cannot render cleanly, DROP THE ENTIRE WORD rather than render gibberish. Mentally verify each Hebrew word matches the copy above character-by-character before output.`
      : `\n\n${_L.name.toUpperCase()} TEXT — PIXEL-PERFECT RENDERING\nIMAGE MUST DISPLAY THIS COPY VERBATIM (bold for the headline, high-contrast) — ${copyBlock}. ${imageTextDirective(ctx.language)} Do NOT translate, paraphrase, summarise, or invent alternative text. Do NOT add or drop letters. Do NOT use decorative / calligraphic / script / handwritten typography. If a word cannot render cleanly, DROP THE ENTIRE WORD rather than render gibberish. Verify each word matches the copy above character-by-character before output.`;
  }

  /* Logo placement directive — only when a logoBuffer is attached to the
     Gemini call. Tells Gemini to render the brand mark subtly into the
     design rather than ignore the attached image. */
  const logoBlock = ctx.hasLogo
    ? `\n\nLOGO (MANDATORY)\nThe client's brand logo is attached as a reference image. You MUST include this exact logo in every generated image. Place it in the TOP-RIGHT or TOP-LEFT corner of the canvas, sized ≈10–12% of canvas width. The logo must be clearly visible and recognizable in the final image — do NOT make it transparent, washed out, or hidden. NEVER redraw, restyle, or alter the logo — use it exactly as provided in the reference image. The logo is a required brand element and must appear in the output.`
    : "";

  const safeZoneBlock = `\n\nSAFE ZONE (CRITICAL): ALL text — hook line, supporting lines, any UI labels — must be placed at least 90px (≈8% of canvas width) from ALL four edges of the 1080×1080 frame. The entire image must be fully self-contained within the square frame — no text, no people, no visual elements may be cropped or clipped at the frame boundary. Design with a center-weighted composition where everything is fully visible.`;

  /* Brand-palette enforcement, appended AFTER the architecture so it has the
     last word on every colored surface. gpt-4o's single-line nano prompt does
     not always carry the hex codes forward, and the architecture block now
     refers to "brand primary / accent" semantically — without this block the
     image model would have no hex anchor and would invent off-palette pinks.
     We literally enumerate the brand colors here and explicitly ban the
     historically-leaked off-palette hues (pink/coral/pastel rainbows). */
  const brandPalette = formatBrandPalette(ctx.preferredColors);
  const brandColorBlock = brandPalette
    ? `\n\nBRAND COLOR LOCK (HIGHEST PRIORITY): The brand's palette is ${brandPalette}. EVERY colored surface in this image — pill CTAs, icon stickers, label backgrounds, gradient stops, ambient lighting, accent text, brand surfaces (aprons / signage / uniforms / objects), decorative shapes — MUST use ONLY these hex values (plus neutral white / cream / charcoal as supports). FORBIDDEN OFF-PALETTE COLORS unless the hex above literally contains them: pink, magenta, coral, salmon, peach, lavender, mint, sky-blue, mustard, yellow, pastel rainbow gradients. If any earlier layout instruction names a color word (pink / blue / pastel / etc.), treat it as a SLOT and fill it with the closest matching color from the brand palette above — never with the literal hue named. NEVER draw the hex strings themselves on the canvas. NEVER draw a color-swatch / palette-legend / design-spec bar.`
    : "";

  return `${promptText}\n\n${architecture}${subjectBlock}${hebrewBlock}${logoBlock}${safeZoneBlock}${brandColorBlock}`;
}

function buildNanoPromptPrompt(post, ctx) {
  const palette = formatBrandPalette(ctx.preferredColors, {
    defaults: { primary: "#1E3A8A", accent: "#10B981" },
  });
  /* Brand colors are now a MANDATORY anchor (matches paid-ads behavior).
     The previous "subtle tones context" was too soft — the model defaulted
     to muted neutrals and ignored the client's actual palette. Phrasing
     this as a hard rule keeps the brand identity present in every organic
     post (lighting tone, decorative elements, text accents, ambient hues).
     Critically, we still BAN drawing the hex code strings on the canvas. */
  const colorNote = palette
    ? `MANDATORY BRAND COLORS — the brand's palette is ${palette}. EVERY colored surface on the canvas (pill CTA fills, icon stickers, label backgrounds, gradient stops, ambient lighting tone, decorative accents, visible brand surfaces like aprons / signage / uniforms / objects, Hebrew text accent words) MUST be drawn ONLY from this exact palette plus neutral white/cream/charcoal supports. Do NOT default to beige/taupe/off-white/generic muted neutrals when the brand colors above are vivid.
FORBIDDEN OFF-PALETTE COLORS (unless the hex above literally contains them) — pink, magenta, coral, salmon, peach, lavender, mint, sky-blue, mustard, yellow, pastel rainbow gradients. Picking any of these for a pill / icon / gradient when the brand palette doesn't include them is the most common failure mode of this pipeline — DO NOT do it. If a layout instruction below mentions a color word, treat it as a slot to FILL with the closest brand-palette color, never as a literal hue.
CRITICAL — the hex codes above are INSTRUCTIONS for YOU, not content to render. NEVER draw the hex strings (#F4F4F4, etc.) on the canvas. NEVER draw color swatches, palette legends, or design-spec bars anywhere.`
    : "Natural palette, harmonious tones suitable for the business field.";

  const sceneNote = ctx.hasScene
    ? `MANDATORY: A real photo from the client's actual business is attached as visual reference. Generate the post IN THE SAME WORLD as that reference — same locations, same products, same era, same kind of subject. The reference IS the source of truth for what this business looks like; do not invent a generic stock scene.`
    : "Generate a scene that authentically reflects what this business actually shows in real life — based on its field and description.";

  /* When the manager bound this slot to a specific service, the image MUST
     showcase that service. Otherwise the AI has freedom to choose the angle. */
  const slotBoundService = ctx.slotService;
  const slotNote = slotBoundService
    ? `\nThis post is bound to a specific service. Showcase: "${slotBoundService.title || ""}"${slotBoundService.description ? ` — ${slotBoundService.description}` : ""}${slotBoundService.imageUrl ? " (a reference photo of the service is attached separately if available)" : ""}.`
    : "";

  /* Avatar / presenter — when present, override the "no human faces" rule. */
  const avatarLine = ctx.avatarLine || "";
  const facesRule = ctx.avatarLine
    ? "- The recurring presenter described above MAY appear with a clear face — keep their look identical across all 5 posts."
    : "- NO HUMAN FACES (hands / silhouettes / back-of-head OK).";

  return `You are a premium Instagram content designer. Write ONE single-line English prompt for Gemini Image to produce a 1024×1024 ORGANIC VALUE-FIRST Instagram post with Hebrew text overlays.

About the business:
- Name: ${ctx.businessName || "—"}
- Field: ${ctx.businessField || "—"}
- About: ${ctx.about || "—"}
- Services context: ${ctx.servicesAndDeals}

Post type: ${post.type}   // tip / story / behind / testimonial / question
Mood: useful, curiosity-driven, scroll-stopping, premium organic feel — never aggressive ad
${slotNote}
${avatarLine}

${sceneNote}

The visual MUST authentically depict what this business does in the real world. Examples:
- Travel / tourism business → real destinations, European streets, real cafes, real landmarks
- Bakery / food → real pastry shots, real kitchen scenes
- Clinic / wellness → calm real consultation rooms or treatments
- Beauty / salon → real hands at work, real product details
- Home goods → real interiors styled like the brand
Use the reference photo to lock the subject — do not drift into unrelated lifestyle stock.

Visual quality bar:
- Premium organic Instagram feed aesthetic (NOT a paid ad banner)
- Strong headline as the main visual hook — value-first ("5 things…", "How to…", "Why…", "Before / After", "Signs that…", "Most people don't know…" when matching the post)
- Real / editorial photography or clean illustrated background — never generic stock
- Sharp focal point, intentional negative space, rule-of-thirds
- Clean spacing, mobile-first readability, no clutter, no decorative thin divider lines

Type-specific direction:
- tip          → useful card layout with strong headline + 1–3 short supporting blocks
- story        → real moment grounded in the business's environment
- behind       → wide candid shot of the actual workspace / location / tools
- testimonial  → calm composition with the quote as the hero text
- question     → conceptual minimalist crop with a curiosity-headline overlay

Design context: ${ctx.designStyle || "warm minimal"}
${colorNote}

Strict rules:
- Output ONE single-line prompt, no quotes, no \\n, no commentary.
${facesRule}
- NO generic stock cliches (laptop in café, headset call-center, fake handshakes, fake handshake stock).
- NO numbered bullets, NO thin horizontal divider lines.
- The Hebrew headline / body / cta will be enforced separately — do NOT translate or paraphrase them.`;
}

/* ──────────────────────────────────────────────────────────────────── */

async function generatePostsTexts(brief, count = 5) {
  const businessProfileShort = [
    brief.businessName && `שם: ${brief.businessName}`,
    brief.businessField && `תחום: ${brief.businessField}`,
    brief.about && `על העסק: ${brief.about}`,
    brief.targetAudience?.length && `קהל יעד: ${brief.targetAudience.join(", ")}`,
  ].filter(Boolean).join("\n");

  const servicesAndDeals = brief.services || "—";

  /* Translate the manager's organic planner into per-slot directives.
     We cap slots at the count so we never demand more directives than
     posts we'll generate. */
  const slotPlan = (brief.organicSlots || []).slice(0, count)
    .map(slot => describeSlot(slot, brief.servicesArr));

  const { getLang } = require("./ad-languages.service");
  const _L = getLang(brief.language);
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: _L.code === "he"
        ? `You are an authentic Israeli social media manager. Always respond with valid JSON containing a 'posts' array of ${count} items.`
        : `You are an authentic native ${_L.name} social media manager. Write ALL post copy in ${_L.name} only. Always respond with valid JSON containing a 'posts' array of ${count} items.` },
      { role: "user",   content: buildPostsTextPrompt({ businessProfileShort, servicesAndDeals, slotPlan, hasAvatar: !!brief.avatar, count, language: brief.language }) },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const posts = Array.isArray(parsed.posts) ? parsed.posts : Array.isArray(parsed) ? parsed : [];
  if (posts.length < count) throw new Error(`OpenAI returned only ${posts.length} posts, expected ${count}`);
  return { posts: posts.slice(0, count), servicesAndDeals };
}

async function generateNanoPrompt(post, ctx) {
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "Output a single-line English image prompt only." },
      { role: "user",   content: buildNanoPromptPrompt(post, ctx) },
    ],
  });
  const raw = (completion.choices[0]?.message?.content || "").trim().replace(/[\r\n]+/g, " ");
  /* Same enforcement as the batch path — quote the exact Hebrew copy,
     ground the image subject in the body text + business field, and
     enable the logo directive only when a logo buffer is present. */
  return wrapWithHebrewDirective(raw, post, {
    businessField:    ctx?.businessField,
    about:            ctx?.about,
    hasLogo:          !!ctx?.hasLogo,
    preferredColors:  ctx?.preferredColors,
    language:         ctx?.language,
  });
}

/**
 * One-shot batch image-prompt builder. Runs the new value-first system
 * prompt against ALL posts in a single OpenAI call. Returns an array of
 * `{ prompt, title, body, cta, address, post_type, upload_url }`
 * aligned 1:1 with the input `posts`. fileNames must be precomputed
 * and ordered the same as posts so the model can stitch them onto
 * `upload_url`.
 *
 * On parse failure or count mismatch the caller is expected to fall
 * back to the per-post `generateNanoPrompt` path so the pipeline still
 * produces images rather than failing outright.
 */
async function generateNanoPromptsBatch({ posts, ctx, brief, fileNames }) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  const userMessage = buildOrganicBatchUserMessage(posts, ctx, brief, fileNames);
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ORGANIC_PROMPT_BUILDER_SYSTEM },
      { role: "user",   content: userMessage },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`organic batch JSON parse failed: ${err.message}`); }
  const items = Array.isArray(parsed?.items) ? parsed.items
              : Array.isArray(parsed)         ? parsed
              : null;
  if (!items) throw new Error("organic batch response had no array");
  if (items.length < posts.length) {
    throw new Error(`organic batch returned ${items.length}/${posts.length} prompts`);
  }
  /* Normalize: trim prompt, collapse any sneaky newlines, then DETERMINISTICALLY
     append the Hebrew text-rendering directive bound to the EXACT input strings
     (OpenAI's freeform prompt doesn't reliably quote the Hebrew copy verbatim,
     so without this wrapper Gemini invents English testimonial text). */
  return items.slice(0, posts.length).map((it, i) => {
    const rawPrompt = String(it.prompt || "").trim().replace(/[\r\n]+/g, " ");
    const wrapped   = wrapWithHebrewDirective(rawPrompt, posts[i], {
      businessField:    ctx?.businessField,
      about:            ctx?.about,
      hasLogo:          !!ctx?.hasLogo,
      preferredColors:  ctx?.preferredColors,
      language:         brief?.language || ctx?.language,
    });
    return {
      prompt:      wrapped,
      title:       String(it.title || ""),
      body:        String(it.body  || ""),
      cta:         String(it.cta   || ""),
      address:     String(it.address   || ""),
      post_type:   String(it.post_type || ""),
      upload_url:  String(it.upload_url || ""),
    };
  });
}

/* Resolve a stored asset (proxy URL, full URL, B2 path, or data: URL) to a Buffer. */
async function fetchAssetBuffer(ref) {
  if (!ref || typeof ref !== "string") return null;
  try {
    if (ref.startsWith("data:")) {
      const commaIdx = ref.indexOf(",");
      if (commaIdx === -1) return null;
      return Buffer.from(ref.slice(commaIdx + 1), "base64");
    }
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
    const cleanPath = ref.replace(/^\/+/, "");
    const { buffer } = await backblazeService.downloadImageByPath(cleanPath);
    return buffer;
  } catch (err) {
    console.warn(`[wow-organic-ads] fetchAssetBuffer failed for ${ref.substring(0, 80)}:`, err.message);
    return null;
  }
}

/* Lightweight MIME sniff for the toFile helper — OpenAI's images.edit
   API requires a content-type per attached file. The previous Gemini
   path used hardcoded image/png + image/jpeg; reading the magic bytes
   keeps us correct when a manager uploads a webp logo, etc. */
function detectMime(buf) {
  if (!buf || buf.length < 4) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[4] === 0x57) return "image/webp";
  return "image/jpeg";
}

/**
 * Single OpenAI image-generation call for organic posts. Uses
 * images.edit when references (logo + client scene) are attached,
 * otherwise images.generate.
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
 * Generate a single 1024×1024 organic post image.
 *
 * Model cascade (OpenAI):
 *   Primary:  OPENAI_IMAGE_MODEL          (default: gpt-image-2)
 *   Fallback: OPENAI_FALLBACK_IMAGE_MODEL (default: gpt-image-1)
 *
 * Attachment order: client scene photo FIRST (grounds the post in the
 * actual business), logo LAST (so the prompt's "last reference is the
 * brand logo" hint binds correctly).
 */
async function generatePostImageBuffer(prompt, sceneBuffer = null, logoBuffer = null) {
  const refs = [];
  if (sceneBuffer) refs.push(await toFile(sceneBuffer, "scene.png", { type: detectMime(sceneBuffer) }));
  if (logoBuffer)  refs.push(await toFile(logoBuffer,  "logo.png",  { type: detectMime(logoBuffer)  }));

  const mode = refs.length > 0 ? "EDIT" : "GENERATE";
  const refInfo = refs.length > 0
    ? `${sceneBuffer ? "scene" : ""}${sceneBuffer && logoBuffer ? " + " : ""}${logoBuffer ? "logo" : ""}`
    : "text-only";

  async function tryModel(model) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[wow-organic-ads] ${model} ${mode} (${refInfo}) — attempt ${attempt}`);
        const raw = await callImageModel({ model, prompt, refs });
        /* Resize as a safety net — OpenAI already returns the requested
           size but a cover-crop from center keeps the text-safe zone intact
           if the model ever returns an off-ratio image. */
        return await sharp(raw)
          .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "center" })
          .png()
          .toBuffer();
      } catch (err) {
        const wait = [800, 2400, 5200][attempt - 1] || 1500;
        console.warn(`[wow-organic-ads] ${model} attempt ${attempt} failed: ${err.message}`);
        if (attempt >= 3) throw err;
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  /* PRIMARY: Gemini gemini-3-pro-image-preview (scene + logo as refs); the
     OpenAI gpt-image-2 cascade is the fallback if Gemini errors/has an outage. */
  const geminiRefs = [...(sceneBuffer ? [sceneBuffer] : []), ...(logoBuffer ? [logoBuffer] : [])];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[wow-organic-ads] gemini ${GEMINI_IMG_MODEL} ${mode} (${refInfo}) — attempt ${attempt}`);
      const raw = await geminiGenerateImage(prompt, geminiRefs);
      return await sharp(raw).resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "center" }).png().toBuffer();
    } catch (err) {
      console.warn(`[wow-organic-ads] gemini attempt ${attempt} failed: ${err.message}`);
      if (attempt >= 3) break;
      await new Promise(r => setTimeout(r, [800, 2400, 5200][attempt - 1] || 1500));
    }
  }
  console.warn(`[wow-organic-ads] Gemini exhausted — falling back to OpenAI ${OPENAI_IMAGE_MODEL}`);
  try {
    return await tryModel(OPENAI_IMAGE_MODEL);
  } catch (primaryErr) {
    console.warn(`[wow-organic-ads] OpenAI ${OPENAI_IMAGE_MODEL} exhausted — falling back to ${OPENAI_FALLBACK_IMAGE_MODEL}`);
    return await tryModel(OPENAI_FALLBACK_IMAGE_MODEL);
  }
}

/* ──────────────────────────────────────────────────────────────────── */

async function runOrganicAdsPipeline(sessionId, phone, brief, quota = 5) {
  /* Clamp to a sane range — same envelope as wow-ads. */
  const targetCount = Math.min(Math.max(parseInt(quota, 10) || 5, 1), 30);

  /* Idempotent upsert: state fields go through $setOnInsert so a re-entry
     after a server restart doesn't clobber in-flight progress. brief and
     updatedAt always refresh. See wow-ads.service for the rationale. */
  await sessionsCol().updateOne(
    { sessionId },
    {
      $setOnInsert: {
        sessionId, phone,
        status: "generating_texts",
        packageId: brief?.packageId || null,
        generatedPosts: [],
        totalPosts: targetCount,
        completedCount: 0,
        productStatus:          "sent_for_creation",
        productStatusUpdatedAt: new Date(),
        createdAt: new Date(),
      },
      $set: { brief, updatedAt: new Date() },
    },
    { upsert: true }
  );

  const existing = await sessionsCol().findOne({ sessionId });
  const existingPosts = Array.isArray(existing?.generatedPosts) ? existing.generatedPosts : [];

  try {
    /* Step 1 — texts. Resume-safe: reuse existing texts if present. */
    let posts, servicesAndDeals;
    if (existingPosts.length >= targetCount) {
      console.log(`[wow-organic-ads] ${sessionId} resume — reusing ${existingPosts.length} existing post texts`);
      posts = existingPosts;
      servicesAndDeals = brief.services || "";
    } else {
      ({ posts, servicesAndDeals } = await generatePostsTexts(brief, targetCount));
    }
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { generatedPosts: posts, status: "generating_prompts", updatedAt: new Date() } }
    );

    /* Pre-load client photos so Gemini can use them as scene reference
       (otherwise the AI defaults to generic stock-looking lifestyle shots). */
    const imageBuffers = [];
    for (const url of (brief.images || []).slice(0, 5)) {
      const buf = await fetchAssetBuffer(url);
      if (buf) imageBuffers.push(buf);
    }
    console.log(`[wow-organic-ads] ${sessionId}: loaded ${imageBuffers.length} client scene refs`);

    /* Pre-load the brand logo (if any). Attaching it as inline image data
       to every Gemini call lets the model render the actual logo into the
       composition rather than inventing a fake brand mark — same pattern
       wow-ads uses. Soft fail: if the fetch errors, we just skip the logo. */
    const logoBuffer = brief.logoUrl ? await fetchAssetBuffer(brief.logoUrl) : null;
    if (brief.logoUrl && !logoBuffer) {
      console.warn(`[wow-organic-ads] ${sessionId}: logo fetch failed for ${brief.logoUrl} — generating without logo`);
    } else if (logoBuffer) {
      console.log(`[wow-organic-ads] ${sessionId}: logo loaded for Gemini attachment`);
    }

    const baseCtx = {
      designStyle: brief.designStyle,
      preferredColors: brief.preferredColors,
      hasScene: imageBuffers.length > 0,
      hasLogo: !!logoBuffer,
      servicesAndDeals,
      businessName:  brief.businessName,
      businessField: brief.businessField,
      about:         brief.about,
      language:      brief.language,
      avatarLine:    describeAvatar(brief.avatar),
    };

    /* Step 2 — image prompts via the new value-first batch builder.
       One OpenAI call processes ALL posts together so cross-post variety,
       brand tone, and color/logo handling stay coherent. The per-post
       parallel path is kept as a soft fallback in case the batch call
       fails to parse or returns the wrong shape — we never want this
       step to be the reason the pipeline halts. */
    const slots = (brief.organicSlots || []);
    const servicesArr = brief.servicesArr || [];
    const filePaths = posts.map(p =>
      `wow-organic-ads/${phone}/${sessionId}/post_${p.id}.png`,
    );

    let prompts = {};
    /* Resume-safe: posts that already have a nanoPrompt keep theirs. We
       only run the batch/per-post builder if at least one prompt is missing. */
    for (const p of posts) {
      if (p.nanoPrompt) prompts[p.id] = p.nanoPrompt;
    }
    const havePrompts = Object.keys(prompts).length;
    if (havePrompts === posts.length) {
      console.log(`[wow-organic-ads] ${sessionId} resume — all ${posts.length} nano prompts already present`);
    } else {
      if (havePrompts > 0) {
        console.log(`[wow-organic-ads] ${sessionId} resume — ${havePrompts}/${posts.length} prompts present, generating remaining`);
      }
      let batchOk = false;
      try {
        const batch = await generateNanoPromptsBatch({
          posts,
          ctx:   baseCtx,
          brief,
          fileNames: filePaths,
        });
        batch.forEach((row, i) => {
          const post = posts[i];
          if (row?.prompt && post && !prompts[post.id]) prompts[post.id] = row.prompt;
        });
        batchOk = Object.keys(prompts).length === posts.length;
        console.log(`[wow-organic-ads] ${sessionId}: batch prompts ok=${batchOk} (${Object.keys(prompts).length}/${posts.length})`);
      } catch (err) {
        console.warn(`[wow-organic-ads] ${sessionId}: batch prompts failed (${err.message}) — falling back to per-post`);
      }

      if (!batchOk) {
        /* Fallback — original parallel per-post builder. Keeps a working
           output if the batch builder is rate-limited / mal-formed. Only
           runs for posts that don't already have a prompt. */
        const missing = posts.filter(p => !prompts[p.id]);
        if (missing.length > 0) {
          const promptResults = await Promise.allSettled(
            missing.map((p) => {
              const i = posts.findIndex(pp => pp.id === p.id);
              const slot = slots[i];
              const slotService = slot?.serviceId ? servicesArr.find(s => s.id === slot.serviceId) : null;
              const ctx = { ...baseCtx, slotService };
              return generateNanoPrompt(p, ctx).then(prompt => ({ id: p.id, prompt }));
            })
          );
          for (const r of promptResults) {
            if (r.status === "fulfilled") prompts[r.value.id] = r.value.prompt;
          }
        }
      }
    }
    const postsWithPrompts = posts.map(p => ({ ...p, nanoPrompt: prompts[p.id] || p.nanoPrompt || null }));
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { generatedPosts: postsWithPrompts, status: "generating_images", updatedAt: new Date() } }
    );

    /* Pre-load avatar inspiration + per-service image buffers (used as
       additional scene refs when a slot is bound to a specific service). */
    const avatarRefBuffer = brief.avatar?.inspirationUrl ? await fetchAssetBuffer(brief.avatar.inspirationUrl) : null;
    const serviceImageCache = new Map();
    for (const svc of servicesArr) {
      // imageUrl is the primary; fall back to images[0] (app-uploaded service
      // photos land in services[].images[] and may not have synced imageUrl).
      const svcRef = svc.imageUrl
        || (Array.isArray(svc.images) ? svc.images.find(u => typeof u === "string" && u.length > 0) : null);
      if (svcRef && !serviceImageCache.has(svc.id)) {
        const b = await fetchAssetBuffer(svcRef);
        if (b) serviceImageCache.set(svc.id, b);
      }
    }

    /* Step 3 — images sequentially, rotating through client scenes.
       Resume-safe: posts that already have imageUrl are skipped. After a
       server restart mid-session the loop picks up exactly where it left off. */
    for (let i = 0; i < postsWithPrompts.length; i++) {
      const post = postsWithPrompts[i];
      if (post.imageUrl) {
        console.log(`[wow-organic-ads] ${sessionId} skip post ${post.id} — imageUrl already present (resume)`);
        continue;
      }
      if (!post.nanoPrompt) {
        post.error = "no nano prompt";
      } else {
        try {
          /* Compose the visual references we feed Gemini for this slot. Order
             matters — the first attached image gets the most weight. */
          const slot = slots[i];
          const slotServiceBuf = slot?.serviceId ? serviceImageCache.get(slot.serviceId) : null;
          const fallbackScene = imageBuffers.length > 0 ? imageBuffers[i % imageBuffers.length] : null;
          const sceneBuffer = slotServiceBuf || fallbackScene || avatarRefBuffer;
          const buf = await generatePostImageBuffer(post.nanoPrompt, sceneBuffer, logoBuffer);
          const fullPath = `wow-organic-ads/${phone}/${sessionId}/post_${post.id}.png`;
          await uploadImage(fullPath, buf, "image/png");
          post.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
        } catch (err) {
          post.error = err.message || "image generation failed";
        }
      }
      await sessionsCol().updateOne(
        { sessionId },
        {
          $set: {
            generatedPosts: postsWithPrompts,
            completedCount: postsWithPrompts.filter(p => p.imageUrl).length,
            updatedAt: new Date(),
          },
        }
      );
      await new Promise(r => setTimeout(r, 1000));
    }

    /* Step 4 — auto-generate Instagram/Facebook post bodies for every
       post that ended up with an image. Same parallel-with-soft-fail
       pattern as wow-ads. Manager doesn't have to click "צור תיאור
       פרסומי" anymore — it's there from the start. */
    const promoTargets = postsWithPrompts.filter(p => p.imageUrl);
    if (promoTargets.length > 0) {
      console.log(`[wow-organic-ads] ${sessionId}: auto-generating ${promoTargets.length} promotion descriptions`);
      const promoResults = await Promise.allSettled(
        promoTargets.map(p => generatePostPromotionDescription(sessionId, p.id, brief)),
      );
      const promoFailed = promoResults.filter(r => r.status === "rejected").length;
      if (promoFailed > 0) {
        console.warn(`[wow-organic-ads] ${sessionId}: ${promoFailed}/${promoTargets.length} promo generations failed`);
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
    console.error(`[wow-organic-ads] pipeline failed for ${sessionId}:`, err);
    // OpenAI out-of-credit (429) → park as "waiting_credits" (client data kept on
    // the session) so the credit watchdog resumes it when credits return.
    const quotaBlocked = isQuotaError(err);
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { status: quotaBlocked ? "waiting_credits" : "error", error: err.message || "unknown error", updatedAt: new Date() } }
    );
    if (quotaBlocked) console.log(`[wow-organic-ads:credit] ${sessionId} (${phone}) parked → waiting_credits (OpenAI quota)`);
  }
}

async function regenerateSinglePost(sessionId, postId) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error("post not found");

  // Re-fetch the client photos used by the original pipeline so the
  // regenerated post stays cohesive with the rest of the set.
  const briefImages = Array.isArray(sess.brief?.images) ? sess.brief.images.slice(0, 5) : [];
  const imageBuffers = [];
  for (const url of briefImages) {
    const buf = await fetchAssetBuffer(url);
    if (buf) imageBuffers.push(buf);
  }

  if (!post.nanoPrompt) {
    /* Use the new value-first batch builder for a single post too —
       keeps regenerate aligned with the initial run's voice. Falls
       back to the per-post builder if the batch call fails. */
    const singleCtx = {
      designStyle: sess.brief?.designStyle,
      preferredColors: sess.brief?.preferredColors,
      hasScene: imageBuffers.length > 0,
      servicesAndDeals: sess.brief?.services || "",
      businessName:  sess.brief?.businessName,
      businessField: sess.brief?.businessField,
      about:         sess.brief?.about,
      language:      sess.brief?.language,
    };
    const filePath = `wow-organic-ads/${sess.phone}/${sessionId}/post_${postId}_${Date.now()}.png`;
    try {
      const [row] = await generateNanoPromptsBatch({
        posts: [post],
        ctx:   singleCtx,
        brief: sess.brief || {},
        fileNames: [filePath],
      });
      if (row?.prompt) post.nanoPrompt = row.prompt;
    } catch (err) {
      console.warn(`[wow-organic-ads] regenerate ${sessionId}#${postId}: batch failed (${err.message}) — per-post fallback`);
    }
    if (!post.nanoPrompt) {
      post.nanoPrompt = await generateNanoPrompt(post, singleCtx);
    }
  }

  // Same scene rotation as the original run so post #N keeps its scene
  const idx = sess.generatedPosts.findIndex(p => Number(p.id) === Number(postId));
  const sceneBuffer = imageBuffers.length > 0 ? imageBuffers[idx % imageBuffers.length] : null;
  const logoBuffer  = sess.brief?.logoUrl ? await fetchAssetBuffer(sess.brief.logoUrl) : null;

  const buf = await generatePostImageBuffer(post.nanoPrompt, sceneBuffer, logoBuffer);
  const fullPath = `wow-organic-ads/${sess.phone}/${sessionId}/post_${postId}_${Date.now()}.png`;
  await uploadImage(fullPath, buf, "image/png");

  post.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
  post.regeneratedAt = new Date().toISOString();

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );

  return post;
}

/* If a server restart killed an async pipeline, the session is stuck at a
   non-terminal status forever. Auto-flip to "error" once it looks abandoned
   so the UI shows the regenerate button instead of polling forever. */
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 min — way longer than a healthy run
async function autoFailIfStuck(sess) {
  if (!sess || sess.status === "done" || sess.status === "error") return sess;
  const lastTouch = sess.updatedAt ? new Date(sess.updatedAt).getTime() : 0;
  if (Date.now() - lastTouch < STUCK_THRESHOLD_MS) return sess;

  const reason = "תהליך הייצור נתקע (כנראה השרת התרענן באמצע). לחץ 'ייצר מחדש'.";
  console.warn(`[wow-organic-ads] auto-failing stuck session ${sess.sessionId} (status=${sess.status})`);
  await sessionsCol().updateOne(
    { sessionId: sess.sessionId },
    { $set: { status: "error", error: reason, updatedAt: new Date() } }
  );
  return { ...sess, status: "error", error: reason };
}

async function getLatestSessionForPhone(phone) {
  const sess = await sessionsCol().find({ phone }).sort({ createdAt: -1 }).limit(1).next();
  return autoFailIfStuck(sess);
}

/* ─────── Carousel post pipeline ─────── */

function buildCarouselTextPrompt({ businessProfileShort, servicesAndDeals }) {
  return `תפקידך:
אתה מנהל סושיאל אותנטי לעסקים בישראל. אתה כותב פוסט קרוסלה לאינסטגרם — סדרה של 3 שקופיות שמספרות סיפור אחד יחד.

📥 נתונים:
איפיון עסק:
${businessProfileShort}

שירותים ומבצעים (לרקע בלבד — לא פרסומי):
${servicesAndDeals}

🎯 המשימה:
ליצור פוסט קרוסלה אחד עם 3 שקופיות. הקרוסלה צריכה לגרום לקורא להחליק ל-slide הבא (curiosity gap, cliffhanger, רצף הגיוני).

החזר JSON תקני בלבד:

{
  "headline": "כותרת ראשית של הקרוסלה (עד 8 מילים)",
  "description": "טקסט קצר ל-caption של הפוסט (2-3 משפטים, אותנטי, לא פרסומי)",
  "cta": "הזמנה עדינה לפעולה (3-4 מילים)",
  "slides": [
    {
      "id": 1,
      "title": "כותרת לשקופית 1 (עד 6 מילים)",
      "body":  "1-2 שורות גוף לשקופית — מציג את הבעיה / הקרס",
      "sceneHint": "תיאור באנגלית של מה התמונה צריכה להראות (ויעבור ל-Gemini)"
    },
    {
      "id": 2,
      "title": "כותרת לשקופית 2",
      "body":  "1-2 שורות — הופכים את הקלף, מספקים את הערך",
      "sceneHint": "..."
    },
    {
      "id": 3,
      "title": "כותרת לשקופית 3",
      "body":  "1-2 שורות — סיכום + רמיזה ל-CTA",
      "sceneHint": "..."
    }
  ]
}

חוקים:
- בעברית בלבד (חוץ מ-sceneHint שבאנגלית)
- כל slide חייב לעמוד גם לבד אבל יחד הן בונות סיפור
- הימנע מפרסום ישיר — זה אורגני
- אסור Markdown או הסברים — JSON תקני בלבד`;
}

async function generateCarouselPost(sessionId, phone, brief) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const businessProfileShort = [
    brief.businessName && `שם: ${brief.businessName}`,
    brief.businessField && `תחום: ${brief.businessField}`,
    brief.about && `על העסק: ${brief.about}`,
    brief.targetAudience?.length && `קהל יעד: ${brief.targetAudience.join(", ")}`,
  ].filter(Boolean).join("\n");

  const servicesAndDeals = brief.services || "—";

  // Step 1 — Generate carousel text + slide structure
  const completion = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are an authentic Israeli social media manager creating Instagram carousel posts. Always respond with valid JSON containing 'headline', 'description', 'cta' and a 'slides' array of 3 objects." },
      { role: "user",   content: buildCarouselTextPrompt({ businessProfileShort, servicesAndDeals }) },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.slides) || parsed.slides.length < 2) {
    throw new Error("OpenAI did not return a valid 3-slide carousel");
  }
  const slidesData = parsed.slides.slice(0, 3);

  // Step 2 — Pre-load client photos (same scene rotation as singles)
  const imageBuffers = [];
  for (const url of (brief.images || []).slice(0, 5)) {
    const buf = await fetchAssetBuffer(url);
    if (buf) imageBuffers.push(buf);
  }
  const logoBuffer = brief.logoUrl ? await fetchAssetBuffer(brief.logoUrl) : null;

  // Step 3 — Per-slide nano prompt + image
  const ctx = {
    designStyle: brief.designStyle,
    preferredColors: brief.preferredColors,
    hasScene: imageBuffers.length > 0,
    hasLogo: !!logoBuffer,
    servicesAndDeals,
    businessName: brief.businessName,
    businessField: brief.businessField,
    about: brief.about,
    language: brief.language,
  };

  // Allocate the next post id (one above current max)
  const nextId = (sess.generatedPosts || []).reduce((m, p) => Math.max(m, p.id || 0), 0) + 1;

  const slidesOut = [];
  for (let i = 0; i < slidesData.length; i++) {
    const slide = slidesData[i];
    // Use slide-specific scene hint to enrich the nano prompt
    const slidePost = {
      type: "carousel",
      headline: slide.title || parsed.headline || "",
      description: slide.body || "",
    };
    const nanoSeed = await generateNanoPrompt(slidePost, ctx);
    const nanoPrompt = slide.sceneHint
      ? `${nanoSeed} Slide-specific scene direction: ${slide.sceneHint}`
      : nanoSeed;
    const sceneBuffer = imageBuffers.length > 0 ? imageBuffers[i % imageBuffers.length] : null;

    let imageUrl;
    let error;
    try {
      const buf = await generatePostImageBuffer(nanoPrompt, sceneBuffer, logoBuffer);
      const fullPath = `wow-organic-ads/${phone}/${sessionId}/carousel_${nextId}_slide_${slide.id || i + 1}.png`;
      await uploadImage(fullPath, buf, "image/png");
      imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
    } catch (err) {
      error = err.message || "image generation failed";
    }
    slidesOut.push({
      id: slide.id || i + 1,
      title: slide.title || "",
      body:  slide.body || "",
      nanoPrompt,
      imageUrl,
      error,
    });
    await new Promise(r => setTimeout(r, 800));
  }

  const carouselPost = {
    id: nextId,
    type: "carousel",
    headline:    parsed.headline || "",
    description: parsed.description || "",
    cta:         parsed.cta || "",
    slides:      slidesOut,
    createdAt:   new Date().toISOString(),
  };

  const updated = [...(sess.generatedPosts || []), carouselPost];
  await sessionsCol().updateOne(
    { sessionId },
    {
      $set: {
        generatedPosts: updated,
        totalPosts: updated.length,
        completedCount: updated.filter(p => p.imageUrl || (Array.isArray(p.slides) && p.slides.some(s => s.imageUrl))).length,
        updatedAt: new Date(),
      },
    }
  );

  return carouselPost;
}

async function regenerateCarouselSlide(sessionId, postId, slideId) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const post = (sess.generatedPosts || []).find(p => Number(p.id) === Number(postId));
  if (!post || post.type !== "carousel") throw new Error("carousel post not found");
  const slide = (post.slides || []).find(s => Number(s.id) === Number(slideId));
  if (!slide) throw new Error("slide not found");

  const briefImages = Array.isArray(sess.brief?.images) ? sess.brief.images.slice(0, 5) : [];
  const imageBuffers = [];
  for (const url of briefImages) {
    const buf = await fetchAssetBuffer(url);
    if (buf) imageBuffers.push(buf);
  }
  const idx = post.slides.findIndex(s => Number(s.id) === Number(slideId));
  const sceneBuffer = imageBuffers.length > 0 ? imageBuffers[idx % imageBuffers.length] : null;
  const logoBuffer  = sess.brief?.logoUrl ? await fetchAssetBuffer(sess.brief.logoUrl) : null;

  const buf = await generatePostImageBuffer(slide.nanoPrompt, sceneBuffer, logoBuffer);
  const fullPath = `wow-organic-ads/${sess.phone}/${sessionId}/carousel_${postId}_slide_${slideId}_${Date.now()}.png`;
  await uploadImage(fullPath, buf, "image/png");
  slide.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
  slide.regeneratedAt = new Date().toISOString();
  delete slide.error;

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );
  return post;
}

/* ─────── Edit / Approval workflow (manager → client) ─────── */

/**
 * Generate a rich, promotion-ready Hebrew description for a single
 * organic post. Same contract as wow-ads' generatePromotionDescription:
 * uses the on-image text as a seed, expands it into a 4-6 line Meta /
 * Instagram / Facebook post body, saved as post.promotionDescription.
 * The original on-image text is untouched.
 */
function buildPostPromotionCopyPrompt({ post, businessName, businessField, services, targetAudience }) {
  return `אתה מנהל סושיאל אותנטי. כתוב טקסט פוסט אורגני בעברית ל-"${businessName || "העסק"}" שמתלווה לתמונה — לא פרסומי, לא דחוף, לא קליפ-בייט.

הטקסט שכבר נמצא על התמונה (אל תחזור עליו מילה במילה):
- כותרת: "${post.headline || ""}"
- תיאור קצר: "${post.description || ""}"
- CTA עדין: "${post.cta || ""}"

הקשר העסק:
${businessField ? `- תחום: ${businessField}` : ""}
${services ? `- שירותים: ${services}` : ""}
${targetAudience ? `- קהל יעד: ${targetAudience}` : ""}

החזר טקסט פוסט מוכן להעתקה ל-Instagram / Facebook באורך 4-6 שורות, מבנה אורגני (לא פרסומי):
1. שורת פתיחה אישית/אנושית — שאלה, אנקדוטה, התרשמות. בלי buzzwords
2. 2-3 שורות שמספרות סיפור, חולקות ערך, או מציגות נקודת מבט — בגוף ראשון
3. סיום עם שאלה לקהילה או הזמנה עדינה לשיח
4. 3-5 האשטגים בסיום, רלוונטיים לתחום

חוקים:
- בעברית בלבד, טון אישי, חברי, אותנטי
- בלי "אצלנו תמצאו" / "אנחנו מציעים" / "השאר פרטים" / "הזמן עכשיו"
- אל תחזור על הכותרת מהתמונה
- אמוג'י 1-3 בסה"כ, רק אם מתאים לטון
- ללא Markdown, ללא **bold**, ללא קישורים

החזר רק את הטקסט, ללא הסברים, ללא כותרת, ללא ציטוט.`;
}

async function generatePostPromotionDescription(sessionId, postId, brief) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error("post not found");

  const completion = await chatComplete({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "אתה כותב סושיאל ישראלי אותנטי. החזר טקסט פוסט בעברית בלבד, ללא הסברים, ללא כותרת." },
      { role: "user",   content: buildPostPromotionCopyPrompt({
          post,
          businessName:   brief?.businessName,
          businessField:  brief?.businessField,
          services:       brief?.services,
          targetAudience: Array.isArray(brief?.targetAudience) ? brief.targetAudience.join(", ") : brief?.targetAudience,
        }) },
    ],
  });

  const text = (completion.choices[0]?.message?.content || "").trim();
  if (!text) throw new Error("OpenAI returned empty promotion text");

  const generatedAt = new Date().toISOString();
  /* Per-element update via positional $ — race-safe when N of these run
     in parallel (auto-generation phase at the end of the pipeline). */
  await sessionsCol().updateOne(
    { sessionId, "generatedPosts.id": Number(postId) },
    {
      $set: {
        "generatedPosts.$.promotionDescription":            text,
        "generatedPosts.$.promotionDescriptionGeneratedAt": generatedAt,
        updatedAt: new Date(),
      },
    }
  );

  post.promotionDescription            = text;
  post.promotionDescriptionGeneratedAt = generatedAt;
  return post;
}

async function updatePostText(sessionId, postId, fields) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error("post not found");

  const ALLOWED = ["headline", "description", "cta"];
  let touched = false;
  for (const k of ALLOWED) {
    if (typeof fields?.[k] === "string") { post[k] = fields[k]; touched = true; }
  }
  if (!touched) throw new Error("no editable fields supplied");
  post.editedAt = new Date().toISOString();

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );
  return post;
}

async function setManagerApprovalOnPost(sessionId, postId, approved) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error("post not found");

  if (approved) post.managerApprovedAt = new Date().toISOString();
  else delete post.managerApprovedAt;

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );
  return post;
}

async function setOrganicClientApprovalToken(sessionId) {
  const token = `wog_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

async function getOrganicSessionByClientToken(token) {
  return sessionsCol().findOne({ clientApprovalToken: token });
}

async function setOrganicClientApprovalDecision(token, decision, feedback) {
  const $set = {
    clientApprovalStatus: decision,
    clientRespondedAt: new Date(),
    updatedAt: new Date(),
  };
  if (feedback) $set.clientFeedback = feedback;
  await sessionsCol().updateOne({ clientApprovalToken: token }, { $set });
}

async function setPostImageFromUpload(sessionId, postId, buffer, mimeType) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");
  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error("post not found");

  const ext = (mimeType || "image/png").split("/")[1] || "png";
  const fullPath = `wow-organic-ads/${sess.phone}/${sessionId}/post_${postId}_uploaded_${Date.now()}.${ext}`;
  await uploadImage(fullPath, buffer, mimeType || "image/png");
  post.imageUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
  post.uploadedAt = new Date().toISOString();
  delete post.error;

  await sessionsCol().updateOne(
    { sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );
  return post;
}

async function setOrganicPostImageFromUrl(phone, postId, imageUrl) {
  const sess = await getLatestSessionForPhone(phone);
  if (!sess) throw new Error("no active organic session for this phone");
  const post = sess.generatedPosts.find(p => Number(p.id) === Number(postId));
  if (!post) throw new Error(`post ${postId} not found in session`);
  post.imageUrl = imageUrl;
  post.uploadedAt = new Date().toISOString();
  delete post.error;
  await sessionsCol().updateOne(
    { sessionId: sess.sessionId },
    { $set: { generatedPosts: sess.generatedPosts, updatedAt: new Date() } }
  );
  return post;
}

/**
 * Resume a single organic-ads session after a server restart (Heroku push,
 * dyno cycle, crash). Thin wrapper that reloads the brief from Mongo and
 * re-enters runOrganicAdsPipeline — the per-step skip-if-done checks inside
 * the pipeline handle the rest.
 */
async function resumeOrganicAdsSession(sessionId) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) {
    console.warn(`[wow-organic-ads:resume] session ${sessionId} not found`);
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
  console.log(`[wow-organic-ads:resume] resuming ${sessionId} (status=${sess.status}, posts=${sess.generatedPosts?.length || 0}/${sess.totalPosts})`);
  return runOrganicAdsPipeline(sessionId, sess.phone, sess.brief, sess.totalPosts || 5);
}

/**
 * Startup scanner — finds every organic-ads session that was mid-flight when
 * the server stopped and resumes each. Fire-and-forget per session.
 */
async function resumeStuckOrganicAdsSessions() {
  try {
    const stuck = await sessionsCol().find({
      status: { $in: ["generating_texts", "generating_prompts", "generating_images"] },
    }).toArray();
    if (stuck.length === 0) {
      console.log(`[wow-organic-ads:resume] no stuck sessions found`);
      return { resumed: 0 };
    }
    console.log(`[wow-organic-ads:resume] found ${stuck.length} stuck sessions to resume`);
    for (const sess of stuck) {
      resumeOrganicAdsSession(sess.sessionId).catch(err =>
        console.error(`[wow-organic-ads:resume] ${sess.sessionId} failed:`, err.message)
      );
    }
    return { resumed: stuck.length };
  } catch (err) {
    console.error(`[wow-organic-ads:resume] scanner failed:`, err.message);
    return { resumed: 0, error: err.message };
  }
}

module.exports = {
  runOrganicAdsPipeline,
  resumeOrganicAdsSession,
  resumeStuckOrganicAdsSessions,
  regenerateSinglePost,
  generateCarouselPost,
  regenerateCarouselSlide,
  updatePostText,
  generatePostPromotionDescription,
  setManagerApprovalOnPost,
  setOrganicClientApprovalToken,
  getOrganicSessionByClientToken,
  setOrganicClientApprovalDecision,
  setPostImageFromUpload,
  getLatestSessionForPhone,
  setOrganicPostImageFromUrl,
};
