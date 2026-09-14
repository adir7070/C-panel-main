/**
 * Post Generation — QUALITY pipeline (mobile app HQ organic/social path)
 *
 * Copied/adapted from services/wow-organic-ads.service.js (the CPANEL organic
 * pipeline). Kept independent so the mobile post-generation flow can adopt the
 * WOW-Organic image quality WITHOUT touching any wow-organic* file.
 *
 * The value-first directive (ORGANIC_PROMPT_BUILDER_SYSTEM), the per-post-type
 * design architecture (designArchitectureFor), and the Hebrew-rendering /
 * brand-color enforcement (wrapWithHebrewDirective) are copied VERBATIM from
 * wow-organic-ads.service.js — the exact wording is the quality secret and must
 * not be paraphrased or shortened.
 *
 * The gpt-image-2 image machinery is REUSED (not re-copied) from
 * ./campaign-brief-quality.js: generateAdImageBuffer (gpt-image-2 → fallback,
 * 3 attempts, finalized square PNG) + fetchAssetBuffer. Those are generic —
 * they take a prompt + logo + reference buffers and return a square image.
 *
 * Public surface:
 *   generateHqSocialPosts(input) → [{ headline, description, cta, type,
 *                                     promotionDescription, imageBuffer, error? }]
 */

const { OpenAI } = require("openai");
const { formatBrandPalette } = require("../utils/brand-palette");
const { generateAdImageBuffer, fetchAssetBuffer } = require("./campaign-brief-quality");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
// OpenAI-primary text with Gemini fallback (out-of-credit resilience):
const { chatComplete } = require("./text-gen.service");
const OPENAI_MODEL = process.env.OPENAI_ADS_MODEL || "gpt-4o";

/* ────────────────────────────────────────────────────────────────────
   1. POST TEXTS — 18 value-first post types (adapted: mobile topic block)
   ──────────────────────────────────────────────────────────────────── */

function buildPostsTextPrompt({ businessProfileShort, servicesAndDeals, topic, hasAvatar, count = 5 }) {
  const topicBlock = topic
    ? `\n🎯 נושא/זווית מרכזית (חובה — כל הפוסטים סובבים סביב מה שהלקוח ביקש):\n${topic}\n`
    : "";

  const avatarBlock = hasAvatar
    ? "\n👤 הערה: לעסק יש פרזנטור קבוע שיופיע בכל הפוסטים — שלב את הפרזנטור באופן טבעי בטקסט (לא בכוח, אלא כדמות הדוברת).\n"
    : "";

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
${topicBlock}${avatarBlock}
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
- בעברית בלבד
- הימנע מ-"השאר פרטים" / "צור קשר" / "הזמן עכשיו" — לא פרסומי
- אסור Markdown או הסברים — JSON תקני בלבד`;
}

async function generatePostsTexts(brief, count, topic) {
  const businessProfileShort = [
    brief.businessName && `שם: ${brief.businessName}`,
    brief.businessField && `תחום: ${brief.businessField}`,
    brief.about && `על העסק: ${brief.about}`,
    brief.targetAudience?.length && `קהל יעד: ${brief.targetAudience.join(", ")}`,
  ].filter(Boolean).join("\n");

  const servicesAndDeals = brief.services || "—";

  const completion = await chatComplete({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You are an authentic Israeli social media manager. Always respond with valid JSON containing a 'posts' array of ${count} items.` },
      { role: "user",   content: buildPostsTextPrompt({ businessProfileShort, servicesAndDeals, topic, hasAvatar: !!brief.avatar, count }) },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const posts = Array.isArray(parsed.posts) ? parsed.posts : Array.isArray(parsed) ? parsed : [];
  if (posts.length < count) throw new Error(`OpenAI returned only ${posts.length} posts, expected ${count}`);
  return { posts: posts.slice(0, count), servicesAndDeals };
}

/* ────────────────────────────────────────────────────────────────────
   2. NANO-PROMPT — value-first system directive (VERBATIM from wow-organic)
   ──────────────────────────────────────────────────────────────────── */

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
    "החזר JSON תקין בצורה: { \"items\": [ ... numPosts objects ... ] }",
  ].join("\n");
}

/* Per-post-type design architecture — VERBATIM from wow-organic-ads.service.js */
function designArchitectureFor(postType) {
  const t = String(postType || "").toLowerCase().trim();
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

/* Hebrew text-rendering + brand-color enforcement — VERBATIM from wow-organic */
function wrapWithHebrewDirective(promptText, post, ctx = {}) {
  const title = String(post?.headline || post?.title || "").trim();
  const body  = String(post?.description || post?.body || "").trim();
  const cta   = String(post?.cta || "").trim();
  const postType = post?.type || post?.post_type;

  const architecture = designArchitectureFor(postType);

  let subjectBlock = "";
  if (body || ctx.businessField || ctx.about) {
    const subjectPieces = [];
    if (body)              subjectPieces.push(`Hebrew body to illustrate: "${body}"`);
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
    hebrewBlock = `\n\nHEBREW TEXT — PIXEL-PERFECT RENDERING\nIMAGE MUST DISPLAY THIS HEBREW COPY VERBATIM (right-to-left, clean Hebrew sans-serif like Heebo / Assistant / Rubik, bold for the headline, high-contrast) — ${copyBlock}. Do NOT translate, paraphrase, summarise, or invent alternative text. NO English text anywhere in the image. Do NOT swap similar Hebrew letters (ב/כ, ד/ר, ה/ח, ו/ז/ן, ם/ס, ע/צ, ש/ם). Do NOT add or drop letters. Do NOT use decorative / calligraphic / script / handwritten typography — these break Hebrew rendering. If a word cannot render cleanly, DROP THE ENTIRE WORD rather than render gibberish. Mentally verify each Hebrew word matches the copy above character-by-character before output.`;
  }

  const logoBlock = ctx.hasLogo
    ? `\n\nLOGO (MANDATORY)\nThe client's brand logo is attached as a reference image. You MUST include this exact logo in every generated image. Place it in the TOP-RIGHT or TOP-LEFT corner of the canvas, sized ≈10–12% of canvas width. The logo must be clearly visible and recognizable in the final image — do NOT make it transparent, washed out, or hidden. NEVER redraw, restyle, or alter the logo — use it exactly as provided in the reference image. The logo is a required brand element and must appear in the output.`
    : "";

  const safeZoneBlock = `\n\nSAFE ZONE (CRITICAL): ALL Hebrew text — hook line, supporting lines, any UI labels — must be placed at least 90px (≈8% of canvas width) from ALL four edges of the 1080×1080 frame. The entire image must be fully self-contained within the square frame — no text, no people, no visual elements may be cropped or clipped at the frame boundary. Design with a center-weighted composition where everything is fully visible.`;

  const brandPalette = formatBrandPalette(ctx.preferredColors);
  const brandColorBlock = brandPalette
    ? `\n\nBRAND COLOR LOCK (HIGHEST PRIORITY): The brand's palette is ${brandPalette}. EVERY colored surface in this image — pill CTAs, icon stickers, label backgrounds, gradient stops, ambient lighting, accent text, brand surfaces (aprons / signage / uniforms / objects), decorative shapes — MUST use ONLY these hex values (plus neutral white / cream / charcoal as supports). FORBIDDEN OFF-PALETTE COLORS unless the hex above literally contains them: pink, magenta, coral, salmon, peach, lavender, mint, sky-blue, mustard, yellow, pastel rainbow gradients. If any earlier layout instruction names a color word (pink / blue / pastel / etc.), treat it as a SLOT and fill it with the closest matching color from the brand palette above — never with the literal hue named. NEVER draw the hex strings themselves on the canvas. NEVER draw a color-swatch / palette-legend / design-spec bar.`
    : "";

  return `${promptText}\n\n${architecture}${subjectBlock}${hebrewBlock}${logoBlock}${safeZoneBlock}${brandColorBlock}`;
}

/* Per-post fallback nano-prompt builder — VERBATIM from wow-organic-ads */
function buildNanoPromptPrompt(post, ctx) {
  const palette = formatBrandPalette(ctx.preferredColors, {
    defaults: { primary: "#1E3A8A", accent: "#10B981" },
  });
  const colorNote = palette
    ? `MANDATORY BRAND COLORS — the brand's palette is ${palette}. EVERY colored surface on the canvas (pill CTA fills, icon stickers, label backgrounds, gradient stops, ambient lighting tone, decorative accents, visible brand surfaces like aprons / signage / uniforms / objects, Hebrew text accent words) MUST be drawn ONLY from this exact palette plus neutral white/cream/charcoal supports. Do NOT default to beige/taupe/off-white/generic muted neutrals when the brand colors above are vivid.
FORBIDDEN OFF-PALETTE COLORS (unless the hex above literally contains them) — pink, magenta, coral, salmon, peach, lavender, mint, sky-blue, mustard, yellow, pastel rainbow gradients. Picking any of these for a pill / icon / gradient when the brand palette doesn't include them is the most common failure mode of this pipeline — DO NOT do it. If a layout instruction below mentions a color word, treat it as a slot to FILL with the closest brand-palette color, never as a literal hue.
CRITICAL — the hex codes above are INSTRUCTIONS for YOU, not content to render. NEVER draw the hex strings (#F4F4F4, etc.) on the canvas. NEVER draw color swatches, palette legends, or design-spec bars anywhere.`
    : "Natural palette, harmonious tones suitable for the business field.";

  const sceneNote = ctx.hasScene
    ? `MANDATORY: A real photo from the client's actual business is attached as visual reference. Generate the post IN THE SAME WORLD as that reference — same locations, same products, same era, same kind of subject. The reference IS the source of truth for what this business looks like; do not invent a generic stock scene.`
    : "Generate a scene that authentically reflects what this business actually shows in real life — based on its field and description.";

  const avatarLine = ctx.avatarLine || "";
  const facesRule = ctx.avatarLine
    ? "- The recurring presenter described above MAY appear with a clear face — keep their look identical across all posts."
    : "- NO HUMAN FACES (hands / silhouettes / back-of-head OK).";

  return `You are a premium Instagram content designer. Write ONE single-line English prompt for Gemini Image to produce a 1024×1024 ORGANIC VALUE-FIRST Instagram post with Hebrew text overlays.

About the business:
- Name: ${ctx.businessName || "—"}
- Field: ${ctx.businessField || "—"}
- About: ${ctx.about || "—"}
- Services context: ${ctx.servicesAndDeals}

Post type: ${post.type}   // tip / story / behind / testimonial / question
Mood: useful, curiosity-driven, scroll-stopping, premium organic feel — never aggressive ad
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
  return items.slice(0, posts.length).map((it, i) => {
    const rawPrompt = String(it.prompt || "").trim().replace(/[\r\n]+/g, " ");
    const wrapped   = wrapWithHebrewDirective(rawPrompt, posts[i], {
      businessField:    ctx?.businessField,
      about:            ctx?.about,
      hasLogo:          !!ctx?.hasLogo,
      preferredColors:  ctx?.preferredColors,
    });
    return { prompt: wrapped, post_type: String(it.post_type || "") };
  });
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
  return wrapWithHebrewDirective(raw, post, {
    businessField:    ctx?.businessField,
    about:            ctx?.about,
    hasLogo:          !!ctx?.hasLogo,
    preferredColors:  ctx?.preferredColors,
  });
}

/* ────────────────────────────────────────────────────────────────────
   3. PROMOTION DESCRIPTION (Instagram/Facebook caption) — decoupled, no DB
   ──────────────────────────────────────────────────────────────────── */

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

async function generatePromotionDescription(post, brief) {
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
  return text;
}

/* ────────────────────────────────────────────────────────────────────
   4. PUBLIC ENTRY — generate N HQ organic posts (gpt-image-2)
   ──────────────────────────────────────────────────────────────────── */

/**
 * @param {object} input
 *   count, subject, valueType[], tone, hook, cta, customerStage,
 *   businessName, businessField, about, services, targetAudience,
 *   preferredColors, designStyle,
 *   logoBuffer, imageBuffers[], avatarBuffer,
 *   onProgress?(doneUnits, totalUnits)  — totalUnits = N posts + 2 (texts, prompts);
 *                                         best-effort, callback errors are swallowed
 * @returns Array<{ headline, description, cta, type, promotionDescription, imageBuffer, error? }>
 */
async function generateHqSocialPosts(input = {}) {
  const {
    count = 1, subject, valueType = [], tone, hook, cta, customerStage,
    businessName, businessField, about, services, targetAudience,
    preferredColors = null, designStyle,
    logoBuffer = null, imageBuffers = [], avatarBuffer = null,
    referenceBuffers = [], // STYLE references (e.g. the winning ads) — steer look/branding, not subject
    onProgress = null,
  } = input;

  const targetCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);

  const brief = {
    businessName,
    businessField,
    about,
    services: services || subject || "",
    targetAudience: Array.isArray(targetAudience) ? targetAudience
      : (customerStage ? [customerStage] : []),
    preferredColors,
    designStyle: designStyle || tone || "warm minimal",
    avatar: avatarBuffer ? { inspirationUrl: "attached" } : null,
    logoUrl: logoBuffer ? "attached" : null,
  };

  const topic = [
    subject && `נושא: ${subject}`,
    Array.isArray(valueType) && valueType.length && `סוג ערך מועדף: ${valueType.join(", ")}`,
    tone && `טון: ${tone}`,
    hook && `זווית פתיחה: ${hook}`,
    cta && `קריאה לפעולה רצויה: ${cta}`,
  ].filter(Boolean).join("\n");

  // 1. Post texts (18 value-first types, anchored to the user's topic)
  const { posts, servicesAndDeals } = await generatePostsTexts(brief, targetCount, topic);

  const progressUnits = posts.length + 2; // texts + prompts + one per image
  const emitProgress = (done) => {
    if (!onProgress) return;
    try { onProgress(done, progressUnits); } catch {}
  };
  emitProgress(1);

  // 2. Nano-prompts (value-first directive + Hebrew/brand-color lock)
  const ctx = {
    businessName,
    businessField,
    about,
    hasLogo: !!logoBuffer,
    preferredColors,
    servicesAndDeals,
    designStyle: brief.designStyle,
  };

  let prompts;
  try {
    const fileNames = posts.map((_, i) => `post_${i + 1}.png`);
    const batch = await generateNanoPromptsBatch({ posts, ctx, brief, fileNames });
    prompts = batch.map(b => b.prompt);
  } catch (err) {
    console.warn(`[post-generation-quality] batch nano-prompt failed → per-post fallback: ${err.message}`);
    prompts = [];
    for (const p of posts) {
      try { prompts.push(await generateNanoPrompt(p, { ...ctx, hasScene: imageBuffers.length > 0 || referenceBuffers.length > 0 })); }
      catch (e) { prompts.push(null); }
    }
  }
  emitProgress(2);

  // 3. Images (gpt-image-2 via reused generateAdImageBuffer) + 4. captions
  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post   = posts[i];
    const prompt = prompts[i];
    const base   = { headline: post.headline, description: post.description, cta: post.cta, type: post.type };

    if (!prompt) { results.push({ ...base, error: "no nano prompt" }); emitProgress(2 + i + 1); continue; }

    try {
      // Scene references (passed to the image model to steer the result):
      //  • referenceBuffers (style refs, e.g. 1-2 winning ads) → use ALL of them for
      //    every post, so the model matches the winning look/branding/composition.
      //  • else rotate the client's uploaded photos (subject preservation), or avatar.
      // Logo is passed separately so generateAdImageBuffer attaches it LAST.
      let sceneBuffers;
      if (referenceBuffers.length > 0) {
        sceneBuffers = referenceBuffers;
      } else {
        const one = imageBuffers.length > 0 ? imageBuffers[i % imageBuffers.length] : avatarBuffer;
        sceneBuffers = one ? [one] : [];
      }
      const { buffer } = await generateAdImageBuffer(prompt, logoBuffer, sceneBuffers);

      let promotionDescription = "";
      try { promotionDescription = await generatePromotionDescription(post, brief); }
      catch (e) { console.warn(`[post-generation-quality] promo desc failed for post ${i + 1}: ${e.message}`); }

      results.push({ ...base, promotionDescription, imageBuffer: buffer });
    } catch (err) {
      console.error(`[post-generation-quality] image gen failed for post ${i + 1}: ${err.message}`);
      results.push({ ...base, error: err.message });
    }
    emitProgress(2 + i + 1);
    await new Promise(r => setTimeout(r, 500));
  }

  return results;
}

module.exports = { generateHqSocialPosts, fetchAssetBuffer };
