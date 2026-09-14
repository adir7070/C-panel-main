const { ObjectId } = require("mongodb");
const { OpenAI } = require("openai");
const { DB } = require("../config/db");
const { imageAgent } = require("../ai-agents/gemini");
const backblazeService = require("./backblaze.service");
const { SYSTEM_PROMPT, buildCreativesPrompt } = require("../utils/prompts/ai-creation-order-creatives");
const fbAds = require("./facebook-ads.service");
const { notifyUser } = require("./push-notification.service");
const { sendSMS } = require("./sms4free.service");

const ADMIN_PHONE = "972542587070"; // dev alert recipient

async function alertAdmin(subject, details) {
  const msg = `[Iconiq] ${subject}\n${details}`.slice(0, 160);
  try { await sendSMS(ADMIN_PHONE, msg); } catch (_) {}
}

const openai = new OpenAI({ apiKey: process.env.OpenAI_API_KEY });

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

const orders       = () => DB.collection("ai_creation_orders");
const instaPosts   = () => DB.collection("instagram_posts");

// Hebrew day name → JS getDay() index
const HE_DAY_TO_JS = { "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6 };

function slotToTimestamp(slot) {
  if (slot?.specificDate) {
    const [dd, mm, yy] = slot.specificDate.split(".");
    return new Date(2000 + parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)).getTime();
  }
  if (slot?.time && slot.time !== "--:--" && Array.isArray(slot.days) && slot.days.length > 0) {
    const [h, m] = slot.time.split(":").map(Number);
    const targetDay = HE_DAY_TO_JS[slot.days[0]] ?? 0;
    const now = new Date();
    const d = new Date();
    d.setHours(h, m, 0, 0);
    let daysUntil = (targetDay - now.getDay() + 7) % 7;
    if (daysUntil === 0 && d <= now) daysUntil = 7;
    d.setDate(d.getDate() + daysUntil);
    return d.getTime();
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

/**
 * Create FB campaign + adset + (optionally) lead form upfront.
 * Returns { campaignId, adsetId, formId, userToken, actId, pageId } or null on failure.
 */
async function setupFacebookCampaign(orderId, order) {
  const tag = `[AICreation:${orderId}:FbSetup]`;
  const { userToken, pageToken, pageId, adAccountId } = order.facebook;
  const actId = String(adAccountId).startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  const businessName = order.businessName || order.clientName || "Campaign";
  const campaignName = `${businessName} - ${Date.now()}`;

  // Resolve business website URL for lead form privacy policy
  let websiteUrl = "https://iconiqmedia.co.il";
  try {
    const bp = await DB.collection("business_profiles").findOne(
      { phone: order.phone },
      { projection: { websiteUrl: 1 } }
    );
    if (bp?.websiteUrl) websiteUrl = bp.websiteUrl;
  } catch (_) {}

  try {
    // Try leads campaign first; if lead form isn't available, fall back to traffic
    let campaignType = "leads";
    let formId = null;

    let campaignId = await fbAds.createCampaign(userToken, actId, campaignName, campaignType);
    console.log(`${tag} campaign: ${campaignId} (${campaignType})`);

    let adsetId = await fbAds.createAdSet(userToken, actId, campaignId, pageId, campaignType);
    console.log(`${tag} adset: ${adsetId}`);

    if (pageToken) {
      try {
        formId = await fbAds.createLeadForm(pageToken, pageId, `Form-${campaignName}`, websiteUrl);
        console.log(`${tag} leadForm: ${formId}`);
      } catch (formErr) {
        console.warn(`${tag} lead form failed: ${formErr.message} — falling back to TRAFFIC campaign`);
        // Lead form failed → create a brand new TRAFFIC campaign+adset (can't mix LINK_CLICKS into OUTCOME_LEADS)
        try {
          campaignId = await fbAds.createCampaign(userToken, actId, `${campaignName}-T`, "traffic");
          adsetId = await fbAds.createAdSet(userToken, actId, campaignId, pageId, "traffic");
          campaignType = "traffic";
          console.log(`${tag} fallback traffic campaign: ${campaignId} adset: ${adsetId}`);
        } catch (adsetErr) {
          console.warn(`${tag} traffic campaign fallback also failed: ${adsetErr.message}`);
        }
      }
    }

    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          facebookCampaignId:   campaignId,
          facebookAdsetId:      adsetId,
          facebookLeadFormId:   formId,
          facebookCampaignType: campaignType,
          facebookStatus:       "injecting",
          facebookAdIds:        [],
          facebookAdErrors:     [],
          updatedAt:            new Date(),
        },
      }
    );

    return { campaignId, adsetId, formId, campaignType, userToken, pageToken, actId, pageId, businessName, websiteUrl, phone: order.phone };
  } catch (err) {
    console.error(`${tag} setup failed: ${err.message}`);
    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      { $set: { facebookStatus: "setup_failed", facebookError: err.message, updatedAt: new Date() } }
    );
    await alertAdmin(`FbSetup FAILED phone=${order.phone}`, err.message);
    try {
      await notifyUser(order.phone, "שגיאה בפייסבוק", `יצירת הקמפיין נכשלה: ${err.message}`);
    } catch (_) {}
    return null;
  }
}

/**
 * Inject a single image into the already-created FB campaign immediately after it's generated.
 */
async function injectSingleImage(orderId, fbSetup, imageUrl, headline, desc, index) {
  const tag = `[AICreation:${orderId}:FbInject:${index}]`;
  const { userToken, pageToken, actId, pageId, adsetId, formId, businessName, websiteUrl, phone } = fbSetup;

  console.log(`${tag} start — imageUrl=${imageUrl}`);

  try {
    const imageHash = await fbAds.uploadAdImage(userToken, actId, imageUrl);
    console.log(`${tag} uploaded → hash=${imageHash}`);

    const adContent = {
      headline:    headline || businessName,
      subheadline: desc || "",
      proof_line:  null,
    };

    let creativeId;
    if (formId) {
      creativeId = await fbAds.createLeadsCreative(userToken, pageId, actId, imageHash, adContent, formId, websiteUrl);
      console.log(`${tag} leads creative: ${creativeId}`);
    } else {
      // No lead form — use page token for traffic creative if available
      const tokenForCreative = pageToken || userToken;
      creativeId = await fbAds.createTrafficCreative(tokenForCreative, pageId, actId, imageHash, adContent, websiteUrl || "https://iconiqmedia.co.il");
      console.log(`${tag} traffic creative: ${creativeId}`);
    }

    const adId = await fbAds.createAd(userToken, actId, adsetId, creativeId, `Ad-${index}-${Date.now()}`);
    console.log(`${tag} ad created: ${adId}`);

    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      { $push: { facebookAdIds: adId }, $set: { updatedAt: new Date() } }
    );

    return { success: true, adId };
  } catch (err) {
    console.error(`${tag} FAILED: ${err.message}`);
    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      { $push: { facebookAdErrors: { index, imageUrl, error: err.message } }, $set: { updatedAt: new Date() } }
    );
    await alertAdmin(`FbInject[${index}] FAILED phone=${phone}`, err.message);
    try {
      await notifyUser(phone, "שגיאה בהזרקת מודעה", `תמונה ${index + 1} נכשלה: ${err.message}`);
    } catch (_) {}
    return { success: false, error: err.message };
  }
}

/**
 * Runs in the background after submit.
 * GPT-4o → prompts → Gemini × (postCount + carouselCount×5) → Backblaze → MongoDB
 * Each image is injected into Facebook immediately after it's generated.
 */
exports.processCreatives = async (orderId, order) => {
  const tag = `[AICreation:${orderId}]`;

  try {
    console.log(`${tag} Starting creative generation`);

    const postCount = order.billing?.postCount ?? 0;
    const carouselCount = order.billing?.carouselCount ?? 0;
    if (postCount === 0 && carouselCount === 0) {
      console.log(`${tag} No creatives to generate (postCount=0, carouselCount=0)`);
      return;
    }

    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      { $set: { creativesStatus: "processing", updatedAt: new Date() } }
    );

    // ── Step 1: GPT-4o → structured creative plan ──────────────────────────
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildCreativesPrompt(order) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.85,
    });

    const raw = gptResponse.choices[0].message.content;
    if (!raw) throw new Error("Empty response from OpenAI");

    const plan = JSON.parse(raw);
    const posts = Array.isArray(plan.posts) ? plan.posts : [];
    const carousels = Array.isArray(plan.carousels) ? plan.carousels : [];

    console.log(`${tag} GPT plan: ${posts.length} posts, ${carousels.length} carousels`);

    // ── Step 1.5: Setup Facebook campaign upfront (before generating images) ─
    const fb = order.facebook;
    let fbSetup = null;
    if (fb?.userToken && fb?.pageId && fb?.adAccountId) {
      fbSetup = await setupFacebookCampaign(orderId, order);
      if (!fbSetup) {
        console.warn(`${tag} FB setup failed — will generate images without injection`);
      } else {
        await alertAdmin(`FbSetup OK phone=${order.phone}`, `campaign=${fbSetup.campaignId} adset=${fbSetup.adsetId} type=${fbSetup.campaignType}`);
      }
    } else {
      console.log(`${tag} No FB credentials — skipping ad injection`);
      await alertAdmin(`No FB creds phone=${order.phone}`, `userToken=${!!fb?.userToken} pageId=${!!fb?.pageId} adAccountId=${!!fb?.adAccountId}`);
    }

    const phone = order.phone || "unknown";
    const creatives = [];

    // ── Step 2: Generate post images + inject each one immediately ──────────
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      console.log(`${tag} Post ${i + 1}/${posts.length}`);

      try {
        const imageResult = await imageAgent.generate(post.promt);
        const path = `ai-creation/${phone}/post-${Date.now()}-${i}.png`;
        await backblazeService.uploadImage(path, imageResult.buffer, "image/png");
        const imageUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(path)}`;

        // Inject immediately after each image is ready
        if (fbSetup) {
          await injectSingleImage(orderId, fbSetup, imageUrl, post.headline, post.desc, i);
        }

        creatives.push({
          type: "post",
          desc: post.desc,
          headline: post.headline || null,
          imageUrl,
          status: "completed",
          publishLog: [],
        });
      } catch (err) {
        console.error(`${tag} Post ${i + 1} failed:`, err.message);
        creatives.push({
          type: "post",
          desc: post.desc,
          imageUrl: null,
          status: "failed",
          error: err.message,
          publishLog: [],
        });
      }
    }

    // ── Step 3: Generate carousel images ────────────────────────────────────
    for (let c = 0; c < carousels.length; c++) {
      const carousel = carousels[c];
      const slides = Array.isArray(carousel.slides) ? carousel.slides : [];
      console.log(`${tag} Carousel ${c + 1}/${carousels.length} — ${slides.length} slides`);

      const generatedSlides = [];
      let anyFailed = false;

      for (let s = 0; s < slides.length; s++) {
        const slide = slides[s];
        console.log(`${tag}   Slide ${s + 1}/${slides.length}`);

        try {
          const imageResult = await imageAgent.generate(slide.promt);
          const path = `ai-creation/${phone}/carousel-${Date.now()}-${c}-${s}.png`;
          await backblazeService.uploadImage(path, imageResult.buffer, "image/png");
          const imageUrl = `${SERVER_BASE_URL}/api/img?url=${encodeURIComponent(path)}`;

          generatedSlides.push({ imageUrl, status: "completed" });
        } catch (err) {
          console.error(`${tag}   Slide ${s + 1} failed:`, err.message);
          anyFailed = true;
          generatedSlides.push({ imageUrl: null, status: "failed", error: err.message });
        }
      }

      creatives.push({
        type: "carousel",
        desc: carousel.desc,
        slides: generatedSlides,
        status: anyFailed ? (generatedSlides.some((s) => s.status === "completed") ? "partial" : "failed") : "completed",
        publishLog: [],
      });
    }

    // ── Step 4: Save all creatives to MongoDB ────────────────────────────────
    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          creatives,
          creativesStatus: "completed",
          publishPointer: 0,
          ...(fbSetup ? { facebookStatus: "campaign_live" } : {}),
          updatedAt: new Date(),
        },
      }
    );

    console.log(`${tag} Done — ${creatives.length} creatives saved`);

    if (fbSetup) {
      const injected = creatives.filter((c) => c.type === "post" && c.status === "completed").length;
      try {
        await notifyUser(order.phone, "קמפיין פייסבוק מוכן ✓", `${injected} מודעות הוזרקו לקמפיין בהצלחה`);
      } catch (_) {}
    }

    // ── Step 5: Bridge post creatives → instagram_posts (for app calendar) ──
    const slots = order.publish?.slots ?? [];
    let slotIdx = 0;
    for (const creative of creatives) {
      if (creative.type !== "post") { slotIdx++; continue; }
      const slot = slots[slotIdx] ?? {};
      const scheduledAt = slotToTimestamp(slot);
      const postId = `order_${orderId}_${slotIdx}`;
      const post = {
        id: postId,
        status: "scheduled",
        imgurl: creative.imageUrl ?? "",
        description: creative.desc ?? "",
        scheduled_at: scheduledAt,
        created_at: Date.now(),
      };
      await instaPosts().updateOne(
        { phone: order.phone, postId },
        { $set: { phone: order.phone, postId, post, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`${tag} Bridged post ${postId} → instagram_posts (scheduled_at=${new Date(scheduledAt).toISOString()})`);
      slotIdx++;
    }
  } catch (err) {
    console.error(`${tag} Fatal error:`, err.message);
    await orders().updateOne(
      { _id: new ObjectId(orderId) },
      {
        $set: {
          creativesStatus: "failed",
          creativesError: err.message,
          updatedAt: new Date(),
        },
      }
    );
    await alertAdmin(`processCreatives FATAL orderId=${orderId}`, err.message);
  }
};
