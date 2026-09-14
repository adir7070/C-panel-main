/**
 * WOW Landing Page — AI-generated landing page pipeline.
 *
 * Pipeline:
 *   Stage 1: OpenAI → brand_strategy + landing_page (rich Hebrew sections) +
 *            image_prompts + design_theme (one JSON call).
 *   Stage 2: Gemini → key images (parallel) — uploaded to Backblaze.
 *   Stage 3: Deterministic template engine (utils/wow-lp-template) →
 *            a complete, premium RTL WOW landing page, stored on the session as
 *            `html`. The public preview serves this HTML directly.
 *
 * The template engine picks an industry/tone PRESET (palette + fonts + vibe) so
 * a beauty clinic, a luxury tailor and a SaaS app each get a fitting look — not
 * one generic theme. Brand colors (preferredColors / AI design_theme) override
 * the preset palette.
 *
 * Storage:
 *   - Mongo: `wow_lp_sessions` { sessionId, phone, status, brief, brand_strategy,
 *       landing_page, design_theme, image_prompts[], images[], html, preset,
 *       approvalToken, approvalStatus, productStatus, packageId, ... }
 *   - Backblaze: `wow-lp/{phone}/{sessionId}/{slot}.png`
 *
 * Backward-compatible: keeps every exported function and the session schema the
 * controller / cpanel / approval flow rely on. `html` is additive — the
 * controller serves it when present and falls back to its legacy renderer.
 */

const { OpenAI }      = require("openai");
const { GoogleGenAI } = require("@google/genai");
const googleAIConfig  = require("../config/google-ai.config");
const { getDB }       = require("../config/db");
const { uploadImage } = require("./backblaze.service");
const { formatBrandPalette } = require("../utils/brand-palette");
const { renderWowLandingPage, pickPreset } = require("../utils/wow-lp-template");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });
const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || googleAIConfig.apiKey,
});

const OPENAI_MODEL       = process.env.OPENAI_LP_MODEL || "gpt-4o";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || googleAIConfig.model || "gemini-3-pro-image-preview";

/* Where the on-page lead form POSTs (no-cors). Overridable per brief. */
const LEAD_WEBHOOK = process.env.LP_LEAD_WEBHOOK_URL || googleAIConfig.webhookUrl || null;

const CONCURRENCY = 4;

/* Image slots that have a designated image area in the WOW template. Generated
   upfront so the page looks complete on first render. Kept to a sane count to
   keep latency reasonable for cpanel use. */
const KEY_IMAGE_SLOTS = [
  "hero",
  "about",
  "services_1", "services_2", "services_3",
  "gallery_1", "gallery_2", "gallery_3", "gallery_4",
  "final_cta",
];

const sessionsCol = () => getDB().collection("wow_lp_sessions");

/* ──────────────────────────────────────────────────────────────────── */

function buildContentPrompt(brief) {
  return `אתה אסטרטג מותג ישראלי וקופירייטר מקצועי לדפי נחיתה ברמה גבוהה.
החזר JSON תקני בלבד (ללא Markdown, בלי הסברים, בלי טקסט מחוץ ל-JSON).

נתוני העסק:
- שם: ${brief.businessName}
- תחום: ${brief.industry}
- קהל יעד: ${brief.targetAudience}
- מטרה ראשית: ${brief.primaryGoal}
- הצעת ערך עיקרית: ${brief.keyOffer}
- טון מותג: ${brief.brandTone}
- סגנון עיצוב: ${brief.designStyle}
- טקסט CTA: ${brief.callToActionText}
${brief.preferredColors ? (() => { const p = formatBrandPalette(brief.preferredColors); return p ? `- צבעים מועדפים: ${p}` : ""; })() : ""}

החזר JSON במבנה הבא בדיוק (כל הטקסטים בעברית שיווקית, חדה וברורה):

{
  "brand_strategy": {
    "tagline": "כותרת תיוג עד 6 מילים",
    "valueProposition": "הצעת הערך, 1-2 משפטים",
    "brandVoice": "תיאור הטון",
    "targetPersona": "פרסונה ב-2-3 משפטים",
    "competitiveDifferentiator": "במה אנחנו שונים, 1-2 משפטים"
  },
  "landing_page": {
    "header": { "logoText": "שם קצר/ראשי תיבות", "navItems": [ {"label":"שירותים","href":"#services"}, {"label":"עלינו","href":"#about"}, {"label":"איך זה עובד","href":"#process"}, {"label":"שאלות","href":"#faq"}, {"label":"צור קשר","href":"#contact"} ], "ctaText": "צור קשר" },
    "hero": { "eyebrow": "תווית קצרה 2-4 מילים", "headline": "כותרת ראשית עד 8 מילים", "headlineHighlight": "2-3 המילים בכותרת שיודגשו בגרדיאנט (תת-מחרוזת מתוך headline)", "subheadline": "תת-כותרת 1-2 משפטים", "ctaText": "טקסט כפתור 2-4 מילים", "ctaSubtext": "שורה קצרה מתחת לכפתור" },
    "stats": { "items": [ {"value":"15+","label":"שנות ניסיון"}, {"value":"1200","label":"לקוחות מרוצים"}, {"value":"4.9","label":"דירוג ממוצע"}, {"value":"24/7","label":"זמינות"} ] },
    "services": { "heading": "כותרת קצרה", "subheading": "משפט הסבר", "items": [ {"title":"שירות","description":"1-2 משפטים","icon":"אימוג'י אחד"}, "...4-6 פריטים" ] },
    "about": { "heading": "3-5 מילים", "body": "120-180 מילים, 2 פסקאות מופרדות בשורה ריקה", "points": [ "נקודת חוזק קצרה", "...3-4 נקודות" ] },
    "why_us": { "heading": "כותרת", "points": [ {"title":"כותרת קצרה","description":"2-3 משפטים"}, "...4 נקודות" ] },
    "process": { "heading": "כותרת", "steps": [ {"step":1,"title":"כותרת","description":"תיאור קצר"}, "...4-5 שלבים" ] },
    "gallery": { "heading": "כותרת גלריה", "subheading": "משפט קצר" },
    "testimonials": { "heading": "כותרת", "items": [ {"name":"שם ישראלי","role":"תפקיד/עיר","quote":"ציטוט 2-3 משפטים","rating":5}, "...3 המלצות" ] },
    "lead": { "heading": "רוצים שנחזור אליכם?", "subheading": "משפט עידוד קצר", "ctaText": "טקסט כפתור" },
    "faq": { "heading": "שאלות נפוצות", "items": [ {"question":"...","answer":"..."}, "...5-6 שאלות" ] },
    "final_cta": { "heading": "עד 8 מילים", "subheading": "1-2 משפטים", "ctaText": "טקסט כפתור" },
    "footer": { "tagline": "סלוגן קצר", "contactPhone": "טלפון אם ידוע אחרת ריק", "contactEmail": "אימייל אם ידוע אחרת ריק", "address": "כתובת אם ידועה אחרת ריק", "hours": "שעות פעילות אם ידועות אחרת ריק", "copyright": "© 2026 ${brief.businessName}. כל הזכויות שמורות." }
  },
  "image_prompts": [
    { "id": 1, "section": "hero",       "prompt": "Vivid English prompt, no text, no logos, cinematic premium commercial photography, photorealistic" },
    { "id": 2, "section": "about",      "prompt": "..." },
    { "id": 3, "section": "services_1", "prompt": "..." },
    { "id": 4, "section": "services_2", "prompt": "..." },
    { "id": 5, "section": "services_3", "prompt": "..." },
    { "id": 6, "section": "gallery_1",  "prompt": "..." },
    { "id": 7, "section": "gallery_2",  "prompt": "..." },
    { "id": 8, "section": "gallery_3",  "prompt": "..." },
    { "id": 9, "section": "gallery_4",  "prompt": "..." },
    { "id": 10, "section": "final_cta", "prompt": "..." }
  ],
  "design_theme": {
    "primaryColor":   "#hex",
    "secondaryColor": "#hex",
    "accentColor":    "#hex",
    "radius":         18,
    "fontFamily":     "Heebo"
  }
}

חוקים:
- ה-image_prompts באנגלית בלבד; כל שאר הטקסטים בעברית.
- headlineHighlight חייב להיות תת-מחרוזת מדויקת מתוך headline.
- אסור צבעים סגולים/violet/purple ב-design_theme.
- ערכי הצבעים חייבים לכבד את הצבעים המועדפים אם סופקו.
- אל תמציא פרטי קשר (טלפון/כתובת) אם אינם בנתונים — השאר מחרוזת ריקה.`;
}

function buildImagePrompt(rawPrompt, brief) {
  return `${rawPrompt}\n\nQuality: cinematic lighting, ultra high resolution, premium commercial photography, no text overlays, no logos, no human faces. Aesthetic: ${brief.designStyle || "modern minimal"}, ${brief.brandTone || "professional"}.`;
}

/* ──────────────────────────────────────────────────────────────────── */

async function generateContent(brief) {
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are an Israeli brand strategist and conversion copywriter. Always respond with valid JSON in the exact structure requested. All visible text must be in Hebrew except image_prompts (English only)." },
      { role: "user",   content: buildContentPrompt(brief) },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "{}";
  return JSON.parse(raw);
}

async function generateImageBuffer(prompt, attempt = 1) {
  try {
    const resp = await gemini.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const parts = resp?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.data);
    if (!imgPart) throw new Error("Gemini returned no image");
    return Buffer.from(imgPart.inlineData.data, "base64");
  } catch (err) {
    if (attempt >= 3) throw err;
    const wait = [500, 2000, 4500][attempt - 1] || 1000;
    await new Promise(r => setTimeout(r, wait));
    return generateImageBuffer(prompt, attempt + 1);
  }
}

async function generateImagesParallel(prompts, brief, sessionId, phone, onProgress) {
  const results = [];
  let inFlight = 0;
  let cursor = 0;
  let completed = 0;

  return new Promise((resolve) => {
    const tick = () => {
      while (inFlight < CONCURRENCY && cursor < prompts.length) {
        const item = prompts[cursor++];
        inFlight++;
        (async () => {
          try {
            const buf = await generateImageBuffer(buildImagePrompt(item.prompt, brief));
            const fullPath = `wow-lp/${phone}/${sessionId}/${item.section}.png`;
            await uploadImage(fullPath, buf, "image/png");
            const proxyUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;
            results.push({ id: item.id, section: item.section, url: proxyUrl });
          } catch (err) {
            results.push({ id: item.id, section: item.section, error: err.message || "image failed" });
          } finally {
            inFlight--;
            completed++;
            if (onProgress) onProgress(completed, prompts.length);
            if (completed === prompts.length) resolve(results);
            else tick();
          }
        })();
      }
    };
    tick();
  });
}

/* ──────────────────────────────────────────────────────────────────── */
/* Render the full WOW HTML for a session and persist it on the doc. Called at
   the end of the pipeline and after any content/image mutation so the public
   preview always reflects the latest state. Never throws — rendering failures
   must not corrupt the session. */
async function renderAndStoreHtml(sessionId, sessOverride) {
  try {
    const sess = sessOverride || await sessionsCol().findOne({ sessionId });
    if (!sess || !sess.landing_page) return null;
    const html = renderWowLandingPage({
      landing_page: sess.landing_page,
      design_theme: sess.design_theme,
      images:       sess.images || [],
      brief:        sess.brief || {},
      leadWebhook:  (sess.brief && sess.brief.leadWebhook) || LEAD_WEBHOOK,
      year:         new Date().getFullYear(),
    });
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { html, htmlUpdatedAt: new Date(), updatedAt: new Date() } }
    );
    return html;
  } catch (err) {
    console.error(`[wow-lp] html render failed for ${sessionId}:`, err.message);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────── */

async function runLpPipeline(sessionId, phone, brief) {
  const preset = pickPreset(brief || {});

  await sessionsCol().updateOne(
    { sessionId },
    {
      $set: {
        sessionId, phone,
        status: "generating_content",
        brief,
        preset,
        packageId: brief?.packageId || null,
        approvalStatus: "draft",
        productStatus:          "sent_for_creation",
        productStatusUpdatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  try {
    /* Stage 1 — content */
    const content = await generateContent(brief);

    /* Fold the chosen preset into design_theme so the renderer + cpanel UI agree. */
    const design_theme = { ...(content.design_theme || {}), preset };

    await sessionsCol().updateOne(
      { sessionId },
      {
        $set: {
          brand_strategy: content.brand_strategy,
          landing_page:   content.landing_page,
          design_theme,
          image_prompts:  content.image_prompts,
          status:         "generating_images",
          totalImages:    (content.image_prompts || []).slice(0, KEY_IMAGE_SLOTS.length).length,
          completedImages: 0,
          updatedAt:      new Date(),
        },
      }
    );

    /* Stage 2 — generate images for designated slots. Use the AI prompt when
       present, else synthesize from the section content. */
    const fromAi  = content.image_prompts || [];
    const byKey   = new Map(fromAi.map(p => [p.section, p]));
    let nextId    = fromAi.reduce((m, p) => Math.max(m, p.id || 0), 0);

    const promptsToUse = [];
    for (const section of KEY_IMAGE_SLOTS) {
      const existing = byKey.get(section);
      if (existing?.prompt) { promptsToUse.push(existing); continue; }
      const synthesized = synthesizePromptFor(section, content.landing_page, brief);
      if (!synthesized) continue;
      nextId += 1;
      promptsToUse.push({ id: nextId, section, prompt: synthesized });
    }

    await sessionsCol().updateOne(
      { sessionId },
      { $set: { image_prompts: promptsToUse, totalImages: promptsToUse.length, updatedAt: new Date() } }
    );

    const images = await generateImagesParallel(
      promptsToUse,
      brief,
      sessionId,
      phone,
      (done, total) => {
        sessionsCol().updateOne(
          { sessionId },
          { $set: { completedImages: done, totalImages: total, updatedAt: new Date() } }
        ).catch(() => {});
      }
    );

    /* Stage 3 — render the WOW HTML and persist, then mark done. */
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { images, updatedAt: new Date() } }
    );
    await renderAndStoreHtml(sessionId);

    await sessionsCol().updateOne(
      { sessionId },
      {
        $set: {
          status:                  "done",
          productStatus:           "pending_manager_approval",
          productStatusUpdatedAt:  new Date(),
          updatedAt:               new Date(),
        },
      }
    );
  } catch (err) {
    console.error(`[wow-lp] pipeline failed for ${sessionId}:`, err);
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { status: "error", error: err.message || "unknown error", updatedAt: new Date() } }
    );
  }
}

async function regenerateImage(sessionId, section) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  let promptItem = (sess.image_prompts || []).find(p => p.section === section);

  if (!promptItem) {
    const synthesizedPrompt = synthesizePromptFor(section, sess.landing_page, sess.brief);
    if (!synthesizedPrompt) throw new Error("could not synthesize prompt for this section");
    const newId = ((sess.image_prompts || []).reduce((m, p) => Math.max(m, p.id || 0), 0)) + 1;
    promptItem = { id: newId, section, prompt: synthesizedPrompt };
    await sessionsCol().updateOne({ sessionId }, { $push: { image_prompts: promptItem } });
  }

  const buf = await generateImageBuffer(buildImagePrompt(promptItem.prompt, sess.brief));
  const fullPath = `wow-lp/${sess.phone}/${sessionId}/${section}_${Date.now()}.png`;
  await uploadImage(fullPath, buf, "image/png");
  const proxyUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;

  const next = (sess.images || []).filter(i => i.section !== section);
  next.push({ id: promptItem.id, section, url: proxyUrl, regeneratedAt: new Date().toISOString() });

  await sessionsCol().updateOne({ sessionId }, { $set: { images: next, updatedAt: new Date() } });
  await renderAndStoreHtml(sessionId);

  return { section, url: proxyUrl };
}

function synthesizePromptFor(section, lp, brief) {
  let m = section.match(/^services_(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const svc = lp?.services?.items?.[idx];
    if (!svc) return null;
    return `Premium commercial editorial photograph representing the service "${svc.title}": ${svc.description || ""}. Industry: ${brief?.industry || "business"}. Aesthetic: clean, minimal, modern, scroll-stopping. No text, no logos, no human faces.`;
  }
  m = section.match(/^gallery_(\d+)$/);
  if (m) {
    return `Editorial showcase photograph for ${brief?.businessName} (${brief?.industry}). Premium, atmospheric, magazine-quality, showing the work/product/space at its best. No text, no logos, no human faces.`;
  }
  m = section.match(/^process_(\d+)$/);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    const step = lp?.process?.steps?.[idx];
    if (!step) return null;
    return `Editorial photograph illustrating step ${idx + 1}: "${step.title}" — ${step.description || ""}. Industry: ${brief?.industry || "business"}. Cinematic, premium, atmospheric. No text, no logos, no faces.`;
  }
  if (section === "hero") {
    return `Hero image for ${brief?.businessName}. ${brief?.industry}. ${brief?.keyOffer || ""}. Cinematic, scroll-stopping, premium commercial photography. No text, no logos.`;
  }
  if (section === "about") {
    return `About-section image for ${brief?.businessName} (${brief?.industry}). Authentic, warm, professional. No text, no logos.`;
  }
  if (section === "why_us") {
    return `Why-choose-us editorial image for ${brief?.businessName} (${brief?.industry}). Premium, confident, trustworthy. No text, no logos.`;
  }
  if (section === "final_cta") {
    return `Aspirational CTA-section background for ${brief?.businessName}. ${brief?.primaryGoal || ""}. Atmospheric, evocative. No text, no logos.`;
  }
  return null;
}

async function uploadCustomImage(sessionId, section, buffer, mimeType) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const ext = (mimeType || "image/png").split("/")[1] || "png";
  const fullPath = `wow-lp/${sess.phone}/${sessionId}/${section}_uploaded_${Date.now()}.${ext}`;
  await uploadImage(fullPath, buffer, mimeType || "image/png");
  const proxyUrl = `/api/img?url=${encodeURIComponent(fullPath)}`;

  const next = (sess.images || []).filter(i => i.section !== section);
  const existingPrompt = (sess.image_prompts || []).find(p => p.section === section);
  const id = existingPrompt?.id || (((sess.images || []).reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1);
  next.push({ id, section, url: proxyUrl, uploadedAt: new Date().toISOString() });

  await sessionsCol().updateOne({ sessionId }, { $set: { images: next, updatedAt: new Date() } });
  await renderAndStoreHtml(sessionId);

  return { section, url: proxyUrl };
}

/* Set a section's image to an existing URL (e.g. from the client's
   characterization gallery). No B2 re-upload — we just store the URL. */
async function setSectionImageFromUrl(sessionId, section, imageUrl) {
  if (!section) throw new Error("section required");
  if (typeof imageUrl !== "string" || !imageUrl) throw new Error("imageUrl required");
  if (imageUrl.startsWith("data:")) throw new Error("data: URLs are not allowed");

  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const next = (sess.images || []).filter(i => i.section !== section);
  const existingPrompt = (sess.image_prompts || []).find(p => p.section === section);
  const id = existingPrompt?.id || (((sess.images || []).reduce((m, x) => Math.max(m, x.id || 0), 0)) + 1);
  next.push({ id, section, url: imageUrl, fromGalleryAt: new Date().toISOString() });

  await sessionsCol().updateOne({ sessionId }, { $set: { images: next, updatedAt: new Date() } });
  await renderAndStoreHtml(sessionId);

  return { section, url: imageUrl };
}

async function applyTextPatch(sessionId, patches) {
  /* patches: [{ path: ["landing_page", "hero", "headline"], value: "new" }] */
  if (!Array.isArray(patches) || patches.length === 0) return;
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) throw new Error("session not found");

  const $set = { updatedAt: new Date() };
  for (const p of patches) {
    if (!Array.isArray(p.path) || p.path.length === 0) continue;
    const dotted = p.path.join(".");
    if (/[$]/.test(dotted)) continue; // basic safety
    $set[dotted] = p.value;
  }
  await sessionsCol().updateOne({ sessionId }, { $set });
  await renderAndStoreHtml(sessionId);
  return sessionsCol().findOne({ sessionId });
}

async function getSession(sessionId) {
  return sessionsCol().findOne({ sessionId });
}

/* Quiet-period before we declare a session stuck. v2 has long stages
   (gpt-5.5 high text fill ≈ 20-30s, 20 Gemini images ≈ 30-90s, full-
   HTML Hebrew rewrite ≈ 30-180s). Without per-stage heartbeats those
   gaps tripped a 5-min threshold during normal-but-slow runs. The
   runLpPipelineV2 path now heartbeats updatedAt between stages, but
   we still keep the threshold generous so a single slow Gemini retry
   can't blow up the whole render. */
const STUCK_THRESHOLD_MS = 12 * 60 * 1000;
/* Shared with the boot resume scanner (resumeStuckLpSessions): a session
   carrying THIS exact error only "failed" because a deploy cycled the dyno,
   so it is auto-recoverable. A genuine pipeline error sets a different
   message and stays failed. */
const RESTART_STUCK_REASON = "תהליך הייצור נתקע (כנראה השרת התרענן באמצע). לחץ 'ייצר מחדש'.";
async function autoFailIfStuck(sess) {
  if (!sess || sess.status === "done" || sess.status === "error") return sess;
  const lastTouch = sess.updatedAt ? new Date(sess.updatedAt).getTime() : 0;
  if (Date.now() - lastTouch < STUCK_THRESHOLD_MS) return sess;

  console.warn(`[wow-lp] auto-failing stuck session ${sess.sessionId} (status=${sess.status})`);
  await sessionsCol().updateOne(
    { sessionId: sess.sessionId },
    { $set: { status: "error", error: RESTART_STUCK_REASON, updatedAt: new Date() } }
  );
  return { ...sess, status: "error", error: RESTART_STUCK_REASON };
}

async function getLatestSessionForPhone(phone) {
  const sess = await sessionsCol().find({ phone }).sort({ createdAt: -1 }).limit(1).next();
  return autoFailIfStuck(sess);
}

async function setApprovalToken(sessionId) {
  const token = `lpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  await sessionsCol().updateOne(
    { sessionId },
    { $set: { approvalToken: token, approvalStatus: "sent", sentForApprovalAt: new Date(), updatedAt: new Date() } }
  );
  return token;
}

async function getSessionByApprovalToken(token) {
  return sessionsCol().findOne({ approvalToken: token });
}

async function setApprovalDecision(token, decision, feedback) {
  if (!["approved", "rejected"].includes(decision)) throw new Error("invalid decision");
  await sessionsCol().updateOne(
    { approvalToken: token },
    {
      $set: {
        approvalStatus: decision,
        clientResponseAt: new Date(),
        clientFeedback: feedback || null,
        updatedAt: new Date(),
      },
    }
  );
}

/* Generic field updater — used by the deploy-netlify controller to
   persist the cached siteId / public URL on the session so subsequent
   redeploys land on the same Netlify site (stable URL for the client). */
async function updateSessionFields(sessionId, fields) {
  if (!sessionId || !fields) return;
  await sessionsCol().updateOne(
    { sessionId },
    { $set: { ...fields, updatedAt: new Date() } },
  );
}

/* ── v2 pipeline ──────────────────────────────────────────────────────
   Runs the template-driven engine (services/wow-lp-v2.service.js) end-
   to-end inside a wow_lp_sessions document, so the cpanel polling /
   send-for-approval / deploy-to-netlify surfaces see the same
   {status, completedImages, totalImages, html, error} shape they
   already speak.

   Two-stage flow:
     1. status = "generating_content"
        gpt-4o fills every {{KEY}} from the brief.
     2. status = "generating_images"
        Gemini generates one image per image-key the AI couldn't
        cover from brief.images / brief.logo. completedImages /
        totalImages stream live so the cpanel progress bar moves.
     3. status = "done"
        sess.html is the rendered template + AI text + generated
        images. The existing send-for-approval and deploy-to-netlify
        endpoints take it from here.

   Template selection happens inside renderLandingPageV2 via the AI
   picker (services/wow-lp-v2.service.js → pickTemplateWithAI), so the
   pipeline doesn't need to pre-compute a name — it just records the
   one the renderer chose. */
async function runLpPipelineV2(sessionId, phone, brief, forceTemplate = null) {
  const v2 = require("./wow-lp-v2.service");

  await sessionsCol().updateOne(
    { sessionId },
    {
      $set: {
        sessionId, phone,
        status: "generating_content",
        brief,
        engine: "v2",
        forcedTemplate: forceTemplate,
        packageId: brief?.packageId || null,
        approvalStatus: "draft",
        productStatus:          "sent_for_creation",
        productStatusUpdatedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  /* Heartbeat — bumps updatedAt at each stage so a normal-but-long
     pipeline doesn't trip the STUCK_THRESHOLD. The v2 render has
     several silent stages (gpt-5.5 text fill, full-HTML rewrite)
     where no other write happens for minutes at a time. */
  const heartbeat = (status, extra = {}) =>
    sessionsCol().updateOne(
      { sessionId },
      { $set: { status, ...extra, updatedAt: new Date() } }
    ).catch(() => {});

  /* Background heartbeat tick — fires every 45s during silent
     stretches so updatedAt keeps moving even when no logical stage
     transition happens. Cleared as soon as the pipeline finishes
     (or errors), and on the long stages where the only natural
     'I'm alive' signal is an OpenAI/Gemini call returning. */
  let lastStatus = "generating_content";
  const heartbeatTimer = setInterval(() => {
    sessionsCol().updateOne(
      { sessionId },
      { $set: { updatedAt: new Date(), status: lastStatus } }
    ).catch(() => {});
  }, 45_000);

  try {
    const result = await v2.renderLandingPageV2({
      brief,
      sessionId,
      phone,
      template: forceTemplate,
      onImageProgress: (done, total) => {
        lastStatus = "generating_images";
        sessionsCol().updateOne(
          { sessionId },
          {
            $set: {
              status: "generating_images",
              completedImages: done,
              totalImages:     total,
              updatedAt:       new Date(),
            },
          }
        ).catch(() => {});
      },
    });
    void heartbeat;

    await sessionsCol().updateOne(
      { sessionId },
      {
        $set: {
          status:                  "done",
          html:                    result.html,
          templateName:            result.templateName,
          v2: {
            templateName:     result.templateName,
            placeholderCount: result.placeholders.length,
            valueCount:       Object.keys(result.values || {}).length,
            imagesGenerated:  result.imagesGenerated,
            imagesTotal:      result.imagesTotal,
            sectionsBefore:   result.sectionsBefore,
            sectionsAdded:    result.sectionsAdded,
            sectionsTotal:    result.sectionsTotal,
            renderedAt:       new Date(),
          },
          completedImages:         result.imagesGenerated,
          totalImages:             result.imagesTotal,
          productStatus:           "pending_manager_approval",
          productStatusUpdatedAt:  new Date(),
          updatedAt:               new Date(),
        },
      }
    );
  } catch (err) {
    console.error(`[wow-lp-v2] pipeline failed for ${sessionId}:`, err);
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { status: "error", error: err.message || "unknown error", updatedAt: new Date() } }
    );
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/* ── Resume after a deploy ─────────────────────────────────────────────
   The LP render (runLpPipelineV2 → renderLandingPageV2) has no per-step
   checkpoint, so a "resume" re-runs the whole render with the session's
   stored brief: text + images are regenerated. The win is that a manager
   no longer has to click "ייצר מחדש" by hand after a dyno cycle — the
   landing page recovers on its own. runLpPipelineV2 $sets status back to
   "generating_content", so re-entry overwrites the auto-fail "error".
   Idempotent: skips sessions already done. NOTE: re-running the pipeline
   directly does NOT re-charge coins (that happens in the controller). */
async function resumeLpSession(sessionId) {
  const sess = await sessionsCol().findOne({ sessionId });
  if (!sess) {
    console.warn(`[wow-lp:resume] session ${sessionId} not found`);
    return { skipped: "not found" };
  }
  if (sess.status === "done") return { skipped: "already done" };
  if (!sess.brief) {
    await sessionsCol().updateOne(
      { sessionId },
      { $set: { status: "error", error: "no brief on resume", updatedAt: new Date() } }
    );
    return { skipped: "no brief" };
  }
  console.log(`[wow-lp:resume] resuming ${sessionId} (status=${sess.status})`);
  return runLpPipelineV2(sessionId, sess.phone, sess.brief, sess.forcedTemplate || null);
}

/* Startup scanner: re-run every LP session left mid-flight, or auto-failed
   by the restart watchdog, when the server stopped. Mirrors the wow-ads /
   wow-organic resume scanners so a `git push` mid-generation doesn't leave
   a landing page stuck on the "server refreshed" error. Fire-and-forget
   per session. */
async function resumeStuckLpSessions() {
  try {
    const stuck = await sessionsCol().find({
      $or: [
        { status: { $in: ["generating_content", "generating_images"] } },
        { status: "error", error: RESTART_STUCK_REASON },
      ],
    }).toArray();
    if (stuck.length === 0) {
      console.log(`[wow-lp:resume] no stuck sessions found`);
      return { resumed: 0 };
    }
    console.log(`[wow-lp:resume] found ${stuck.length} stuck sessions to resume`);
    for (const sess of stuck) {
      resumeLpSession(sess.sessionId).catch(err =>
        console.error(`[wow-lp:resume] ${sess.sessionId} failed:`, err.message)
      );
    }
    return { resumed: stuck.length };
  } catch (err) {
    console.error(`[wow-lp:resume] scanner failed:`, err.message);
    return { resumed: 0, error: err.message };
  }
}

module.exports = {
  runLpPipeline,
  runLpPipelineV2,
  resumeLpSession,
  resumeStuckLpSessions,
  regenerateImage,
  uploadCustomImage,
  setSectionImageFromUrl,
  applyTextPatch,
  getSession,
  getLatestSessionForPhone,
  setApprovalToken,
  getSessionByApprovalToken,
  setApprovalDecision,
  /* additive — used by the controller to (re)render the stored HTML */
  renderAndStoreHtml,
  updateSessionFields,
};
