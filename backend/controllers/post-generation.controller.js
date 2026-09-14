const crypto = require("crypto");
const axios = require("axios");
const multer = require("multer");
const { DB } = require("../config/db");
const aiService = require("../services/ai.service");
const backblazeService = require("../services/backblaze.service");
const { imageAgent } = require("../ai-agents/gemini");
const {
  WEBSITE_ANALYSIS_SYSTEM_PROMPT,
  POSTS_GENERATION_PROMPT,
  buildPostsUserPrompt,
} = require("../utils/prompts/posts-generation");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";
const COLLECTION = "post_jobs";

/* HQ organic path — when on (default), the mobile social-post generator
   routes image generation through the WOW-Organic-quality pipeline
   (gpt-image-2 multi-stage). Self-contained copy in post-generation-quality.js;
   does NOT touch any wow-organic* file. Kill-switch: MOBILE_SOCIAL_HQ=false. */
const { generateHqSocialPosts } = require("../services/post-generation-quality");
const MOBILE_SOCIAL_HQ = process.env.MOBILE_SOCIAL_HQ !== "false";

/* Auto-publish generated posts to the client's FB Page + Instagram, immediately
   after generation. Kill-switch: MOBILE_SOCIAL_AUTOPUBLISH=false. */
const { autoPublishSocialPosts } = require("../services/social-publish.service");

const creationProgress = require("../services/creation-progress.service");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

exports.uploadMiddleware = upload.fields([
  { name: "logo", maxCount: 1 },
  { name: "images", maxCount: 10 },
]);

/**
 * POST /api/post-generation/generate
 *
 * Three modes:
 *
 * 1. Polling (JSON body with jobId):
 *    - Returns { status: false } if still processing
 *    - Returns { status: true, data: [{url, desc}, ...] } + deletes the doc when done
 *
 * 2. Refinement (multipart with isRefinement=true):
 *    - Edits an existing post image based on user instructions
 *    - Waits synchronously and returns { data: [{ url, desc }] }
 *
 * 3. Generation (multipart without isRefinement):
 *    - Responds immediately with { jobId }
 *    - Background: GPT-4o → N prompts → Gemini × N → Backblaze
 *    - On complete: updates post_jobs with { data: [{url, desc}, ...] }
 */
exports.generate = async (req, res) => {
  const { jobId, isRefinement } = req.body;

  // ── Polling mode ───────────────────────────────────────────────────────────
  if (jobId) {
    try {
      const job = await DB.collection(COLLECTION).findOne({ job_id: jobId });

      if (!job) {
        return res.json({ status: false });
      }

      if (job.data) {
        await DB.collection(COLLECTION).deleteOne({ job_id: jobId });
        return res.json({ status: true, data: job.data });
      }

      return res.json({ status: false });
    } catch (err) {
      console.error(`[post-gen] ❌ Polling error for ${jobId}:`, err.message);
      return res.json({ status: false });
    }
  }

  // ── Refinement mode ────────────────────────────────────────────────────────
  if (isRefinement === "true" || isRefinement === true) {
    const { originalDescription, refinementRequest, originalImageUrl, phone } = req.body;

    try {
      console.log(`[post-gen] ✏️  Refinement request, instructions: "${refinementRequest}"`);

      let imageBase64 = null;
      let imageMimeType = "image/jpeg";

      if (originalImageUrl) {
        try {
          const imgRes = await axios.get(originalImageUrl, {
            responseType: "arraybuffer",
            timeout: 30000,
          });
          imageBase64 = Buffer.from(imgRes.data).toString("base64");
          imageMimeType = imgRes.headers["content-type"]?.split(";")[0] || "image/jpeg";
        } catch (e) {
          console.warn(`[post-gen] ⚠️  Failed to fetch original image: ${e.message}`);
        }
      }

      let imageResult;
      if (imageBase64) {
        imageResult = await imageAgent.edit(imageBase64, imageMimeType, refinementRequest);
      } else {
        imageResult = await imageAgent.generate(refinementRequest);
      }

      const timestamp = Date.now();
      const filePath = `post/${phone || "demo"}/${timestamp}-refined.png`;

      await backblazeService.uploadImage(filePath, imageResult.buffer, "image/png");

      const proxyUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
      const desc = imageResult.description || originalDescription || "";

      console.log(`[post-gen] ✅ Refinement complete: ${filePath}`);
      return res.json({ data: [{ url: proxyUrl, desc }] });
    } catch (err) {
      console.error(`[post-gen] ❌ Refinement failed:`, err.message);
      return res.status(500).json({ error: "Refinement failed", message: err.message });
    }
  }

  // ── Generation mode ────────────────────────────────────────────────────────
  const {
    subject, postType, customerStage, tone, hook, cta,
    phone, token, pageId, instagram_id, instagram_token, website, avatar_url,
  } = req.body;

  const postCount = parseInt(req.body.postCount) || 1;
  // valueType can arrive as "valueType[]" (React Native FormData) or "valueType"
  const rawValueType = req.body["valueType[]"] || req.body.valueType || [];
  const valueType = Array.isArray(rawValueType) ? rawValueType : [rawValueType].filter(Boolean);

  const newJobId = crypto.randomBytes(8).toString("hex");

  try {
    await DB.collection(COLLECTION).insertOne({
      job_id: newJobId,
      data: null,
      created_at: new Date(),
    });
  } catch (err) {
    console.error("[post-gen] ❌ Failed to create job in DB:", err.message);
    return res.status(500).json({ error: "Failed to start job" });
  }

  // Respond immediately
  res.json({ jobId: newJobId });

  // Background generation (fire-and-forget)
  (async () => {
    // Home-screen progress circle: context prep + texts + prompts + one per
    // image. Started off the response path so it never delays the client.
    const progressId = await creationProgress.startJob({
      phone, kind: "post_gen", total: postCount + 3, refId: newJobId, label: subject || null,
    });
    try {
      console.log(`[post-gen] 🚀 Starting generation for jobId: ${newJobId}, postCount: ${postCount}`);

      // 1. Process logo file
      // Primary: file upload from client (works when logo is a data: URI or file:// path)
      // Fallback: fetch from MongoDB profile (when logo is a remote URL that RN can't upload)
      let logoBase64 = null;
      let logoMimeType = "image/png";
      if (req.files?.logo?.[0]) {
        logoBase64 = req.files.logo[0].buffer.toString("base64");
        logoMimeType = req.files.logo[0].mimetype || "image/png";
        console.log(`[post-gen] ✅ Logo received from file upload`);
      } else if (phone && pageId) {
        try {
          const profile = await DB.collection("profiles").findOne(
            { phone, pageId },
            { projection: { logoBase64: 1 } },
          );
          if (profile?.logoBase64) {
            // Strip data URI prefix if present, then convert to base64 buffer
            const raw = profile.logoBase64.replace(/^data:image\/\w+;base64,/, "");
            // Check if it's a URL (fallback FB profile picture)
            if (raw.startsWith("http")) {
              const logoRes = await axios.get(raw, { responseType: "arraybuffer", timeout: 15000 });
              logoBase64 = Buffer.from(logoRes.data).toString("base64");
              logoMimeType = logoRes.headers["content-type"]?.split(";")[0] || "image/jpeg";
            } else {
              logoBase64 = raw;
            }
            console.log(`[post-gen] ✅ Logo loaded from profile (${logoBase64.length} chars)`);
          }
        } catch (e) {
          console.warn(`[post-gen] ⚠️  Failed to load logo from profile: ${e.message}`);
        }
      }

      // 2. Process avatar URL → fetch image as base64
      let avatarBase64 = null;
      let avatarMimeType = "image/jpeg";
      if (avatar_url) {
        try {
          const avatarRes = await axios.get(avatar_url, {
            responseType: "arraybuffer",
            timeout: 15000,
          });
          avatarBase64 = Buffer.from(avatarRes.data).toString("base64");
          avatarMimeType = avatarRes.headers["content-type"]?.split(";")[0] || "image/jpeg";
          console.log(`[post-gen] ✅ Avatar fetched (${avatarBase64.length} base64 chars)`);
        } catch (e) {
          console.warn(`[post-gen] ⚠️  Failed to fetch avatar: ${e.message}`);
        }
      }

      // 3. Process user source images
      const sourceImages = [];
      if (req.files?.images) {
        for (const img of req.files.images) {
          sourceImages.push({
            base64: img.buffer.toString("base64"),
            mimeType: img.mimetype || "image/jpeg",
          });
        }
        console.log(`[post-gen] 📎 ${sourceImages.length} source image(s) received`);
      }

      // 4. Fetch website HTML and analyze design language (optional)
      let siteAnalysis = "";
      if (website) {
        try {
          const htmlRes = await axios.get(website, {
            timeout: 15000,
            maxContentLength: 1024 * 1024,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; IconiqBot/1.0)" },
          });
          const html = typeof htmlRes.data === "string"
            ? htmlRes.data.substring(0, 50000)
            : "";
          if (html) {
            siteAnalysis = await aiService.generateRawText(
              WEBSITE_ANALYSIS_SYSTEM_PROMPT,
              `${html}\n\nURL: ${website}`,
            );
            console.log(`[post-gen] ✅ Website analysis done (${siteAnalysis.length} chars)`);
          }
        } catch (e) {
          console.warn(`[post-gen] ⚠️  Website fetch/analysis failed: ${e.message}`);
        }
      }

      // 5. Fetch Facebook page info + recent posts for context (optional)
      let businessData = "";
      if (token && pageId) {
        try {
          const FB_VERSION = process.env.FACEBOOK_API_VERSION || "v23.0";
          const [pageRes, postsRes] = await Promise.all([
            axios.get(`https://graph.facebook.com/${FB_VERSION}/${pageId}`, {
              params: { access_token: token, fields: "name,about,category,description" },
              timeout: 10000,
            }),
            axios.get(`https://graph.facebook.com/${FB_VERSION}/${pageId}/posts`, {
              params: { access_token: token, fields: "message,created_time", limit: 5 },
              timeout: 10000,
            }),
          ]);
          businessData = JSON.stringify({
            page: pageRes.data,
            recentPosts: postsRes.data?.data || [],
          });
          console.log(`[post-gen] ✅ Facebook data fetched for: ${pageRes.data?.name}`);
        } catch (e) {
          console.warn(`[post-gen] ⚠️  Facebook fetch failed: ${e.message}`);
        }
      }

      // ── HQ ORGANIC BRANCH (CPANEL WOW-Organic quality, gpt-image-2) ────────
      // When MOBILE_SOCIAL_HQ is on (default) generate via the WOW-Organic
      // quality pipeline and keep the SAME post_jobs contract ({ url, desc }).
      // On any failure we fall through to the original Gemini path below — the
      // Gemini path is left completely unchanged.
      if (MOBILE_SOCIAL_HQ) {
        try {
          const logoBuffer   = logoBase64   ? Buffer.from(logoBase64,   "base64") : null;
          const avatarBuffer = avatarBase64 ? Buffer.from(avatarBase64, "base64") : null;
          const imageBuffers = sourceImages.map(img => Buffer.from(img.base64, "base64"));

          // Business context from the FB page + website analysis (best-effort).
          let bizName = null, bizField = null, bizAbout = null;
          try {
            const bd = businessData ? JSON.parse(businessData) : null;
            bizName  = bd?.page?.name || null;
            bizField = bd?.page?.category || null;
            bizAbout = [bd?.page?.about, bd?.page?.description, siteAnalysis].filter(Boolean).join(" — ") || null;
          } catch (_) {}

          // Optional brand palette from the client's saved business profile.
          let preferredColors = null;
          try {
            const bp = await DB.collection("business_profiles").findOne(
              { phone }, { projection: { preferredColors: 1 } });
            preferredColors = bp?.preferredColors || null;
          } catch (_) {}

          console.log(`[post-gen:HQ] 🚀 ${newJobId} — generating ${postCount} HQ organic post(s)`);
          const hqPosts = await generateHqSocialPosts({
            count: postCount,
            subject, valueType, tone, hook, cta, customerStage,
            businessName: bizName, businessField: bizField, about: bizAbout,
            services: subject, preferredColors, designStyle: tone,
            logoBuffer, imageBuffers, avatarBuffer,
            // done ∈ [1..posts+2] → our units 2..posts+3 (unit 1 = context prep).
            onProgress: (done, units) => creationProgress.setProgress(progressId, 1 + done, { total: units + 1 }),
          });

          const results = [];
          for (let i = 0; i < hqPosts.length; i++) {
            const p = hqPosts[i];
            if (!p.imageBuffer) { console.warn(`[post-gen:HQ] post ${i + 1} skipped: ${p.error}`); continue; }
            const filePath = `post/${phone || "demo"}/${Date.now()}-${i}.png`;
            await backblazeService.uploadImage(filePath, p.imageBuffer, "image/png");
            const proxyUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
            results.push({
              url:      proxyUrl,
              desc:     p.promotionDescription || p.description || "",
              headline: p.headline,
              cta:      p.cta,
              type:     p.type,
            });
          }

          if (results.length === 0) throw new Error("HQ pipeline produced no images");

          // Auto-publish to FB/IG (immediate live) BEFORE persisting, so the
          // polled result carries the published status (server owns publishing;
          // the app no longer publishes → no duplicates).
          await autoPublishSocialPosts(results, postType, { phone, token, pageId, instagram_id, instagram_token });

          await DB.collection(COLLECTION).updateOne(
            { job_id: newJobId },
            { $set: { data: results } },
          );
          console.log(`[post-gen:HQ] ✅ Job ${newJobId} complete — ${results.length} HQ post(s)`);
          await creationProgress.completeJob(progressId);
          return; // done — skip the Gemini path
        } catch (hqErr) {
          console.error(`[post-gen:HQ] failed — falling back to Gemini path: ${hqErr.message}`);
        }
      }

      // 6. Build context JSON for GPT-4o
      const contextJson = JSON.stringify({
        subject,
        postType,
        valueType,
        customerStage,
        tone,
        hook,
        cta,
        postCount,
        pageId,
        instagram_id,
      }, null, 2);

      // 7. GPT-4o → [{gemini_prompt, description, image_name}] × postCount
      const userPrompt = buildPostsUserPrompt(
        contextJson,
        avatar_url,
        sourceImages.length,
        siteAnalysis,
        website,
        businessData,
      );

      const rawText = await aiService.generateRawText(POSTS_GENERATION_PROMPT, userPrompt);

      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("GPT response contains no JSON array");
      const postItems = JSON.parse(jsonMatch[0]);

      await creationProgress.setProgress(progressId, 2, { total: postItems.length + 3 });

      console.log(`[post-gen] ✅ GPT returned ${postItems.length} post item(s)`);

      // 8. Build shared image parts for Gemini (logo + avatar + source images)
      const sharedImageParts = [];
      if (logoBase64) sharedImageParts.push({ base64: logoBase64, mimeType: logoMimeType });
      if (avatarBase64) sharedImageParts.push({ base64: avatarBase64, mimeType: avatarMimeType });
      for (const img of sourceImages) {
        sharedImageParts.push({ base64: img.base64, mimeType: img.mimeType });
      }

      // 9. Generate + upload each post image
      const results = [];
      for (let i = 0; i < postItems.length; i++) {
        const item = postItems[i];
        const timestamp = Date.now();
        const filePath = `post/${phone || "demo"}/${timestamp}-${i}.png`;

        console.log(`[post-gen] 🎨 Generating image ${i + 1}/${postItems.length}`);

        let imageResult;
        if (sharedImageParts.length > 0) {
          imageResult = await imageAgent.editWithAssets(sharedImageParts, item.gemini_prompt);
        } else {
          imageResult = await imageAgent.generate(item.gemini_prompt);
        }

        console.log(`[post-gen] ☁️  Uploading image ${i + 1} to Backblaze: ${filePath}`);
        await backblazeService.uploadImage(filePath, imageResult.buffer, "image/png");

        const proxyUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(filePath)}`;
        results.push({ url: proxyUrl, desc: item.description });
        await creationProgress.setProgress(progressId, 2 + i + 1);
      }

      // Auto-publish to FB/IG (immediate live) — same as the HQ path.
      await autoPublishSocialPosts(results, postType, { phone, token, pageId, instagram_id, instagram_token });

      await DB.collection(COLLECTION).updateOne(
        { job_id: newJobId },
        { $set: { data: results } },
      );
      console.log(`[post-gen] ✅ Job ${newJobId} complete — ${results.length} post(s) ready`);
      await creationProgress.completeJob(progressId);
    } catch (err) {
      console.error(`[post-gen] ❌ Generation failed for job ${newJobId}:`, err.message);
      await creationProgress.failJob(progressId, err.message);
      // Delete failed job so polling won't hang forever
      await DB.collection(COLLECTION).deleteOne({ job_id: newJobId }).catch(() => {});
    }
  })();
};
