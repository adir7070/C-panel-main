const crypto = require("crypto");
const axios = require("axios");
const { OpenAI } = require("openai");
const { clientGalleryRefs } = require("../utils/profileImages");
const { DB } = require("../config/db");
const backblaze = require("../services/backblaze.service");
const { imageAgent } = require("../ai-agents/gemini");
// HQ quick-create: route the "צור סושיאל מהיר" / quick-ad image through gpt-image-2
// (CPANEL quality) instead of Gemini. Default-on, clean fallback to Gemini.
// Kill-switch: MOBILE_SOCIAL_HQ=false.
const { generateAdImageBuffer } = require("../services/campaign-brief-quality");
const MOBILE_QUICK_HQ = process.env.MOBILE_SOCIAL_HQ !== "false";
// Social quick-create copies the CPANEL ORGANIC design (value-first directive,
// 18 post-type layouts, Hebrew pixel-perfect + brand-color lock, gpt-image-2)
// from the self-contained copy in post-generation-quality.js — without touching
// any wow-organic / CPANEL file.
const { generateHqSocialPosts, fetchAssetBuffer } = require("../services/post-generation-quality");
const { buildSiteAnalysisPrompt } = require("../utils/prompts/ad-changes-site-analysis");
const aiService = require("../services/ai.service");
const creationProgress = require("../services/creation-progress.service");

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

const adPlans = () => DB.collection("ad_plans");
const adImageJobs = () => DB.collection("ad_image_jobs");

const MAKE_WEBHOOK_URL = "https://hook.eu2.make.com/avrksq8w0ce35m0ex3oyx8kpeokfo26p";
const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

const normalizePhone = (phone) => {
  let p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("+972")) p = "0" + p.slice(4);
  else if (p.startsWith("972")) p = "0" + p.slice(3);
  return p;
};

// ─── Upload logo from base64 → Backblaze → return proxy URL ─────────────────

async function uploadLogoIfNeeded(phone, briefSnapshot) {
  if (briefSnapshot?.logoUrl) return briefSnapshot.logoUrl;
  if (!briefSnapshot?.logoBase64) return null;
  try {
    const raw = briefSnapshot.logoBase64.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(raw, "base64");
    const logoPath = `logos/${phone}/logo.jpg`;
    await backblaze.uploadImage(logoPath, buf, "image/jpeg");
    const url = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(logoPath)}`;
    console.log(`✅ [AdImages] Logo uploaded → ${url}`);
    return url;
  } catch (e) {
    console.warn(`⚠️ [AdImages] Logo upload failed:`, e.message);
    return null;
  }
}

// ─── List images in a Backblaze folder → return AdImageItem[] ────────────────

async function listFolderImages(folder, numAds) {
  try {
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    const files = await backblaze.listFilesByPrefix(prefix);
    const imageFiles = files
      .filter((f) => IMAGE_EXTENSIONS.includes(f.fileName.split(".").pop().toLowerCase()))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));

    return imageFiles.map((f, i) => ({
      adIndex: i,
      imageUrl: `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(f.fileName)}`,
      status: "done",
    }));
  } catch (e) {
    console.warn(`⚠️ [AdImages] listFolderImages error:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// POST /api/ad-images/generate
// Body: { phone, sessionId? }
// ─────────────────────────────────────────────
exports.generateImages = async (req, res) => {
  try {
    const { phone: rawPhone, sessionId } = req.body;
    if (!rawPhone) return res.status(400).json({ error: "phone is required" });

    const phone = normalizePhone(rawPhone);
    const planQuery = sessionId ? { phone, sessionId } : { phone };

    // 1. Fetch approved plan
    const planDoc = await adPlans().findOne(planQuery);
    if (!planDoc) {
      return res.status(404).json({ error: "Ad plan not found. Please approve a plan first." });
    }

    const plan = planDoc.editedPlan ?? planDoc.originalPlan;
    if (!plan || plan.length === 0) {
      return res.status(400).json({ error: "Plan has no ads." });
    }

    const briefSnapshot = planDoc.briefSnapshot || {};
    const numAds = plan.length;
    const now = new Date();

    // 2. Upload logo if it's only in base64 form → get public URL
    const logoUrl = await uploadLogoIfNeeded(phone, briefSnapshot);

    // 3. Generate folder path
    const folder = `ad-campaigns/${phone}/campaign-${Date.now()}`;

    // 4. Get one-time Backblaze upload credentials for Make
    const b2Creds = await backblaze.getUploadCredentials();

    // 5. Build expected file names so Make knows where to save each image
    const fileNames = plan.map((_, i) => `${folder}/ad-${i + 1}.jpg`);

    // 6. Store job in DB (simple — no per-image tracking)
    await adImageJobs().insertOne({
      phone,
      ...(sessionId && { sessionId }),
      folder,
      numAds,
      status: "processing",
      createdAt: now,
      updatedAt: now,
    });

    // 7. Build webhook payload — everything Make needs to generate + upload images
    const webhookPayload = {
      // Identification
      phone,
      sessionId: sessionId || null,
      folder,
      numAds,
      fileNames, // ["ad-campaigns/.../ad-1.jpg", ...]

      // Backblaze upload credentials (Make uses b2_upload_file directly)
      uploadUrl: b2Creds.uploadUrl,
      uploadAuthToken: b2Creds.uploadAuthToken,
      bucketId: b2Creds.bucketId,

      // Business data
      plan,
      answers: briefSnapshot.answers || {},
      brandColors: briefSnapshot.brandColors || [],
      websiteUrl: briefSnapshot.websiteUrl || "",
      avatarUrl: briefSnapshot.selectedAvatar || null,
      logoUrl: logoUrl || null,
    };

    // 8. Send to Make (await so we catch webhook errors)
    console.log(`📤 [AdImages] Sending ${numAds} ads to Make webhook for phone=${phone}...`);
    const webhookRes = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });

    if (!webhookRes.ok) {
      const errText = await webhookRes.text().catch(() => "");
      console.error(`❌ [AdImages] Make webhook returned ${webhookRes.status}: ${errText}`);
      return res.status(502).json({ error: "Failed to trigger Make webhook", details: errText });
    }

    console.log(`✅ [AdImages] Make webhook triggered — folder: ${folder}, ${numAds} ads`);
    res.json({ success: true, folder, numAds });
  } catch (error) {
    console.error("❌ [AdImages] generateImages error:", error.message);
    res.status(500).json({ error: "Failed to start image generation", details: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-images/latest/:phone
// Lists images in the job's Backblaze folder
// ─────────────────────────────────────────────
exports.getLatestJob = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const { sessionId } = req.query;
    const query = sessionId ? { phone, sessionId } : { phone };

    const job = await adImageJobs()
      .find(query)
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();

    if (!job.length) return res.status(404).json({ error: "No jobs found" });

    const j = job[0];
    const images = await listFolderImages(j.folder, j.numAds);
    const completedAds = images.length;
    const status = completedAds >= j.numAds ? "completed" : "processing";

    // Persist completed status
    if (status === "completed" && j.status !== "completed") {
      await adImageJobs().updateOne(
        { _id: j._id },
        { $set: { status: "completed", updatedAt: new Date() } }
      );
    }

    res.json({
      success: true,
      folder: j.folder,
      status,
      totalAds: j.numAds,
      completedAds,
      images,
    });
  } catch (error) {
    console.error("❌ [AdImages] getLatestJob error:", error.message);
    res.status(500).json({ error: "Failed to fetch job", details: error.message });
  }
};

// ─────────────────────────────────────────────
// ─── Build rich image prompt for paid ad ─────────────────────────────────────

function buildQuickImagePrompt(ad, briefSnapshot, hasLogo) {
  const answers = briefSnapshot.answers || {};
  const infoRaw = answers["ad_quick_info"]?.raw || "";
  const ctaRaw = answers["ad_quick_cta"]?.raw || "";
  const conceptRaw = answers["ad_quick_concept"]?.raw || "";
  const serviceRaw = answers["ad_quick_service"]?.raw || "";

  const logoClause = hasLogo
    ? "the provided image is the business logo — render it ONCE as a small brand mark in the top-right corner, do NOT use it as background, style reference, or repeat it anywhere else in the ad,"
    : "";

  const colorsClause = briefSnapshot.brandColors?.length
    ? `use brand colors ${briefSnapshot.brandColors.join(", ")} as subtle accents in the CTA button, text highlights, or gradient tones,`
    : "";

  const ctaClause = ctaRaw && ctaRaw !== "(ללא)"
    ? `a clearly visible pill-shaped CTA button at the bottom center with high contrast reads exactly: "${ctaRaw}",`
    : "";

  const infoClause = infoRaw && infoRaw !== "(ללא)"
    ? `small info text just above the CTA button reads: "${infoRaw}",`
    : "";

  const conceptClause = conceptRaw && conceptRaw !== "(ללא)"
    ? `overall creative concept: ${conceptRaw},`
    : "";

  const serviceClause = serviceRaw && serviceRaw !== "(ללא)"
    ? `the advertised service/product is: "${serviceRaw}" — visually emphasize this in the scene and imagery,`
    : "";

  // Build single-line English prompt (following the premium prompt system)
  const parts = [
    "Ultra-realistic premium Facebook and Instagram sponsored ad creative, 1080x1080px square format,",
    // Visual scene — expand image_design into full cinematic description, do NOT copy it verbatim
    `full-bleed professional photography background: ${ad.image_design || "cinematic lifestyle scene, golden hour lighting, warm rich colors, aspirational mood"},`,
    serviceClause,
    conceptClause,
    logoClause,
    colorsClause,
    // Typography — STRICTLY ONCE each element, no repetition
    "Hebrew RTL text layout, right-to-left reading direction,",
    `dominant headline rendered EXACTLY ONCE in the upper-center area of the image: "${ad.title}" — premium bold typography, distinct elevated font style, white base with a stylish accent color highlight or glow on key words, large scroll-stopping size, strong shadow for depth,`,
    `supporting body text rendered EXACTLY ONCE below the headline across one or two balanced text clusters: "${ad.body}" — smaller font, light color, editorial feel, clean spacing,`,
    infoClause,
    ctaClause,
    "subtle dark gradient overlay on the bottom 35% of the image for text readability,",
    logoClause ? "logo appears only once in the top-right corner as described above — do not duplicate it," : "",
    "ultra realistic commercial photography, cinematic lighting, sharp focal point, premium mobile-first layout, high conversion scroll-stopping composition, polished luxury ad execution, realistic sponsored social media aesthetic, no text duplication, no repeated elements.",
  ].filter(Boolean).join(" ");

  return parts;
}

// ─── Generate GPT ad copy (separate from image text) ─────────────────────────

async function generateQuickCopy(ad, briefSnapshot) {
  const answers = briefSnapshot.answers || {};
  const infoRaw = answers["ad_quick_info"]?.raw || "";
  const ctaRaw = answers["ad_quick_cta"]?.raw || "";
  const conceptRaw = answers["ad_quick_concept"]?.raw || "";
  const serviceRaw = answers["ad_quick_service"]?.raw || "";

  const systemPrompt = `אתה קופירייטר מקצועי לפרסום ממומן בפייסבוק ואינסטגרם.
כתוב קופי שיווקי מלא למודעה. הקופי הוא טקסט משלים למודעה — לא הטקסט שעל התמונה.
מבנה חובה:
- שורה 1: משפט פתיחה מושך שעוצר גלילה (אמוג'י בהתחלה)
- 2-3 שורות: ערך, כאב, פתרון — אנושי ולא גנרי
- שורת מידע: אם יש טלפון/כתובת/אתר — שורה עם אמוג'י מתאים
- שורת סיום: הנעה לפעולה חזקה עם אמוג'י
פורמט: עברית, שורות קצרות, אמוג'י רלוונטיים, ללא hashtags.`;

  const userPrompt = [
    `נושא המודעה: ${ad.title}`,
    `תיאור: ${ad.body}`,
    serviceRaw && serviceRaw !== "(ללא)" ? `שירות/מוצר: ${serviceRaw}` : "",
    conceptRaw && conceptRaw !== "(ללא)" ? `רעיון: ${conceptRaw}` : "",
    infoRaw && infoRaw !== "(ללא)" ? `מידע לכלול: ${infoRaw}` : "",
    ctaRaw && ctaRaw !== "(ללא)" ? `CTA: ${ctaRaw}` : "",
  ].filter(Boolean).join("\n");

  try {
    const copy = await aiService.generateRawText(systemPrompt, userPrompt);
    console.log(`[QuickGen] ✓ GPT copy generated (${copy.length} chars)`);
    return copy;
  } catch (e) {
    console.warn(`[QuickGen] ⚠️ GPT copy failed, using fallback:`, e.message);
    return [ad.title, "", ad.body, infoRaw ? `📍 ${infoRaw}` : "", ctaRaw ? `👉 ${ctaRaw}` : ""].filter(Boolean).join("\n");
  }
}

// SOCIAL quick-create — produce ONE post at CPANEL ORGANIC design quality:
// value-first directive + per-post-type architecture + Hebrew pixel-perfect +
// brand-color lock + gpt-image-2, all copied in post-generation-quality.js.
// This is "copy what makes the CPANEL organic ads special, design-wise".
async function generateOrganicQuick(phone, briefSnapshot, onProgress = null) {
  const answers = briefSnapshot.answers || {};
  const v = (k) => { const r = answers[k]?.raw || ""; return r && r !== "(ללא)" ? r : ""; };
  const concept = v("ad_quick_concept");
  const cta     = v("ad_quick_cta");
  const info    = v("ad_quick_info");

  const prof = await DB.collection("business_profiles").findOne({ phone });
  if (!prof) throw new Error("business_profile not found");

  // Build the brief from the CHARACTERIZATION exactly like the CPANEL organic
  // pipeline's buildBriefForClient: full structured services (title + desc),
  // target audience, brand colors, design style, logo + reference photos.
  const services = (Array.isArray(prof.services) ? prof.services : [])
    .map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}`).join("; ");

  // Logo from the characterization (business_profiles.logoUrl), like CPANEL;
  // fall back to the logo the app cached on the device.
  const logoBuffer = prof.logoUrl
    ? await fetchAssetBuffer(prof.logoUrl)
    : (briefSnapshot.logoBase64 ? Buffer.from(briefSnapshot.logoBase64.replace(/^data:image\/\w+;base64,/, ""), "base64") : null);

  const imageBuffers = [];
  // Client photos: images[] + legacy generalImages[] (app uploads), deduped.
  for (const ref of clientGalleryRefs(prof).slice(0, 5)) {
    const b = await fetchAssetBuffer(ref);
    if (b) imageBuffers.push(b);
  }

  // The client picked which details MUST be in the ad ("מספר טלפון", "מחירים"…);
  // the app already resolved them to real values ("טלפון: 054…", "מחירים: …").
  // Keep only the resolved pieces (they carry a ":") so bare/unresolved labels
  // never leak onto the creative.
  // The app joins the resolved pieces with " | " (a delimiter that won't appear
  // inside an address or price list). Split on it and keep only resolved pieces
  // (they carry a ":"). Old comma-joined values stay as one kept piece.
  const infoPieces = info
    ? info.split("|").map(t => t.trim()).filter(t => t.includes(":"))
    : [];
  const infoLine = infoPieces.join(" · ");
  const subject = [concept, infoLine ? `לכלול במודעה את הפרטים: ${infoLine}` : ""]
    .filter(Boolean).join(" · ");

  const posts = await generateHqSocialPosts({
    count:           1,
    subject:         subject || "",
    cta:             cta || undefined,
    businessName:    prof.businessName,
    businessField:   prof.categoryKey,
    about:           prof.about,
    services,
    targetAudience:  Array.isArray(prof.targetAudience) ? prof.targetAudience : [],
    preferredColors: prof.preferredColors || null,
    designStyle:     prof.designStyle,
    logoBuffer,
    imageBuffers,
    onProgress,
  });
  const p = posts[0];
  if (!p?.imageBuffer) throw new Error(p?.error || "organic generation produced no image");

  const filePath = `social-quick/${phone}/${Date.now()}.png`;
  await backblaze.uploadImage(filePath, p.imageBuffer, "image/png");

  // Guarantee the selected details appear (the image model may drop them):
  // deterministically append the resolved pieces to the caption.
  let copy = p.promotionDescription || p.description || "";
  if (infoLine && !infoPieces.every(pc => copy.includes(pc))) {
    copy = `${copy}\n\n${infoLine}`.trim();
  }
  return {
    imageUrl: `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`,
    copy,
  };
}

// POST /api/ad-images/generate-quick
// Async: creates a job immediately, responds with jobId, generates in background.
// Client polls GET /api/ad-images/quick-status/:jobId for the result.
// organic:true → CPANEL ORGANIC design (social). else → quick-ad design.
// ─────────────────────────────────────────────
exports.generateQuick = async (req, res) => {
  try {
    const { phone: rawPhone, sessionId } = req.body;
    if (!rawPhone) return res.status(400).json({ error: "phone is required" });

    const phone = normalizePhone(rawPhone);
    const organic = req.body.organic === true || req.body.organic === "true";

    const { insertedId } = await adImageJobs().insertOne({
      phone,
      ...(sessionId && { sessionId }),
      type: "quick",
      organic,
      status: "processing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = insertedId.toString();

    // Respond immediately — work continues in background (avoids Heroku 30s timeout)
    res.json({ success: true, jobId, status: "processing" });

    _runQuickGenAsync(jobId, phone, sessionId, organic).catch(err => {
      console.error(`[QuickGen] background error for job ${jobId}:`, err.message);
    });
  } catch (error) {
    console.error("❌ [QuickGen] error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
};

const QUICK_GEN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function _runQuickGenAsync(jobId, phone, sessionId, organic) {
  const { ObjectId } = require("mongodb");
  const oid = new ObjectId(jobId);

  // Home-screen progress circle: 3 real units — plan loaded / image ready /
  // uploaded. Opened here (off the response path) so it never delays the client.
  const progressId = await creationProgress.startJob({
    phone, kind: "quick_ad", total: 3, refId: jobId,
  });

  const setStatus = (fields) =>
    adImageJobs().updateOne({ _id: oid }, { $set: { ...fields, updatedAt: new Date() } }).catch(() => {});

  // Wrap entire work in a timeout so a hung AI call can't leave the job processing forever
  const timeoutHandle = setTimeout(() => {
    console.error(`[QuickGen] job ${jobId} timed out after ${QUICK_GEN_TIMEOUT_MS / 1000}s`);
    setStatus({ status: "failed", error: "Generation timed out" });
    creationProgress.failJob(progressId, "TIMEOUT");
  }, QUICK_GEN_TIMEOUT_MS);

  try {
    console.log(`[QuickGen:bg] start phone=${phone} sessionId=${sessionId} organic=${organic}`);

    const planQuery = sessionId ? { phone, sessionId } : { phone };
    const planDoc = await adPlans().findOne(planQuery);
    if (!planDoc) {
      clearTimeout(timeoutHandle);
      await creationProgress.failJob(progressId, "Plan not found");
      return setStatus({ status: "failed", error: "Plan not found" });
    }

    const plan = planDoc.editedPlan ?? planDoc.originalPlan;
    if (!plan || plan.length === 0) {
      clearTimeout(timeoutHandle);
      await creationProgress.failJob(progressId, "Plan has no ads");
      return setStatus({ status: "failed", error: "Plan has no ads" });
    }

    await creationProgress.setProgress(progressId, 1);

    const ad = plan[0];
    const briefSnapshot = planDoc.briefSnapshot || {};
    const hasLogo = !!briefSnapshot.logoBase64;

    console.log(`[QuickGen:bg] plan found, organic=${organic} hasLogo=${hasLogo}`);

    // SOCIAL quick-create → copy the CPANEL ORGANIC design (not the ads prompt).
    if (organic && MOBILE_QUICK_HQ) {
      try {
        console.log(`[QuickGen:bg] → generateOrganicQuick`);
        // Rescale the HQ pipeline's internal units onto this job's 3 units so
        // the ring moves during the single-image generation instead of parking.
        const r = await generateOrganicQuick(phone, briefSnapshot, (done, units) =>
          creationProgress.setProgress(progressId, Math.round((done / Math.max(1, units)) * 3), { total: 3 }));
        if (r?.imageUrl) {
          console.log(`✅ [QuickGen:bg] organic done → ${r.imageUrl}`);
          clearTimeout(timeoutHandle);
          await creationProgress.completeJob(progressId);
          return setStatus({ status: "completed", imageUrl: r.imageUrl, copy: r.copy || null });
        }
        console.warn(`[QuickGen:bg] organic returned no imageUrl, falling back`);
      } catch (e) {
        console.error(`[QuickGen:bg] organic failed → falling back: ${e.message}\n${e.stack}`);
      }
    }

    const imagePrompt = buildQuickImagePrompt(ad, briefSnapshot, hasLogo);
    console.log(`[QuickGen:bg] → ad path hasLogo=${hasLogo}`);

    const [resultBuffer, copy] = await Promise.all([
      (async () => {
        const logoRaw = hasLogo ? briefSnapshot.logoBase64.replace(/^data:image\/\w+;base64,/, "") : null;
        if (MOBILE_QUICK_HQ) {
          try {
            console.log(`[QuickGen:bg:HQ] → gpt-image-2 (logo=${hasLogo})`);
            const logoBuffer = logoRaw ? Buffer.from(logoRaw, "base64") : null;
            const { buffer } = await generateAdImageBuffer(imagePrompt, logoBuffer, []);
            return buffer;
          } catch (hqErr) {
            console.error(`[QuickGen:bg:HQ] gpt-image-2 failed → Gemini fallback: ${hqErr.message}`);
          }
        }
        if (hasLogo) {
          const result = await imageAgent.editWithAssets(
            [{ base64: logoRaw, mimeType: "image/jpeg" }],
            imagePrompt,
            "The attached image is the business logo. Place it exactly once as a small brand mark in the top-right corner of the ad. Do not use it as a background, texture, or style reference anywhere else.",
          );
          return result.buffer;
        }
        const result = await imageAgent.generate(imagePrompt);
        return result.buffer;
      })(),
      generateQuickCopy(ad, briefSnapshot),
    ]);

    await creationProgress.setProgress(progressId, 2);

    const folder = `ad-campaigns/${phone}/campaign-${Date.now()}`;
    const filePath = `${folder}/ad-1.jpg`;
    console.log(`[QuickGen:bg] uploading → ${filePath}`);
    await backblaze.uploadImage(filePath, resultBuffer, "image/jpeg");

    const imageUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
    console.log(`✅ [QuickGen:bg] done → ${imageUrl}`);

    clearTimeout(timeoutHandle);
    await setStatus({ status: "completed", imageUrl, copy: copy || null });
    await creationProgress.completeJob(progressId);
  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error(`❌ [QuickGen:bg] error: ${error.message}\n${error.stack}`);
    await setStatus({ status: "failed", error: error.message });
    await creationProgress.failJob(progressId, error.message);
  }
}

// GET /api/ad-images/quick-status/:jobId
exports.getQuickJobStatus = async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const job = await adImageJobs().findOne({ _id: new ObjectId(req.params.jobId) });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status === "completed") {
      return res.json({ success: true, status: "completed", imageUrl: job.imageUrl, copy: job.copy || null });
    }
    if (job.status === "failed") {
      return res.json({ success: true, status: "failed", error: job.error || "Unknown error" });
    }
    // Auto-expire stale processing jobs — happens when Heroku restarts the dyno mid-task
    const staleSec = 6 * 60; // 6 minutes
    if (job.createdAt && (Date.now() - new Date(job.createdAt).getTime()) > staleSec * 1000) {
      await adImageJobs().updateOne(
        { _id: new ObjectId(req.params.jobId) },
        { $set: { status: "failed", error: "Job timed out (server restart)", updatedAt: new Date() } }
      ).catch(() => {});
      return res.json({ success: true, status: "failed", error: "Job timed out (server restart)" });
    }
    return res.json({ success: true, status: "processing" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ad-images/status/:jobId  (kept for backward compat)
// Redirects to phone-based folder lookup
// ─────────────────────────────────────────────
exports.getJobStatus = async (req, res) => {
  try {
    const job = await adImageJobs().findOne({ folder: { $exists: true } });
    // Legacy: just return by looking up the folder
    res.status(404).json({ error: "Use GET /api/ad-images/latest/:phone instead" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ad-images/generate-changes
// מקבל multipart/form-data מהאפליקציה, מריץ Gemini ומחזיר URL מ-Backblaze
// ─────────────────────────────────────────────

/**
 * בונה את מחרוזת הפרומפט מהשדות שנשלחו
 */
function buildChangesPrompt({ prompt, headline, body_text, notes }) {
  const parts = [];
  if (prompt && prompt !== "null" && prompt !== "") parts.push(`מה נרצה לראות בתמונה - ${prompt}`);
  if (headline && headline !== "null" && headline !== "") parts.push(`כותרת שיווקית - ${headline}`);
  if (body_text && body_text !== "null" && body_text !== "") parts.push(`טקסט משלים - ${body_text}`);
  if (notes && notes !== "null" && notes !== "") parts.push(notes);
  return parts.join("\n");
}

/**
 * שולף HTML מאתר — מחזיר string ריק אם נכשל
 */
async function fetchSiteHtml(url) {
  if (!url) return "";
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "Accept-Encoding": "gzip" },
    });
    return typeof res.data === "string" ? res.data.substring(0, 80000) : "";
  } catch (err) {
    console.warn(`[generateChanges] ⚠️ Failed to fetch site HTML from ${url}: ${err.message}`);
    return "";
  }
}

/**
 * מנתח שפה עיצובית של אתר דרך GPT-4o — מחזיר string ריק אם אין URL
 */
async function analyzeSiteDesign(siteUrl) {
  if (!siteUrl) return "";
  try {
    console.log(`[generateChanges] 🌐 Fetching site: ${siteUrl}`);
    const html = await fetchSiteHtml(siteUrl);
    if (!html) return "";

    const { system, user } = buildSiteAnalysisPrompt(html);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1500,
    });
    const analysis = completion.choices[0].message.content || "";
    console.log(`[generateChanges] ✅ Site analysis done (${analysis.length} chars)`);
    return analysis;
  } catch (err) {
    console.warn(`[generateChanges] ⚠️ Site analysis failed: ${err.message}`);
    return "";
  }
}

exports.generateChanges = async (req, res) => {
  try {
    const {
      phone,
      prompt = "",
      headline = "",
      body_text = "",
      notes = "",
      site = "",
      base_image_url = "",
      avatar_url = "",
    } = req.body;

    console.log("[generateChanges] 📨 Incoming request:", {
      phone,
      prompt,
      headline,
      body_text,
      notes,
      site,
      base_image_url: base_image_url || null,
      avatar_url: avatar_url || null,
      files: {
        logo_file: req.files?.logo_file?.[0]
          ? { size: req.files.logo_file[0].size, mime: req.files.logo_file[0].mimetype }
          : null,
        base_image_file: req.files?.base_image_file?.[0]
          ? { size: req.files.base_image_file[0].size, mime: req.files.base_image_file[0].mimetype }
          : null,
      },
    });

    if (!phone) return res.status(400).json({ error: "phone is required" });

    const logoFile = req.files?.logo_file?.[0];
    const baseImageFile = req.files?.base_image_file?.[0];

    const fullPrompt = buildChangesPrompt({ prompt, headline, body_text, notes });
    if (!fullPrompt) return res.status(400).json({ error: "At least one of: prompt, headline, body_text, notes is required" });

    const timestamp = Date.now();
    const filePath = `post/${phone}/${timestamp}.png`;

    let resultBuffer;

    // ── Route 2: יש קובץ תמונה מקומי + נכסים (לוגו, אווטאר, ניתוח אתר) ──────
    if (baseImageFile) {
      console.log(`[generateChanges] 🎨 Mode: Full creation with assets`);

      // איסוף כל הנכסים במקביל
      const [siteAnalysis] = await Promise.all([
        analyzeSiteDesign(site),
      ]);

      // בניית רשימת תמונות לגמיני
      const imageParts = [];

      if (logoFile) {
        imageParts.push({
          base64: logoFile.buffer.toString("base64"),
          mimeType: logoFile.mimetype || "image/png",
        });
        console.log(`[generateChanges] 📎 Added logo (${logoFile.size} bytes)`);
      }

      if (avatar_url) {
        try {
          const avatarRes = await axios.get(avatar_url, { responseType: "arraybuffer", timeout: 15000 });
          const avatarMime = avatarRes.headers["content-type"] || "image/jpeg";
          imageParts.push({
            base64: Buffer.from(avatarRes.data).toString("base64"),
            mimeType: avatarMime,
          });
          console.log(`[generateChanges] 📎 Added avatar from URL`);
        } catch (err) {
          console.warn(`[generateChanges] ⚠️ Could not fetch avatar: ${err.message}`);
        }
      }

      imageParts.push({
        base64: baseImageFile.buffer.toString("base64"),
        mimeType: baseImageFile.mimetype || "image/jpeg",
      });
      console.log(`[generateChanges] 📎 Added base image (${baseImageFile.size} bytes)`);

      const systemInstruction = siteAnalysis
        ? `${fullPrompt}\n\n${siteAnalysis}`
        : fullPrompt;

      const result = await imageAgent.editWithAssets(imageParts, systemInstruction);
      resultBuffer = result.buffer;

    // ── Route 1: יש URL של תמונה — עריכה פשוטה ──────────────────────────────
    } else if (base_image_url) {
      console.log(`[generateChanges] ✏️ Mode: Simple edit from URL`);

      const imageRes = await axios.get(base_image_url, { responseType: "arraybuffer", timeout: 20000 });
      const mimeType = imageRes.headers["content-type"] || "image/jpeg";
      const base64 = Buffer.from(imageRes.data).toString("base64");

      const result = await imageAgent.edit(base64, mimeType, fullPrompt);
      resultBuffer = result.buffer;

    // ── Route 3: אין תמונת בסיס — יצירה מאפס (לוגו + פרומפט → Gemini) ─────────
    } else {
      const imageParts = [];

      if (logoFile) {
        imageParts.push({
          base64: logoFile.buffer.toString("base64"),
          mimeType: logoFile.mimetype || "image/png",
        });
        console.log(`[generateChanges] 📎 Mode: Generate from scratch with logo (${logoFile.size} bytes)`);
      } else {
        console.log(`[generateChanges] 🎲 Mode: Generate from scratch (no assets)`);
      }

      if (avatar_url) {
        try {
          const avatarRes = await axios.get(avatar_url, { responseType: "arraybuffer", timeout: 15000 });
          imageParts.push({
            base64: Buffer.from(avatarRes.data).toString("base64"),
            mimeType: avatarRes.headers["content-type"] || "image/jpeg",
          });
          console.log(`[generateChanges] 📎 Added avatar`);
        } catch (err) {
          console.warn(`[generateChanges] ⚠️ Could not fetch avatar: ${err.message}`);
        }
      }

      const [siteAnalysis] = await Promise.all([analyzeSiteDesign(site)]);
      const systemInstruction = siteAnalysis ? `${fullPrompt}\n\n${siteAnalysis}` : fullPrompt;

      if (imageParts.length > 0) {
        const result = await imageAgent.editWithAssets(imageParts, systemInstruction);
        resultBuffer = result.buffer;
      } else {
        const result = await imageAgent.generate(systemInstruction);
        resultBuffer = result.buffer;
      }
    }

    // ── העלאה ל-Backblaze ───────────────────────────────────────────────────
    console.log(`[generateChanges] ⬆️ Uploading to Backblaze: ${filePath}`);
    await backblaze.uploadImage(filePath, resultBuffer, "image/png");

    const publicUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
    console.log(`[generateChanges] ✅ Done: ${publicUrl}`);

    return res.json({ url: publicUrl });

  } catch (err) {
    console.error("[generateChanges] ❌ Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
