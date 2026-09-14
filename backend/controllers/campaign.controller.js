const crypto = require("crypto");
const axios = require("axios");
const { DB } = require("../config/db");
const aiService = require("../services/ai.service");
const backblazeService = require("../services/backblaze.service");
const { imageAgent } = require("../ai-agents/gemini");
const { SYSTEM_PROMPT, buildCampaignImagesPrompt } = require("../utils/prompts/campaign-images");
const creationProgress = require("../services/creation-progress.service");
const fbAds = require("../services/facebook-ads.service");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";
const FB_VERSION = process.env.FACEBOOK_API_VERSION || "v23.0";

const COLLECTION = "campaign_jobs";

/**
 * POST /api/campaign/generate-images
 *
 * Two modes in one endpoint (matches Make.com BasicRouter logic):
 *
 * 1. Initial request (no jobId):
 *    - Builds context JSON from form fields
 *    - Inserts { job_id, data: null, created_at } into campaign_jobs collection
 *    - Responds immediately with { jobId }
 *    - Kicks off background: GPT-4o → 6 image prompts → Gemini × 6 → Backblaze
 *    - On complete: updates the document with { data: [{url, desc}, ...] }
 *
 * 2. Polling request (jobId present):
 *    - If done:    { status: true,  data: [{url, desc}, ...] } + deletes the doc
 *    - If pending: { status: false }
 */
exports.generateImages = async (req, res) => {
  const { jobId } = req.body ?? {};

  // ── Polling mode ──────────────────────────────────────────────────────────
  if (jobId) {
    try {
      const job = await DB.collection(COLLECTION).findOne({ job_id: jobId });

      if (!job) {
        // Unknown or already cleaned up — treat as pending
        return res.json({ status: false });
      }

      if (job.data) {
        await DB.collection(COLLECTION).deleteOne({ job_id: jobId });
        return res.json({ status: true, data: job.data });
      }

      return res.json({ status: false });
    } catch (err) {
      console.error(`[campaign] ❌ Polling error for ${jobId}:`, err.message);
      return res.json({ status: false });
    }
  }

  // ── Generation mode ───────────────────────────────────────────────────────
  const {
    service,
    targetAudience,
    painPoint,
    result,
    differentiator,
    visualStyle,
    brandColors,
    promotions,
    businessAddress,
    phone,
    callToActionType,
  } = req.body ?? {};

  console.log(`[campaign] 📨 Incoming generate-images request:`, {
    contentType: req.headers["content-type"],
    phone: phone || "⚠️ MISSING",
    service: service || "⚠️ MISSING",
    targetAudience: targetAudience || "⚠️ MISSING",
    painPoint: painPoint || "⚠️ MISSING",
    result: result || "⚠️ MISSING",
    differentiator: differentiator || "⚠️ MISSING",
    visualStyle: visualStyle || "⚠️ MISSING",
    brandColors: brandColors || "⚠️ MISSING",
    promotions: promotions || "⚠️ MISSING",
    businessAddress: businessAddress || "⚠️ MISSING",
    callToActionType: callToActionType || "⚠️ MISSING",
    files: {
      logo: req.files?.logo?.[0] ? `✅ ${req.files.logo[0].size} bytes` : "❌ none",
      images: req.files?.images?.length ? `✅ ${req.files.images.length} file(s)` : "❌ none",
    },
    bodyKeys: Object.keys(req.body ?? {}),
  });

  const newJobId = crypto.randomBytes(8).toString("hex");

  try {
    await DB.collection(COLLECTION).insertOne({
      job_id: newJobId,
      data: null,
      created_at: new Date(),
    });
  } catch (err) {
    console.error("[campaign] ❌ Failed to create job in DB:", err.message);
    return res.status(500).json({ error: "Failed to start job" });
  }

  // Respond immediately
  res.json({ jobId: newJobId });

  // Background generation (fire-and-forget)
  (async () => {
    // Home-screen progress circle: GPT plan + ~6 images + finalize (total
    // corrected once GPT returns the real item count). Started here, off the
    // response path, so a slow progress write never delays the client.
    const progressId = await creationProgress.startJob({
      phone, kind: "campaign", total: 8, refId: newJobId, label: service || null,
    });
    try {
      console.log(`[campaign] 🚀 Starting generation for jobId: ${newJobId}`);

      // Build the JSON context the prompt expects
      let parsedVisualStyle = visualStyle;
      if (typeof visualStyle === "string") {
        try {
          parsedVisualStyle = JSON.parse(visualStyle);
        } catch (_) {
          parsedVisualStyle = visualStyle;
        }
      }

      const contextJson = JSON.stringify(
        {
          service,
          targetAudience,
          painPoint,
          result,
          differentiator,
          visualStyle: parsedVisualStyle,
          brandColors,
          promotions,
          businessAddress,
          callToActionType,
        },
        null,
        2
      );

      console.log(`[campaign] 📋 Context JSON built for jobId ${newJobId}:`, contextJson);

      // GPT-4o → 6 { promt, desc } items
      const userPrompt = buildCampaignImagesPrompt(contextJson);
      console.log(`[campaign] 🤖 Calling GPT-4o for jobId ${newJobId}...`);
      const rawText = await aiService.generateRawText(SYSTEM_PROMPT, userPrompt);

      console.log(`[campaign] 📄 GPT raw response (${rawText.length} chars):`, rawText.substring(0, 500));

      // Extract JSON array from GPT response
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error(`[campaign] ❌ GPT response has no JSON array. Full text:`, rawText);
        throw new Error("GPT response contains no JSON array");
      }
      const adItems = JSON.parse(jsonMatch[0]);

      await creationProgress.setProgress(progressId, 1, { total: adItems.length + 2 });

      console.log(`[campaign] ✅ GPT returned ${adItems.length} ad items`);
      adItems.forEach((item, i) => {
        console.log(`[campaign]   Ad ${i + 1}: promt="${(item.promt || "").substring(0, 80)}..." | desc="${(item.desc || "").substring(0, 60)}..."`);
      });

      // Generate + upload each image
      const results = [];
      for (let i = 0; i < adItems.length; i++) {
        const item = adItems[i];
        const timestamp = Date.now();
        const filePath = `post/${phone || "demo"}/${timestamp}-${i}.png`;

        console.log(`[campaign] 🎨 Generating image ${i + 1}/${adItems.length} | promt: "${(item.promt || "").substring(0, 100)}"`);

        if (!item.promt) {
          console.error(`[campaign] ❌ Ad item ${i + 1} has no "promt" field:`, JSON.stringify(item));
          throw new Error(`Ad item ${i + 1} missing "promt" field`);
        }

        const imageResult = await imageAgent.generate(item.promt);
        console.log(`[campaign] ✅ Image ${i + 1} generated — buffer size: ${imageResult.buffer?.length ?? "N/A"} bytes`);

        console.log(`[campaign] ☁️  Uploading image ${i + 1} to Backblaze: ${filePath}`);
        await backblazeService.uploadImage(filePath, imageResult.buffer, "image/png");

        const proxyUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
        console.log(`[campaign] ✅ Image ${i + 1} uploaded → ${proxyUrl}`);
        results.push({ url: proxyUrl, desc: item.desc });
        await creationProgress.setProgress(progressId, i + 2);
      }

      await DB.collection(COLLECTION).updateOne(
        { job_id: newJobId },
        { $set: { data: results } }
      );
      console.log(`[campaign] ✅ Job ${newJobId} complete — ${results.length} images ready`);
      await creationProgress.completeJob(progressId);
    } catch (err) {
      console.error(`[campaign] ❌ Generation failed for job ${newJobId}:`, err.message, err.stack);
      await creationProgress.failJob(progressId, err.message);
      // Clean up failed job so polling won't hang forever
      await DB.collection(COLLECTION).deleteOne({ job_id: newJobId }).catch(() => {});
    }
  })();
};

/**
 * POST /api/campaign/add-ad
 *
 * Inject ONE already-generated AI image as a real PAUSED ad into an existing
 * campaign's ad set. Used by the app's "הוסף מודעה חדשה → AI" flow (campaign
 * case only — the social-scheduling flow keeps going to Instagram). Synchronous
 * (a few fast Graph calls), so the app can surface success/failure and refresh.
 *
 * Body: { phone, campaignId, imageUrl, headline, primaryText, cta?, formId?,
 *         adsetId?, facebook: { userToken, adAccountId, pageId } }
 */
exports.addAd = async (req, res) => {
  try {
    const { phone, campaignId, imageUrl, headline, primaryText, formId } = req.body ?? {};
    const fb = req.body?.facebook ?? {};
    const userToken = fb.userToken;
    const adAccountId = fb.adAccountId;
    const pageId = fb.pageId;

    if (!campaignId || !imageUrl || !userToken || !adAccountId || !pageId) {
      return res.status(400).json({ success: false, error: "missing campaignId / imageUrl / facebook creds" });
    }

    const actId = String(adAccountId).startsWith("act_") ? adAccountId : `act_${adAccountId}`;

    // Resolve the campaign's ad set — new ads go under the first one (CBO: budget
    // lives on the campaign, so any ad set works).
    let adsetId = req.body.adsetId || null;
    if (!adsetId) {
      const { data } = await axios.get(`https://graph.facebook.com/${FB_VERSION}/${campaignId}/adsets`, {
        params: { fields: "id", limit: 1, access_token: userToken },
      });
      adsetId = data?.data?.[0]?.id || null;
    }
    if (!adsetId) {
      return res.status(400).json({ success: false, error: "no ad set found for campaign" });
    }

    // External link for the creative (FB policy 1815316 for lead ads). Client
    // website → agency domain fallback.
    let websiteUrl = null;
    try {
      const bp = await DB.collection("business_profiles").findOne(
        { phone }, { projection: { websiteUrl: 1 } });
      websiteUrl = bp?.websiteUrl || null;
    } catch (_) {}

    const imageHash = await fbAds.uploadAdImage(userToken, actId, imageUrl);
    const adContent = { headline: headline || "", subheadline: primaryText || "", proof_line: null };

    const creativeId = formId
      ? await fbAds.createLeadsCreative(userToken, pageId, actId, imageHash, adContent, formId, websiteUrl)
      : await fbAds.createTrafficCreative(userToken, pageId, actId, imageHash, adContent, websiteUrl || "https://iconiqmedia.co.il");

    const adId = await fbAds.createAd(userToken, actId, adsetId, creativeId, `AI-Ad-${Date.now()}`);

    console.log(`[campaign/add-ad] ✅ ${phone} — ad ${adId} added to campaign ${campaignId} (adset ${adsetId})`);
    return res.json({ success: true, adId, adsetId });
  } catch (err) {
    console.error("[campaign/add-ad] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
