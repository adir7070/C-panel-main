'use strict';

/**
 * registry — the agent's tool catalog. Each tool = a JSON-schema `def` (sent to
 * Claude), a `write` flag (writes go through the policy chokepoint in loop.js),
 * and a `run(args, rc)` handler.
 *
 * SAFETY: `rc` (runContext) carries { phone, creds, view, campaigns } resolved
 * from the SESSION. The model NEVER passes phone/credentials — only campaign/ad
 * ids + values. This makes cross-client access structurally impossible.
 *
 * v1 set: all reads + the fully-wired safe writes (budget/pause/resume). More
 * write tools (ad-text, audience, delete, launch) land as their fb-actions
 * cores are extracted in later phases.
 */

const fbActions = require("../fb-actions.service");

/* Build a brand-styled AI image (reuses the copied HQ generator) from a subject,
   upload it to Backblaze, and return the /api/img proxy URL that uploadAdImage
   reads. Shared by launch_campaign and the standalone generate_ad_image tool. */
async function buildAndUploadImage(rc, { subject, cta, folder = "agent-image", sourceImageUrl = null, styleReferenceImageUrls = [] }) {
  const { generateHqSocialPosts, fetchAssetBuffer } = require("../post-generation-quality");
  const backblaze = require("../backblaze.service");
  const { getDB } = require("../../config/db");

  const p = rc.view.profile || {};
  let logoBuffer = null;
  try {
    const full = await getDB().collection("business_profiles").findOne({ phone: rc.phone }, { projection: { logoUrl: 1 } });
    if (full?.logoUrl) logoBuffer = await fetchAssetBuffer(full.logoUrl);
  } catch (_) { /* logo optional */ }

  // When a source image is given (a photo the client uploaded), pass it as a
  // scene reference → generateHqSocialPosts routes it through EDIT so the client's
  // actual photo/subject is PRESERVED (not a new unrelated image).
  let imageBuffers = [];
  if (sourceImageUrl) {
    try {
      const buf = await fetchAssetBuffer(sourceImageUrl);
      if (buf) imageBuffers = [buf];
    } catch (_) { /* fall back to text-only generation if the source can't be fetched */ }
  }

  // STYLE references (e.g. 1-2 winning ads) → fed to the image model so it matches
  // the winning look/branding/composition. Fetched best-effort, capped at 2.
  let referenceBuffers = [];
  if (Array.isArray(styleReferenceImageUrls) && styleReferenceImageUrls.length) {
    for (const url of styleReferenceImageUrls.slice(0, 2)) {
      try { const b = await fetchAssetBuffer(url); if (b) referenceBuffers.push(b); }
      catch (_) { /* skip a reference that can't be fetched */ }
    }
  }

  const posts = await generateHqSocialPosts({
    count: 1,
    subject,
    cta: cta || "למידע נוסף",
    businessName: p.businessName,
    businessField: p.businessField,
    about: p.about || "",
    services: (p.services || []).join("; "),
    targetAudience: (p.targetAudience || []).join(", "),
    preferredColors: p.preferredColors,
    designStyle: p.designStyle,
    logoBuffer,
    imageBuffers,
    referenceBuffers,
  });
  const post = Array.isArray(posts) ? posts.find(x => x && x.imageBuffer) : null;
  if (!post || !post.imageBuffer) throw new Error("יצירת התמונה נכשלה");
  const path = `${folder}/${rc.phone}/${Date.now()}.png`;
  await backblaze.uploadImage(path, post.imageBuffer, "image/png");
  return `/api/img?url=${encodeURIComponent(path)}`;
}

/* Hero prompt for the RENDERED ad path: a clean background photo with NO text /
   logo / UI (those are painted deterministically afterwards), and negative space
   on the LEFT for the brand panel (matches panelLayoutType "curved-split-left-text"). */
function buildHeroPrompt(heroConcept, p) {
  return [
    `A premium, high-end advertising background photograph. ${heroConcept || "a clean modern professional scene"}.`,
    p.businessName ? `Business context: ${p.businessName}${p.businessField ? ` — ${p.businessField}` : ""}.` : "",
    `ABSOLUTE RULES: NO text, NO letters, NO words, NO numbers, NO logo, NO buttons, NO UI, NO icons, NO badges, NO watermarks anywhere in the image.`,
    `Leave the LEFT 50-55% of the frame as clean, uncluttered negative space (soft gradient or gently blurred background) so a text panel can be added later; keep the main subject on the RIGHT half.`,
    `Style: modern, clean, editorial, professional lighting, realistic, brand-friendly. Square 1:1 composition.`,
  ].filter(Boolean).join(" ");
}

/* RENDERED ad: AI makes a clean text-free hero → the deterministic layout renderer
   paints the (approved) headline/description/CTA + logo in code (crisp Hebrew,
   correct brand). This is the quality path — the model never bakes garbled text. */
async function buildRenderedAd(rc, { headline, description = "", cta, heroConcept, accentWord = "", styleReferenceImageUrls = [] }) {
  const { fetchAssetBuffer } = require("../post-generation-quality");
  const { generateImageBuffer } = require("../gemini-image-gen.service");
  const { buildPalette } = require("../wow-ads-palette.service");
  const { renderAdLayout } = require("../wow-ads-layout-renderer.service");
  const backblaze = require("../backblaze.service");
  const { getDB } = require("../../config/db");

  const p = rc.view.profile || {};
  let logoBuffer = null;
  let preferredColors = p.preferredColors || null;
  try {
    const full = await getDB().collection("business_profiles").findOne({ phone: rc.phone }, { projection: { logoUrl: 1, preferredColors: 1 } });
    if (full?.logoUrl) logoBuffer = await fetchAssetBuffer(full.logoUrl);
    if (full?.preferredColors) preferredColors = full.preferredColors;
  } catch (_) { /* logo/colors optional */ }

  // Winning ads → steer the hero's look/colors. The renderer paints the real text
  // afterwards, so any faint text-bleed in the hero is covered/irrelevant.
  const refBuffers = [];
  for (const u of (Array.isArray(styleReferenceImageUrls) ? styleReferenceImageUrls.slice(0, 2) : [])) {
    try { const b = await fetchAssetBuffer(u); if (b) refBuffers.push(b); } catch (_) { /* skip */ }
  }

  const heroBuf = await generateImageBuffer(buildHeroPrompt(heroConcept, p), refBuffers);
  if (!heroBuf) throw new Error("יצירת רקע המודעה נכשלה");

  const palette = await buildPalette({ preferredColors, logoBuffer, visualType: "clean" });
  const accent = accentWord && headline && headline.includes(accentWord) ? accentWord : "";
  const { buffer } = await renderAdLayout({
    generatedImageBuffer: heroBuf,
    logoBuffer,
    ad: { headline: headline || "", description: description || "", cta: cta || "השאירו פרטים" },
    direction: { visualType: "clean", panelLayoutType: "curved-split-left-text", headlineAccentWord: accent, featurePills: [] },
    palette,
  });
  if (!buffer) throw new Error("רינדור המודעה נכשל");

  const path = `agent-ad/${rc.phone}/${Date.now()}.png`;
  await backblaze.uploadImage(path, buffer, "image/png");
  return `/api/img?url=${encodeURIComponent(path)}`;
}

/* Turn the CLIENT'S OWN uploaded photo into a branded ad — composite the text +
   logo ON TOP of their exact image via the deterministic layout renderer (NO AI
   regeneration), so the client's actual photo/product IS the ad. This fixes the
   bug where a client uploads a photo ("use THIS") and gets back a fresh AI image
   of something unrelated: passing a photo as a mere reference to the image model
   makes it regenerate, not preserve. Here the photo is the hero, untouched. */
async function buildAdFromClientPhoto(rc, { sourceImageUrl, text = "" }) {
  const { fetchAssetBuffer } = require("../post-generation-quality");
  const { buildPalette } = require("../wow-ads-palette.service");
  const { renderAdLayout } = require("../wow-ads-layout-renderer.service");
  const backblaze = require("../backblaze.service");
  const { getDB } = require("../../config/db");

  const baseBuf = await fetchAssetBuffer(sourceImageUrl);
  if (!baseBuf) throw new Error("לא הצלחתי לטעון את התמונה שהעלית");

  const p = rc.view.profile || {};
  let logoBuffer = null, preferredColors = p.preferredColors || null;
  try {
    const full = await getDB().collection("business_profiles").findOne({ phone: rc.phone }, { projection: { logoUrl: 1, preferredColors: 1 } });
    if (full?.logoUrl) logoBuffer = await fetchAssetBuffer(full.logoUrl);
    if (full?.preferredColors) preferredColors = full.preferredColors;
  } catch (_) { /* logo/colors optional */ }

  const palette = await buildPalette({ preferredColors, logoBuffer, visualType: "clean" });
  // bottom-heavy layout → text band at the bottom, the client's photo fills the
  // top and stays clearly visible (vs. a side panel that covers the subject).
  const { buffer } = await renderAdLayout({
    generatedImageBuffer: baseBuf, // ← the client's EXACT uploaded photo, as the hero
    logoBuffer,
    ad: { headline: text || p.businessName || "", description: "", cta: "למידע נוסף" },
    direction: { visualType: "clean", panelLayoutType: "bottom-heavy-editorial", headlineAccentWord: "", featurePills: [] },
    palette,
  });
  if (!buffer) throw new Error("רינדור המודעה נכשל");
  const path = `agent-edit/${rc.phone}/${Date.now()}.png`;
  await backblaze.uploadImage(path, buffer, "image/png");
  return `/api/img?url=${encodeURIComponent(path)}`;
}

/* Generate an AI ad image for a launch. */
async function generateLaunchImage(rc, args) {
  return buildAndUploadImage(rc, {
    subject: args.headline || args.name,
    cta: args.campaignType === "leads" ? "השאירו פרטים" : "למידע נוסף",
    folder: "agent-launch",
  });
}

/* Find the image the client most recently uploaded to this thread. Prefers the
   current-turn upload (rc.pendingImageUrl, set when the upload triggers the run),
   else scans the recent thread for the last client media message — so "turn the
   photo I sent into an ad" works even when the photo arrived a turn earlier. */
async function findClientImageUrl(rc) {
  if (rc.pendingImageUrl) return rc.pendingImageUrl;
  try {
    const { getDB } = require("../../config/db");
    const doc = await getDB().collection("agent_chats").findOne(
      { phone: String(rc.phone) },
      { projection: { messages: { $slice: -40 } } },
    );
    const msgs = doc?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "user" && Array.isArray(m.media) && m.media[0]?.url) return m.media[0].url;
    }
  } catch (_) { /* best-effort */ }
  return null;
}

const TOOLS = {
  /* ── READS ─────────────────────────────────────────────────────────────── */
  get_performance: {
    write: false,
    def: {
      name: "get_performance",
      description: "מחזיר את מצב הקמפיינים הפעילים של הלקוח בפייסבוק/אינסטגרם: תקציב יומי, הוצאה היום, לידים היום, CTR, וסטטוס. השתמש בזה כדי לדעת מה קורה עכשיו לפני כל המלצה.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => ({
      activeCampaigns: rc.view.performance.activeCampaigns,
      totalCampaigns: rc.view.performance.totalCampaigns,
      campaigns: rc.view.performance.campaigns,
      spend14d: rc.view.performance.spend14d,
      error: rc.view.performance.campaignsError,
    }),
  },

  get_leads_trend: {
    write: false,
    def: {
      name: "get_leads_trend",
      description: "מחזיר מגמת לידים והוצאה לפי יום עבור X הימים האחרונים (ברירת מחדל 14). שימושי לזיהוי ירידה/עלייה בביצועים.",
      input_schema: {
        type: "object",
        properties: { days: { type: "integer", description: "מספר ימים אחורה (7/14/30)", minimum: 1, maximum: 30 } },
        required: [],
      },
    },
    run: async (args, rc) => {
      const days = parseInt(args.days, 10) || 14;
      if (!rc.creds?.userToken) return { total: 0, trend: [], error: "FB credentials not available" };
      return fbActions.getLeadsTrend(rc.creds, days);
    },
  },

  get_business_profile: {
    write: false,
    def: {
      name: "get_business_profile",
      description: "מחזיר את פרופיל העסק של הלקוח: תחום, שירותים, קהל יעד, צבעי מותג, סגנון. השתמש בזה כדי להתאים המלצות ותוכן לעסק הספציפי.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => rc.view.profile || { error: "no business profile on file" },
  },

  get_account_status: {
    write: false,
    def: {
      name: "get_account_status",
      description: "מחזיר את מצב החשבון של הלקוח: חבילה/מנוי פעיל וסטטוסו, ומנהל התיק. (טוקנים/מטבעות מוסתרים מהלקוח — אל תדווח עליהם.)",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => ({
      package: rc.view.account?.package || null,
      tier: rc.view.tier,
    }),
  },

  get_drive_link: {
    write: false,
    def: {
      name: "get_drive_link",
      description: "מחזיר את הקישור לתיקיית הדרייב של הלקוח (הלוגו, התמונות והחומרים שלו) מפיירברי. השתמש בזה כשהלקוח מבקש 'תשלח לי את הקישור לדרייב' / 'איפה החומרים/התמונות שלי'. אם קיים קישור — שלח אותו ללקוח ישירות; אם אין — אמור בנימוס שאין עדיין תיקיית דרייב מקושרת. אל תגיד 'אני בודק ומעדכן' — קרא לכלי וענה מיד.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => {
      try {
        const { getCustomerByPhone } = require("../fireberry-customers.service");
        const cust = await getCustomerByPhone(rc.phone);
        const url = cust?.driveUrl || null;
        if (!url) return { driveUrl: null, note: "אין תיקיית דרייב מקושרת ללקוח הזה בפיירברי. אמור ללקוח בנימוס שאין עדיין קישור דרייב זמין ושתטפל בזה." };
        return { driveUrl: url, note: "שלח את הקישור הזה ללקוח מיד." };
      } catch (e) {
        return { error: `שגיאה בשליפת הדרייב מפיירברי: ${e.message}` };
      }
    },
  },

  get_leads: {
    write: false,
    def: {
      name: "get_leads",
      description: "מציג את פרטי הלידים האחרונים של הלקוח: שם, טלפון, קמפיין, תאריך. ⚠️ חושף פרטים אישיים. ספירה כללית של לידים (בלי פרטים) אפשר לקבל מ-get_leads_trend — השתמש בזה קודם אם צריך רק מספר. ציין limit (כמה לידים להציג, ברירת מחדל 10).",
      input_schema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 25, description: "כמה לידים אחרונים להציג (ברירת מחדל 10)" } },
        required: [],
      },
    },
    run: async (args, rc) => {
      const { getDB } = require("../../config/db");
      const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 10), 25);
      const doc = await getDB().collection("user_leads").findOne({ phone: rc.phone });
      const all = (doc?.forms || []).flatMap(f => (f.leads || []).map(l => ({
        name: l.name || null, phone: l.lead_phone || null, email: l.email || null,
        campaign: l.campaign_name || null, ad: l.ad_name || null, at: l.created_time || null, form: f.formName || null,
      })));
      if (!all.length) return { total: 0, shown: 0, leads: [], note: "אין לידים שמורים ללקוח הזה." };
      all.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      const toShow = all.slice(0, limit);
      // Revealing lead details is FREE — fully included in the subscription. Never
      // check a balance, never block, never mention tokens/coins/cost to the client.
      return { total: all.length, shown: toShow.length, leads: toShow };
    },
  },

  get_campaign_ads: {
    write: false,
    def: {
      name: "get_campaign_ads",
      description: "מחזיר את המודעות בקמפיין מסוים: טקסט (כותרת/תיאור/CTA), סטטוס, מזהה adSet, וביצועים (חשיפות/קליקים/הוצאה/לידים/CTR/עלות לליד). השתמש בזה כדי לנתח מודעה לפני שינוי טקסט/קהל. ציין campaignId מתוך get_performance.",
      input_schema: {
        type: "object",
        properties: { campaignId: { type: "string", description: "מזהה הקמפיין" } },
        required: ["campaignId"],
      },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { ads: [], error: "FB credentials not available" };
      return fbActions.getCampaignAds(rc.creds, args.campaignId);
    },
  },

  analyze_campaign: {
    write: false,
    def: {
      name: "analyze_campaign",
      description: "ניתוח ייעול עמוק של קמפיין: מדרג את המודעות לפי הביצועים בפועל, מזהה את המודעה המנצחת ומה עשה אותה מנצחת (עלות לליד / CTR), ומזהה מודעות חלשות. מחזיר גם רמזי ייעול מבוססי-נתונים. השתמש בזה כדי להבין מה עבד בקמפיין ולהציע ליישם את זה על שאר המודעות. ציין campaignId מתוך get_performance.",
      input_schema: {
        type: "object",
        properties: { campaignId: { type: "string", description: "מזהה הקמפיין לניתוח" } },
        required: ["campaignId"],
      },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { error: "FB credentials not available" };
      return fbActions.analyzeCampaign(rc.creds, args.campaignId);
    },
  },

  get_winning_ads_style: {
    write: false,
    def: {
      name: "get_winning_ads_style",
      description: "סורק את כל המודעות של הלקוח בכל החשבון, מדרג אותן לפי הביצועים האמיתיים (לידים/עלות לליד/CTR), ומחזיר את המודעה/ות המנצחת/ות + הסגנון המנצח: מבנה הכותרת, פתיחים חוזרים, CTA, טון, מילות כאב/תועלת, ו-3 הדוגמאות הכי טובות. חובה לקרוא לזה קודם בכל פעם שהלקוח מבקש 'מודעה חדשה' / 'תכין לי מודעה' / קריאייטיב חדש — כדי להכין מודעה בסגנון שכבר עובד לו (ולא משהו גנרי). כל מנצחת מחזירה גם adId/campaignId/adSetId ו-imageUrl — השתמש בהם כדי לבנות את המודעה החדשה בתוך הקמפיין הקיים.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { error: "FB credentials not available" };
      return fbActions.getWinningAdsStyle(rc.creds);
    },
  },

  search_targeting: {
    write: false,
    def: {
      name: "search_targeting",
      description: "חיפוש מזהי טירגוט אמיתיים בפייסבוק: מיקומים (ערים/אזורים/מדינות), תחומי עניין, או שפות. השתמש בזה כדי לקבל את ה-key/id הנכון לפני update_audience (אסור להמציא מזהים). type ∈ adgeolocation | adinterest | adlocale.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "טקסט החיפוש (למשל 'תל אביב' או 'כושר')" },
          type: { type: "string", enum: ["adgeolocation", "adinterest", "adlocale"], description: "סוג הטירגוט" },
        },
        required: ["q"],
      },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { results: [], error: "FB credentials not available" };
      return fbActions.searchTargeting(rc.creds, { type: args.type || "adgeolocation", q: args.q });
    },
  },

  /* ── WRITES (policy-gated in loop.js) ──────────────────────────────────── */
  update_budget: {
    write: true,
    def: {
      name: "update_budget",
      description: "מעדכן את התקציב היומי (בש\"ח) של קמפיין. העלאה מתונה (עד 30%) מתבצעת אוטומטית; העלאה גדולה יותר או מעל התקרה דורשת אישור הלקוח. ציין campaignId מתוך get_performance.",
      input_schema: {
        type: "object",
        properties: {
          campaignId: { type: "string", description: "מזהה הקמפיין (id מתוך get_performance)" },
          dailyBudgetIls: { type: "number", description: "התקציב היומי החדש בשקלים" },
          reason: { type: "string", description: "נימוק קצר ללקוח: למה השינוי הזה" },
        },
        required: ["campaignId", "dailyBudgetIls"],
      },
    },
    run: async (args, rc) => fbActions.setCampaignBudget(rc.creds, args.campaignId, args.dailyBudgetIls),
    summarize: (args) => `עדכון תקציב קמפיין ${args.campaignId} ל-${args.dailyBudgetIls}₪ ליום`,
  },

  pause_campaign: {
    write: true,
    def: {
      name: "pause_campaign",
      description: "עוצר (משהה) קמפיין פעיל. פעולה רגישה — דורשת אישור הלקוח. ציין campaignId.",
      input_schema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["campaignId"],
      },
    },
    run: async (args, rc) => fbActions.setCampaignStatus(rc.creds, args.campaignId, "PAUSED"),
    summarize: (args) => `עצירת קמפיין ${args.campaignId}`,
  },

  resume_campaign: {
    write: true,
    def: {
      name: "resume_campaign",
      description: "מפעיל מחדש קמפיין מושהה. דורש אישור הלקוח. ציין campaignId.",
      input_schema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["campaignId"],
      },
    },
    run: async (args, rc) => fbActions.setCampaignStatus(rc.creds, args.campaignId, "ACTIVE"),
    summarize: (args) => `הפעלת קמפיין ${args.campaignId}`,
  },

  pause_ad: {
    write: true,
    def: {
      name: "pause_ad",
      description: "עוצר מודעה בודדת (לא קמפיין שלם). דורש אישור הלקוח. ציין adId.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => fbActions.setAdStatus(rc.creds, args.adId, "PAUSED"),
    summarize: (args) => `עצירת מודעה ${args.adId}`,
  },

  resume_ad: {
    write: true,
    def: {
      name: "resume_ad",
      description: "מפעיל מודעה בודדת מושהית (למשל מודעה חדשה שהוספת לקמפיין הקיים והיא PAUSED). דורש אישור הלקוח (מוציא תקציב). ציין adId.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => fbActions.setAdStatus(rc.creds, args.adId, "ACTIVE"),
    summarize: (args) => `הפעלת מודעה ${args.adId}`,
  },

  update_ad_text: {
    write: true,
    def: {
      name: "update_ad_text",
      description: "מעדכן את הטקסט של מודעה: כותרת (title), תיאור/גוף (body), או כפתור פעולה (callToAction). פעולה בטוחה — מתבצעת אוטומטית. שים לב: מטא יוצרת קריאייטיב חדש (לא עורכת במקום). קבל את הטקסט הנוכחי מ-get_campaign_ads תחילה. ציין adId.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string", description: "מזהה המודעה (מתוך get_campaign_ads)" },
          title: { type: "string", description: "כותרת חדשה (אופציונלי)" },
          body: { type: "string", description: "תיאור/גוף חדש (אופציונלי)" },
          callToAction: { type: "string", description: "סוג כפתור CTA של מטא, למשל LEARN_MORE / SIGN_UP / CONTACT_US (אופציונלי)" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => fbActions.updateAdText(rc.creds, args.adId, { title: args.title, body: args.body, callToAction: args.callToAction }),
    summarize: (args) => `עדכון טקסט מודעה ${args.adId}`,
  },

  update_ad_link: {
    write: true,
    def: {
      name: "update_ad_link",
      description: "משנה את כתובת האתר (הלינק/היעד) שאליה מפנות המודעות המפורסמות של הלקוח. השתמש בזה כשהלקוח מבקש לתקן/לשנות את הקישור לאתר במודעות — בדיוק מה שמנהל עושה ידנית בפאנל. ללא campaignId מעדכן את כל המודעות בקמפיינים הפעילים; עם campaignId מוגבל לקמפיין ההוא. מעדכן גם את יעד כפתור הפעולה במודעות תנועה; טפסי לידים נשמרים. פעולה בטוחה — לא מוציאה תקציב — ומתבצעת אוטומטית. תמיד ודא מול הלקוח שהכתובת המדויקת נכונה לפני שאתה מבצע.",
      input_schema: {
        type: "object",
        properties: {
          link: { type: "string", description: "כתובת האתר החדשה במלואה, למשל https://example.co.il" },
          campaignId: { type: "string", description: "אופציונלי — הגבל לקמפיין מסוים (id מ-get_performance). אם ריק, יעודכנו כל המודעות בקמפיינים הפעילים." },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["link"],
      },
    },
    run: async (args, rc) => fbActions.updateAdsLink(rc.creds, { link: args.link, campaignId: args.campaignId }),
    summarize: (args) => `שינוי הלינק במודעות ל-${args.link}${args.campaignId ? ` (קמפיין ${args.campaignId})` : ""}`,
  },

  generate_ad_image: {
    write: true,
    def: {
      name: "generate_ad_image",
      description: "מייצר תמונת מודעה חדשה לגמרי ב-AI לפי קונספט/תיאור של הלקוח, ומציג אותה לו מיד. השתמש בזה בכל פעם שהלקוח מבקש תמונה חדשה, רעיון ויזואלי אחר, או רענון קריאייטיב. חשוב: אל תציג את התמונה הקיימת של המודעה (get_campaign_ads) כאילו היא חדשה, ואל תסתפק בתיאור מילולי — קרא לכלי הזה כדי לייצר תמונה אמיתית. אם הלקוח נתן כיוון ברור, צור מיד לפי הכיוון בלי להציף בשאלות.",
      input_schema: {
        type: "object",
        properties: {
          concept: { type: "string", description: "תיאור התמונה הרצויה בעברית — הנושא, הסגנון והאווירה (למשל 'זוג רומנטי על חוף בשקיעה, סגנון נקי ומודרני'). ככל שמפורט יותר — התוצאה מדויקת יותר." },
          cta: { type: "string", description: "קריאה לפעולה אופציונלית שתופיע על התמונה (למשל 'השאירו פרטים', 'למידע נוסף')." },
          styleReferenceImageUrls: {
            type: "array",
            items: { type: "string" },
            description: "אופציונלי אך מומלץ מאוד למודעה בסגנון שעובד — 1 עד 2 כתובות תמונה של המודעות המנצחות (ה-imageUrl מ-get_winning_ads_style). התמונות נשלחות למודל כרפרנס ומכוונות אותו למראה, המיתוג, הצבעים וההרכב של המנצחות. העבר את 1-2 המנצחות הכי טובות." },
        },
        required: ["concept"],
      },
    },
    run: async (args, rc) => {
      const refs = Array.isArray(args.styleReferenceImageUrls) ? args.styleReferenceImageUrls.filter(Boolean)
        : (args.styleReferenceImageUrl ? [args.styleReferenceImageUrl] : []); // tolerate the old singular field
      const url = await buildAndUploadImage(rc, { subject: args.concept, cta: args.cta, styleReferenceImageUrls: refs.slice(0, 2) });
      // Surface it to the client immediately (the app renders rc.media as thumbnails).
      if (rc.media && !rc.media.some(m => m.url === url)) {
        rc.media.push({ url, caption: args.concept ? `תמונה חדשה: ${args.concept}` : "תמונה חדשה" });
      }
      return { imageUrl: url, note: "נוצרה תמונה חדשה והיא מוצגת ללקוח מתחת לתשובה. אם הוא מרוצה — אפשר להשתמש בה במודעה/קמפיין; אם לא — אפשר לייצר שוב עם כיוון אחר." };
    },
    summarize: (args) => `יצירת תמונת מודעה חדשה${args.concept ? `: ${args.concept}` : ""}`,
  },

  create_ad_creative: {
    write: true,
    def: {
      name: "create_ad_creative",
      description: "יוצר תמונת מודעה **מקצועית ונקייה**: ה-AI מייצר רק את הרקע (בלי טקסט), והמערכת מציירת מעליו **בקוד** את הכותרת/התיאור/כפתור ה-CTA והלוגו — עברית חדה ומדויקת, מותג נכון, עיצוב אחיד. **זה הכלי המועדף למודעה בסגנון מקצועי** — עדיף בהרבה על generate_ad_image (שצורב טקסט ב-AI ולכן יוצא משובש/לא ממותג). השתמש בו בזרימת 'מודעה בסגנון שעובד', אחרי שהלקוח אישר את הקופי. כללים: העבר את הכותרת/התיאור/CTA **בדיוק כפי שאושרו** (עברית), וב-heroConcept תאר **רק את הרקע הוויזואלי** — סצנה/נושא/אווירה, בלי טקסט, לוגו או כפתורים.",
      input_schema: {
        type: "object",
        properties: {
          headline: { type: "string", description: "הכותרת הראשית שתצויר על המודעה — עברית, קצרה וחדה (למשל 'דרוש/ה מפתח/ת React')" },
          description: { type: "string", description: "תיאור/גוף קצר שיצויר מתחת לכותרת (שורה-שתיים, עברית)" },
          cta: { type: "string", description: "טקסט כפתור הקריאה לפעולה (למשל 'השאירו פרטים', 'הגישו מועמדות')" },
          heroConcept: { type: "string", description: "תיאור **הרקע הוויזואלי בלבד** — הסצנה/הנושא/האווירה, בלי שום טקסט/לוגו/כפתורים בתמונה (למשל 'צוות מפתחים צעיר ואנרגטי במשרד הייטק מודרני, תאורה כחולה נקייה')." },
          accentWord: { type: "string", description: "אופציונלי — מילה אחת מתוך הכותרת שתודגש בצבע המותג. חייבת להופיע בכותרת." },
          styleReferenceImageUrls: { type: "array", items: { type: "string" }, description: "אופציונלי — 1-2 imageUrl של המודעות המנצחות (מ-get_winning_ads_style), לכיוון המראה/צבעים של הרקע." },
        },
        required: ["headline", "cta", "heroConcept"],
      },
    },
    run: async (args, rc) => {
      const url = await buildRenderedAd(rc, {
        headline: args.headline, description: args.description, cta: args.cta,
        heroConcept: args.heroConcept, accentWord: args.accentWord,
        styleReferenceImageUrls: Array.isArray(args.styleReferenceImageUrls) ? args.styleReferenceImageUrls.filter(Boolean) : [],
      });
      if (rc.media && !rc.media.some(m => m.url === url)) {
        rc.media.push({ url, caption: args.headline ? `מודעה: ${args.headline}` : "מודעה חדשה" });
      }
      return { imageUrl: url, note: "נוצרה מודעה מעוצבת עם טקסט חד ומדויק (הכותרת/CTA צוירו בקוד, לא נצרבו ב-AI). מוצגת ללקוח מתחת לתשובה. אם מרוצה — אפשר לחבר אותה למודעה בקמפיין הקיים." };
    },
    summarize: (args) => `יצירת מודעה מעוצבת: ${args.headline || ""}`,
  },

  edit_ad_image: {
    write: true,
    def: {
      name: "edit_ad_image",
      description: "הופך תמונה שהלקוח העלה למודעה מעוצבת — משתמש בתמונה שלו כבסיס (שומר על הנושא/האנשים שבה) ומוסיף עליה טקסט ועיצוב מיתוגי. חובה להשתמש בכלי הזה (ולא ב-generate_ad_image) בכל פעם שהלקוח מעלה/הזכיר תמונה ומבקש 'תהפוך אותה למודעה' / 'תוסיף טקסט על התמונה הזו' / 'אני רוצה שזו תהיה התמונה'. אסור לייצר תמונה חדשה שאינה קשורה לתמונה שהעלה. את הטקסט שהלקוח ביקש יש להעביר בדיוק כפי שנתן, ללא שינוי או המצאה.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "הטקסט המדויק שהלקוח ביקש שיופיע על התמונה — העתק אותו כלשונו, בלי לשנות/לקצר/להמציא." },
          changes: { type: "string", description: "שינויים/סגנון אופציונליים שהלקוח ביקש (למשל 'רקע כהה יותר', 'הוסף לוגו', 'סגנון נקי'). אם אין — השאר ריק." },
        },
        required: ["text"],
      },
    },
    run: async (args, rc) => {
      const sourceImageUrl = await findClientImageUrl(rc);
      if (!sourceImageUrl) {
        return { error: "לא מצאתי תמונה שהלקוח העלה. בקש מהלקוח לשלוח שוב את התמונה שהוא רוצה שנהפוך למודעה." };
      }
      const text = String(args.text || "").trim();
      // Composite the text/branding ON the client's EXACT photo (no AI
      // regeneration) so their actual image/product IS the ad.
      const url = await buildAdFromClientPhoto(rc, { sourceImageUrl, text });
      if (rc.media && !rc.media.some(m => m.url === url)) {
        rc.media.push({ url, caption: text ? `מודעה מהתמונה שלך: ${text}` : "מודעה מהתמונה שלך" });
      }
      return { imageUrl: url, note: "יצרתי מודעה מבוססת על התמונה שהלקוח העלה (עם הטקסט שביקש) והיא מוצגת לו מתחת לתשובה. אם ירצה שינויים — אפשר לערוך שוב. אל תתאר את התמונה במילים; היא כבר מוצגת." };
    },
    summarize: (args) => `עריכת התמונה שהלקוח העלה למודעה${args.text ? `: ${args.text}` : ""}`,
  },

  update_ad_image: {
    write: true,
    def: {
      name: "update_ad_image",
      description: "מחליף את התמונה (הקריאייטיב) של מודעה שכבר רצה — בדיוק כמו שמנהל מרענן מודעה שחוקה בפאנל. השתמש בזה כשהלקוח מבקש לשנות/לרענן את התמונה של מודעה קיימת (לא ליצור קמפיין חדש). זרימת עבודה: (1) השג תמונה חדשה — קרא ל-generate_ad_image (תמונת AI חדשה) או ל-edit_ad_image (אם הלקוח העלה תמונה); שניהם מחזירים imageUrl. (2) קרא ל-update_ad_image עם adId (מ-get_campaign_ads) וה-imageUrl שהוחזר. פועל על מודעות תמונה בלבד (לא וידאו). פעולה בטוחה — לא מוציאה תקציב — ומתבצעת אוטומטית. מטא יוצרת קריאייטיב חדש ומפנה אליו את המודעה.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string", description: "מזהה המודעה שאת תמונתה מחליפים (מתוך get_campaign_ads)" },
          imageUrl: { type: "string", description: "כתובת התמונה החדשה — ה-imageUrl שהוחזר מ-generate_ad_image או edit_ad_image" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId", "imageUrl"],
      },
    },
    run: async (args, rc) => fbActions.updateAdText(rc.creds, args.adId, { imageUrl: args.imageUrl }),
    summarize: (args) => `החלפת תמונה במודעה ${args.adId}`,
  },

  duplicate_ad: {
    write: true,
    def: {
      name: "duplicate_ad",
      description: "משכפל מודעה קיימת (בדרך כלל את המנצחת) בתוך אותה קבוצת מודעות — נותן למודעה החזקה התחלת הצגה רעננה תחת אותו תקציב. שימושי כשמזהים מודעה שעובדת מצוין ורוצים 'להגדיל' אותה. אינו מעלה תקציב בעצמו (התקציב הקיים מתחלק מחדש). המודעה החדשה נוצרת מושהית (PAUSED) וממתינה לחידוש. השתמש אחרי analyze_campaign כשיש מנצחת ברורה. ציין adId (מ-get_campaign_ads).",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string", description: "מזהה המודעה לשכפול (המנצחת) — מתוך get_campaign_ads" },
          reason: { type: "string", description: "נימוק קצר ללקוח (למשל 'המודעה הזו מביאה לידים הכי בזול — משכפל כדי להגדיל')" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => fbActions.duplicateAd(rc.creds, args.adId, { status: "PAUSED" }),
    summarize: (args) => `שכפול מודעה מנצחת ${args.adId}`,
  },

  get_ad_lead_form: {
    write: false,
    def: {
      name: "get_ad_lead_form",
      description: "מציג את טופס הלידים המחובר למודעה + השאלות שבו (שם מלא/טלפון/אימייל/שאלות מותאמות). השתמש בזה כדי להראות ללקוח אילו שאלות קיימות בטופס לפני שמשנים אותן. ציין adId (מתוך get_campaign_ads).",
      input_schema: {
        type: "object",
        properties: { adId: { type: "string", description: "מזהה המודעה (מ-get_campaign_ads)" } },
        required: ["adId"],
      },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { error: "FB credentials not available" };
      return fbActions.getAdLeadForm(rc.creds, args.adId);
    },
  },

  set_ad_lead_form: {
    write: true,
    def: {
      name: "set_ad_lead_form",
      description: "יוצר טופס לידים חדש עם השאלות שהלקוח ביקש ומחבר אותו למודעה נבחרת. שימושי כשהלקוח רוצה **ליצור טופס לידים** או **לשנות/להוסיף שאלה** בטופס. חשוב: טפסי לידים ב-Meta אינם ניתנים לעריכה — לכן 'שינוי שאלה' = טופס חדש שמחליף את הישן במודעה (הכלי עושה זאת אוטומטית). לפני הקריאה: (1) ברר לאיזו מודעה/קמפיין (get_campaign_ads); (2) אם משנים טופס קיים — הראה קודם את השאלות הנוכחיות עם get_ad_lead_form. דורש אישור לקוח.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string", description: "מזהה המודעה שאליה יחובר הטופס (מ-get_campaign_ads)" },
          questions: {
            type: "array",
            description: "שאלות הטופס לפי הסדר. כל שאלה = אובייקט. שאלה סטנדרטית: {type:'FULL_NAME'} (או PHONE / EMAIL / CITY / COMPANY_NAME / JOB_TITLE). שאלה מותאמת אישית: {type:'CUSTOM', label:'טקסט השאלה', options:['בחירה1','בחירה2']} — options הופך אותה לשאלת בחירה, בלי options זו שאלה פתוחה. אם ריק — ברירת מחדל: שם מלא + טלפון.",
            items: {
              type: "object",
              properties: {
                type: { type: "string", description: "FULL_NAME / PHONE / EMAIL / CITY / COMPANY_NAME / JOB_TITLE / CUSTOM" },
                label: { type: "string", description: "טקסט השאלה — רק כש-type=CUSTOM" },
                options: { type: "array", items: { type: "string" }, description: "אפשרויות בחירה — רק כש-type=CUSTOM" },
              },
              required: ["type"],
            },
          },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => {
      if (!rc.creds?.userToken) return { error: "FB credentials not available" };
      const { formId, questions } = await fbActions.createLeadForm(rc.creds, { name: "טופס לידים", questions: args.questions });
      const res = await fbActions.updateAdText(rc.creds, args.adId, { leadFormId: formId });
      return {
        ok: !!res.success, formId, questions,
        note: "נוצר טופס לידים חדש עם השאלות שביקשת והוא חובר למודעה. (טפסים ב-Meta אינם ניתנים לעריכה — לכן שינוי שאלות = טופס חדש שמחליף את הישן.)",
      };
    },
    summarize: (args) => `יצירת/עדכון טופס לידים למודעה ${args.adId}`,
  },

  remember_client_fact: {
    write: true,
    def: {
      name: "remember_client_fact",
      description: "שומר עובדה קבועה על הלקוח בזיכרון ארוך-הטווח שלך, כדי שתכיר אותו בשיחות הבאות. השתמש כשהלקוח מוסר העדפה/החלטה/הקשר קבועים (למשל 'מעדיף תמונות בלי טקסט', 'אשתו מנהלת את החשבון', 'סירב לוובינר — לא להציע שוב'). אל תשמור נתוני שיווק חיים (לידים/תקציב/יתרה), פרטי תשלום, או מידע רגיש. חינם ושקט — אל תכריז ללקוח ששמרת.",
      input_schema: {
        type: "object",
        properties: {
          fact: { type: "string", description: "העובדה, משפט אחד קצר וברור בעברית (עד 200 תווים)" },
          category: { type: "string", enum: ["העדפות", "עסק", "תקשורת", "החלטות", "אישי"], description: "סיווג העובדה" },
        },
        required: ["fact"],
      },
    },
    run: async (args, rc) => {
      const mem = require("./client-memory.service");
      const r = await mem.addFact(rc.phone, { fact: args.fact, category: args.category, source: "agent" });
      return r.ok
        ? { ok: true, note: r.duplicate ? "העובדה כבר שמורה." : "נשמר לזיכרון. המשך את השיחה כרגיל — בלי להכריז על השמירה." }
        : { error: r.error || "שמירה נכשלה" };
    },
    summarize: (args) => `שמירת עובדה על הלקוח: ${String(args.fact || "").slice(0, 60)}`,
  },

  update_audience: {
    write: true,
    def: {
      name: "update_audience",
      description: "מעדכן את קהל היעד של קבוצת מודעות (adSet): גיל, מגדר, מיקומים, ותחומי עניין. פעולה רגישה — דורשת אישור הלקוח. חובה לקבל מזהי מיקום/עניין אמיתיים מ-search_targeting (אסור להמציא). ציין adSetId (מתוך get_campaign_ads).",
      input_schema: {
        type: "object",
        properties: {
          adSetId: { type: "string", description: "מזהה קבוצת המודעות (adSetId מתוך get_campaign_ads)" },
          ageMin: { type: "integer", description: "גיל מינימום (אופציונלי)" },
          ageMax: { type: "integer", description: "גיל מקסימום (אופציונלי)" },
          genders: { type: "array", items: { type: "string", enum: ["male", "female"] }, description: "מגדרים; שניהם/ריק = הכל" },
          locations: {
            type: "array",
            description: "מיקומים מ-search_targeting",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["country", "region", "city", "address"] },
                key: { type: "string", description: "ה-key מ-search_targeting" },
                name: { type: "string" },
                radiusKm: { type: "number", description: "רדיוס לעיר (ברירת מחדל 17)" },
                include: { type: "boolean", description: "false = להחריג את המיקום" },
              },
              required: ["type", "key"],
            },
          },
          interests: {
            type: "array",
            description: "תחומי עניין מ-search_targeting (type=adinterest)",
            items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] },
          },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adSetId"],
      },
    },
    run: async (args, rc) => fbActions.updateAdAudience(rc.creds, args.adSetId, {
      ageMin: args.ageMin, ageMax: args.ageMax, genders: args.genders,
      locations: args.locations, interests: args.interests,
    }),
    summarize: (args) => `עדכון קהל יעד לקבוצת מודעות ${args.adSetId}`,
  },

  delete_ad: {
    write: true,
    def: {
      name: "delete_ad",
      description: "מוחק מודעה (מטא מסמנת אותה DELETED). פעולה רגישה ובלתי-הפיכה — דורשת אישור הלקוח. ציין adId.",
      input_schema: {
        type: "object",
        properties: {
          adId: { type: "string" },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["adId"],
      },
    },
    run: async (args, rc) => fbActions.deleteAd(rc.creds, args.adId),
    summarize: (args) => `מחיקת מודעה ${args.adId}`,
  },

  launch_campaign: {
    write: true,
    def: {
      name: "launch_campaign",
      description: "משיק קמפיין פרסום חדש (לידים או תנועה לאתר) מקצה לקצה — כולל יצירת תמונת מודעה ב-AI אוטומטית מהבריף. פעולה רגישה — דורשת אישור הלקוח. המודעה נוצרת PAUSED ולא תוציא תקציב עד הפעלה. בנה כותרת ותיאור מותאמים לעסק (get_business_profile). למסע תנועה צריך websiteUrl. (אם יש כבר תמונה מתאימה ממודעה קיימת אפשר להעביר imageUrl — אחרת תיווצר תמונה חדשה ב-AI.)",
      input_schema: {
        type: "object",
        properties: {
          campaignType: { type: "string", enum: ["leads", "traffic"], description: "leads = איסוף לידים (טופס); traffic = תנועה לאתר" },
          name: { type: "string", description: "שם הקמפיין" },
          dailyBudgetIls: { type: "number", description: "תקציב יומי בשקלים" },
          headline: { type: "string", description: "כותרת המודעה (משמשת גם ליצירת התמונה)" },
          subheadline: { type: "string", description: "תיאור/משפט עיקרי (אופציונלי)" },
          proofLine: { type: "string", description: "משפט אמינות/תועלת נוסף (אופציונלי)" },
          websiteUrl: { type: "string", description: "כתובת האתר — חובה למסע תנועה" },
          imageUrl: { type: "string", description: "אופציונלי — תמונה אחת מוכנה למודעה" },
          imageUrls: { type: "array", items: { type: "string" }, description: "אופציונלי — כמה תמונות מוכנות (מ-edit_ad_image/generate_ad_image), מודעה אחת לכל תמונה (עד 5). השתמש בזה כשהלקוח ביקש כמה מודעות. אם ריק וגם imageUrl ריק — תיווצר תמונה אחת ב-AI." },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["campaignType", "name", "headline"],
      },
    },
    run: async (args, rc) => {
      // Prefer pre-made creatives (already generated + billed via edit_ad_image/
      // generate_ad_image). Only auto-generate one AI image when none were supplied.
      let imageUrls = Array.isArray(args.imageUrls) ? args.imageUrls.filter(Boolean) : [];
      if (!imageUrls.length && args.imageUrl) imageUrls = [args.imageUrl];
      if (!imageUrls.length) imageUrls = [await generateLaunchImage(rc, args)];
      return fbActions.launchCampaign(rc.creds, { ...args, imageUrls });
    },
    summarize: (args) => `השקת קמפיין ${args.campaignType === "traffic" ? "תנועה" : "לידים"} "${args.name}" (${args.dailyBudgetIls || "?"}₪/יום)`,
  },

  create_social_campaign: {
    write: true,
    def: {
      name: "create_social_campaign",
      description: "יוצר קמפיין סושיאל אורגני: מייצר X פוסטים בעיצוב מותג ב-AI (טקסט+תמונה) ומתזמן אותם לפרסום אוטומטי לעמוד הפייסבוק והאינסטגרם של הלקוח בזמנים שנקבעו. פעולה רגישה — דורשת אישור לפני ביצוע. חובה schedule (זמני פרסום) כדי שהפוסטים יתפרסמו.",
      input_schema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 10, description: "מספר הפוסטים לייצר (ברירת מחדל 5)" },
          concept: { type: "string", description: "הנושא/קונספט של הפוסטים — על מה הם (למשל 'חופשות רומנטיות באירופה')" },
          importantInfo: { type: "array", items: { type: "string" }, description: "נקודות שחשוב לשלב בפוסטים (אופציונלי)" },
          cta: { type: "string", description: "קריאה לפעולה (אופציונלי)" },
          schedule: {
            type: "array",
            description: "זמני פרסום. כל פריט: {time:'HH:MM', days:[אותיות ימים בעברית: א=ראשון ... ש=שבת]}",
            items: {
              type: "object",
              properties: {
                time: { type: "string", description: "שעה HH:MM" },
                days: { type: "array", items: { type: "string" }, description: "ימים: א ב ג ד ה ו ש" },
              },
              required: ["time", "days"],
            },
          },
          reason: { type: "string", description: "נימוק קצר ללקוח" },
        },
        required: ["concept", "schedule"],
      },
    },
    run: async (args, rc) => {
      const { autoFulfillSocialCampaign } = require("../social-campaign.service");
      // NO pkg → on failure it throws (runBilled refunds) and the manager is NOT involved.
      const out = await autoFulfillSocialCampaign({
        phone: rc.phone,
        brief: { concept: args.concept, importantInfo: args.importantInfo || [], cta: args.cta },
        schedule: args.schedule,
        countOverride: args.count || 5,
        facebook: {}, instagram: {}, // hydrated by the publish cron at publish time
      });
      if (!out) throw new Error("יצירת הקמפיין הסושיאלי נכשלה");
      return { success: true, posts: out.posts, orderId: out.orderId, slots: out.slots,
        note: `נוצרו ${out.posts} פוסטים אורגניים ותוזמנו לפרסום אוטומטי לפי הזמנים שנבחרו.` };
    },
    summarize: (args) => `יצירת ${args.count || 5} פוסטים אורגניים + תזמון פרסום`,
  },

  /* ── IMAGE FILING — file an image the CLIENT uploaded into their profile.
     Operates on rc.pendingImageUrl (the just-uploaded image), never a model arg.
     Free (no tokens); auto (no approval — it's the client's own photo). ─────── */
  add_to_gallery: {
    write: true,
    def: {
      name: "add_to_gallery",
      description: "מוסיף את התמונה שהלקוח העלה זה עתה לגלריית העסק בפרופיל. השתמש בזה תמיד כשהלקוח מעלה תמונה. ללא פרמטרים — התמונה נלקחת מההעלאה האחרונה.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => {
      if (!rc.pendingImageUrl) return { error: "אין תמונה מצורפת לשיוך" };
      const bp = require("../business-profile-write.service");
      const r = await bp.addToGallery(rc.phone, rc.pendingImageUrl);
      return r.ok ? { ok: true, note: "התמונה נוספה לגלריית העסק." } : { error: r.error };
    },
    summarize: () => "הוספת תמונה לגלריה",
  },

  attach_image_to_service: {
    write: true,
    def: {
      name: "attach_image_to_service",
      description: "משייך את התמונה שהלקוח העלה זה עתה לשירות ספציפי בפרופיל (לפי serviceId מרשימת 'מזהי שירותים' בקונטקסט). השתמש בזה כשהתמונה מתאימה בבירור לשירות מסוים. אל תמציא serviceId.",
      input_schema: {
        type: "object",
        properties: { serviceId: { type: "string", description: "מזהה השירות מרשימת מזהי השירותים בקונטקסט" } },
        required: ["serviceId"],
      },
    },
    run: async (args, rc) => {
      if (!rc.pendingImageUrl) return { error: "אין תמונה מצורפת לשיוך" };
      const bp = require("../business-profile-write.service");
      const r = await bp.addToService(rc.phone, args.serviceId, rc.pendingImageUrl);
      return r.ok ? { ok: true, note: "התמונה שויכה לשירות." } : { error: r.error };
    },
    summarize: (args) => `שיוך תמונה לשירות ${args.serviceId || ""}`,
  },

  /* ── PROFILE (אפיון) WRITES — the agent fills the client's characterization in
     conversation. Free, auto. Never invents facts — only what the client stated. ── */
  update_profile: {
    write: true,
    def: {
      name: "update_profile",
      description: "מעדכן את אפיון העסק (הפרופיל) בשדות שהלקוח מסר בשיחה. עדכן רק שדות שהלקוח אמר במפורש — אל תמציא. שלח רק את השדות שהשתנו.",
      input_schema: {
        type: "object",
        properties: {
          businessName: { type: "string", description: "שם העסק" },
          businessField: { type: "string", description: "תחום/קטגוריה של העסק" },
          about: { type: "string", description: "תיאור קצר של העסק (\"עלינו\")" },
          targetAudience: { type: "array", items: { type: "string" }, description: "קהלי יעד" },
          designStyle: { type: "string", description: "סגנון עיצוב מועדף (אופציונלי)" },
        },
        required: [],
      },
    },
    run: async (args, rc) => {
      const bp = require("../business-profile-write.service");
      const r = await bp.updateProfile(rc.phone, args);
      return r.ok ? { ok: true, updated: r.updated, note: `עודכנו בפרופיל: ${r.updated.join(", ")}` } : { error: r.error };
    },
    summarize: (args) => `עדכון פרופיל (${Object.keys(args || {}).join(", ")})`,
  },

  add_service: {
    write: true,
    def: {
      name: "add_service",
      description: "מוסיף שירות חדש לפרופיל העסק (כותרת + תיאור קצר). השתמש כשהלקוח מספר על שירות/מוצר שהוא מציע ואינו קיים עדיין בפרופיל.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "שם השירות" },
          description: { type: "string", description: "תיאור קצר של השירות (אופציונלי)" },
        },
        required: ["title"],
      },
    },
    run: async (args, rc) => {
      const bp = require("../business-profile-write.service");
      const r = await bp.addService(rc.phone, args);
      return r.ok ? { ok: true, serviceId: r.serviceId, note: `נוסף שירות: ${r.title} (אפשר לשייך אליו תמונות עם serviceId=${r.serviceId})` } : { error: r.error };
    },
    summarize: (args) => `הוספת שירות: ${args.title || ""}`,
  },

  set_logo: {
    write: true,
    def: {
      name: "set_logo",
      description: "מגדיר את הלוגו של העסק מהתמונה שהלקוח העלה זה עתה. השתמש כשהלקוח אומר שהתמונה שהעלה היא הלוגו שלו.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    run: async (_args, rc) => {
      if (!rc.pendingImageUrl) return { error: "אין תמונה מצורפת" };
      const bp = require("../business-profile-write.service");
      const r = await bp.setLogo(rc.phone, rc.pendingImageUrl);
      return r.ok ? { ok: true, note: "הלוגו עודכן." } : { error: r.error };
    },
    summarize: () => "עדכון לוגו",
  },

  /* ── HUMAN HAND-OFF — opens a ticket in the manager's queue + alerts them.
     Free (no tokens), no approval. The client just gets a normal reply. ─────── */
  escalate_to_human: {
    write: false,
    def: {
      name: "escalate_to_human",
      description: "מעביר את הלקוח לטיפול מנהל אנושי: פותח פנייה מסודרת בתור של המנהל (נשמרת ונראית ב-CPANEL ובמערכת המנהלים) ומתריע לו. **התחום שלך הוא שיווק ופרסום בלבד** — קמפיינים, מודעות, לידים, תקציב, ותוכן. **כל נושא שאינו שיווקי — הסלם לאדם**, אל תנסה לענות עליו או להמציא מידע. הסלם ל: חיוב/תשלום/חשבונית (billing), תקלה טכנית או באג באפליקציה (technical), שינוי/ביטול מנוי או פרטי חשבון (account), בקשת ביטול/החזר כספי (cancellation), טענה חוזית או תיקוני דף נחיתה (landing_page), חוסר שביעות רצון (dissatisfied), תלונה (complaint), בקשה חוזרת לדבר עם אדם שנמשכת גם אחרי שביררת והצעת עזרה או לקוח כועס/מתוסכל מאוד (human_request — מוצא אחרון בלבד), או כל דבר אחר מחוץ לשיווק (other). **חשוב מאוד: בקשת 'לדבר עם מישהו/נציג' סתמית אינה עילה להסלמה מיידית — אל תקרא לכלי הזה בפנייה כזו. קודם ברר בנימוס על מה מדובר ונסה לעזור; אם זה נושא שיווקי טפל בעצמך, והסלם רק אם הלקוח מתעקש על אדם או שהנושא מתברר כמחוץ לתחום (ואז בחר את הקטגוריה המדויקת, לא human_request).** אל תבטיח בעצמך החזר/ביטול/פיצוי/לוחות זמנים. **הקריאה לכלי הזה שקטה לחלוטין: אל תספר ללקוח/ה שהעברת, למי העברת, שפתחת פנייה, או שמישהו יחזור אליו/ה. אל תזכיר את נוי, את המנהלת או את הצוות.** אחרי הקריאה ענה משפט קצר בגוף ראשון בלבד — למשל \"אני בודק את זה\" — בלי הבטחת מענה ובלי לוח זמנים.",
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["billing", "technical", "account", "cancellation", "landing_page", "dissatisfied", "complaint", "human_request", "other"], description: "סוג הפנייה — בחר את המדויק ביותר" },
          summary: { type: "string", description: "תקציר קצר וברור של מה שהלקוח מבקש/מתלונן, בעברית — כדי שהמנהל יבין מיד" },
        },
        required: ["category", "summary"],
      },
    },
    run: async (args, rc) => {
      const esc = require("./escalation.service");
      const out = await esc.createEscalation({ phone: rc.phone, category: args.category, summary: args.summary, clientMessage: args.summary });
      return { ...out, note: "נפתחה פנייה לגורם האנושי המתאים. אמור ללקוח/ה בחום שהעברת את זה לטיפול ושיחזרו אליו/ה בהקדם כאן בצ'אט. שמור על מגדר: על עצמך לשון זכר, על המנהלת נוי לשון נקבה, ואל הלקוח/ה לפי מגדרו/ה." };
    },
    summarize: (args) => `העברה למנהל אנושי (${args.category})`,
  },
};

/** Tool defs for the Claude API. `{ includeWrites:false }` → read-only mode. */
function toolDefs({ includeWrites = true } = {}) {
  return Object.values(TOOLS)
    .filter(t => includeWrites || !t.write)
    .map(t => t.def);
}

function getTool(name) {
  return TOOLS[name] || null;
}

module.exports = { TOOLS, toolDefs, getTool };
