/**
 * social-campaign.service — FULLY AUTOMATIC mobile social campaign.
 *
 * When a client taps "Create Campaign" in the mobile app (social package +
 * brief + publishing schedule), this:
 *   1. Generates N organic posts at CPANEL WOW-Organic quality (gpt-image-2)
 *      via post-generation-quality.js (a self-contained copy — does NOT touch
 *      any wow-organic* file).
 *   2. Creates an `ai_creation_orders` (orderType "social_schedule") with the
 *      ready creatives + the CLIENT'S chosen publish slots, so the existing
 *      publish-creatives cron posts each one to FB Page + Instagram at the
 *      times the client picked.
 *
 * NO manager involvement, NO cpanel_pending_purchases, NOT shown in CPANEL.
 * This is the social twin of the ADS campaign-brief auto-flow.
 */

const { getDB } = require("../config/db");
const { clientGalleryRefs } = require("../utils/profileImages");
const backblazeService = require("./backblaze.service");
const { generateHqSocialPosts, fetchAssetBuffer } = require("./post-generation-quality");
const creationProgress = require("./creation-progress.service");

const SERVER_BASE_URL = process.env.BASE_URL || "https://api.iconiqmedia.co.il";

/* Load the client's business profile (same source the CPANEL organic pipeline
   uses) for brand name / field / colors / logo / reference photos. */
async function loadProfile(phone) {
  const p = await getDB().collection("business_profiles").findOne({ phone });
  if (!p) return null;
  const services = (p.services || [])
    .map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}`)
    .join("; ");
  // Merge images[] + legacy generalImages[] (app uploads) so client photos
  // reach the social pipeline regardless of which field holds them.
  const images = clientGalleryRefs(p);
  return {
    businessName:    p.businessName,
    businessField:   p.categoryKey,
    about:           p.about || "",
    services,
    targetAudience:  Array.isArray(p.targetAudience) ? p.targetAudience : [],
    designStyle:     p.designStyle,
    preferredColors: p.preferredColors || null,
    logoUrl:         p.logoUrl || null,
    images,
  };
}

/* Normalize the client's app schedule → cron publish slots.
   The app sends slots as { time: "HH:MM", days: ["א","ב",...] } (Hebrew day
   letters) — the EXACT shape publish-creatives.cron matches on. */
function normalizeSlots(schedule) {
  return (Array.isArray(schedule) ? schedule : [])
    .filter(s => s && typeof s.time === "string" && s.time !== "--:--")
    .map(s => ({
      time: s.time,
      days: Array.isArray(s.days) ? s.days.filter(Boolean) : [],
      ...(s.specificDate ? { specificDate: s.specificDate } : {}),
    }))
    .filter(s => s.days.length > 0 || s.specificDate);
}

/**
 * @param {object} args
 *   phone, pkg (the social package doc), brief {concept, importantInfo[], cta},
 *   schedule (the client's app slots), facebook {...}, instagram {...}
 */
async function autoFulfillSocialCampaign({ phone, pkg, brief, schedule, facebook, instagram, focusService, countOverride }) {
  // Home-screen progress circle: profile + texts + prompts + N images + order.
  let progressId = null;
  try {
  // countOverride lets the per-day "ליצירת מודעה" flow generate exactly 1 post
  // (no package); otherwise use the package's social_ad quota.
  const count = Number(countOverride) || Number(pkg?.items?.social_ad) || Number(pkg?.items?.organicAds) || 5;

  progressId = await creationProgress.startJob({
    phone,
    kind: pkg ? "social_batch" : "social_day",
    total: count + 4,
    label: focusService?.title || brief?.concept || null,
  });

  const prof = await loadProfile(phone);
  if (!prof) throw new Error("no business_profile for client");

  await creationProgress.setProgress(progressId, 1);

  const logoBuffer = prof.logoUrl ? await fetchAssetBuffer(prof.logoUrl) : null;
  const imageBuffers = [];
  // Client photos: images[] + legacy generalImages[] (app uploads), deduped.
  for (const ref of clientGalleryRefs(prof).slice(0, 5)) {
    const b = await fetchAssetBuffer(ref);
    if (b) imageBuffers.push(b);
  }

  /* When the client picked ONE service, focus every post on it (title — description —
     uniqueFeature). Otherwise fall back to the concept + all profile services. */
  const focusStr = focusService
    ? [focusService.title, focusService.description, focusService.uniqueFeature].filter(Boolean).join(" — ")
    : null;

  /* The client's concept + the info they asked to include drive the content. */
  const importantInfo = Array.isArray(brief?.importantInfo) ? brief.importantInfo.filter(Boolean) : [];
  const subject = [
    focusStr || brief?.concept || "",
    importantInfo.length ? `שלב במידת הצורך: ${importantInfo.join(", ")}` : "",
  ].filter(Boolean).join(" · ");

  console.log(`[social-campaign] ${phone} — generating ${count} HQ organic post(s)${focusStr ? ` — FOCUS: ${focusStr.slice(0, 80)}` : ""}`);
  const posts = await generateHqSocialPosts({
    count,
    subject,
    cta:             brief?.cta,
    valueType:       [],
    tone:            prof.designStyle,
    businessName:    prof.businessName,
    businessField:   prof.businessField,
    about:           prof.about,
    services:        focusStr || prof.services,
    targetAudience:  prof.targetAudience,
    preferredColors: prof.preferredColors,
    designStyle:     prof.designStyle,
    logoBuffer,
    imageBuffers,
    // done ∈ [1..posts+2] → our units 2..posts+3; last unit (+4) = order insert.
    onProgress: (done, units) => creationProgress.setProgress(progressId, 1 + done, { total: units + 2 }),
  });

  const now = new Date();
  const creatives = [];
  const generatedPosts = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (!p.imageBuffer) { console.warn(`[social-campaign] ${phone} post ${i + 1} skipped: ${p.error}`); continue; }
    const path = `social-campaign/${phone}/${Date.now()}-${i}.png`;
    await backblazeService.uploadImage(path, p.imageBuffer, "image/png");
    const proxy = `/api/img?url=${encodeURIComponent(path)}`;
    creatives.push({
      type:       "post",
      imageUrl:   `${SERVER_BASE_URL}${proxy}`,
      desc:       p.promotionDescription || p.description || "",
      headline:   p.headline || "",
      status:     "completed",
      publishLog: [],
    });
    generatedPosts.push({
      id:                   i + 1,
      type:                 p.type || "tip",
      headline:             p.headline || "",
      description:          p.description || "",
      cta:                  p.cta || "",
      imageUrl:             proxy,
      promotionDescription: p.promotionDescription || "",
      managerApprovedAt:    now,   // auto-approved — there is NO manager in this flow
      createdAt:            now,
    });
  }

  if (creatives.length === 0) throw new Error("generation produced no creatives");

  /* Write the posts to wow_organic_ads_sessions so (a) the client SEES them in
     the app (project-detail reads this collection) and (b) CPANEL shows the
     package as DONE (productStatus "completed"), NOT "מוכן לייצור" waiting on a
     manager. This is a DATA write only — no wow-organic CODE is touched. */
  const sessionId = `worg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await getDB().collection("wow_organic_ads_sessions").insertOne({
    sessionId, phone,
    status:                 "done",
    productStatus:          "completed",
    productStatusUpdatedAt: now,
    totalPosts:             generatedPosts.length,
    completedCount:         generatedPosts.length,
    generatedPosts,
    brief: {
      businessName:    prof.businessName,
      businessField:   prof.businessField,
      preferredColors: prof.preferredColors,
      services:        prof.services,
      concept:         brief?.concept || "",
    },
    source:    "mobile-social-auto",
    createdAt: now,
    updatedAt: now,
  }).catch(e => console.warn(`[social-campaign] organic session write failed: ${e.message}`));

  const slots = normalizeSlots(schedule);
  const order = {
    phone,
    orderType: "social_schedule",
    facebook: {
      userToken:   facebook?.userToken   ?? null,
      pageToken:   facebook?.pageToken   ?? null,
      pageId:      facebook?.pageId      ?? null,
      pageName:    facebook?.pageName    ?? null,
      adAccountId: facebook?.adAccountId ?? null,
    },
    instagram: {
      token:    instagram?.token    ?? null,
      id:       instagram?.id       ?? null,
      username: instagram?.username ?? null,
      name:     instagram?.name     ?? null,
    },
    status:                  "pending",
    creatives,
    creativesStatus:         "completed",
    publishPointer:          0,
    creativesFullyPublished: false,
    publish:                 { slots },
    source:                  "mobile-social-auto",
    createdAt: now,
    updatedAt: now,
  };

  const r = await getDB().collection("ai_creation_orders").insertOne(order);
  console.log(`[social-campaign] ✅ ${phone} — order ${r.insertedId} scheduled: ${creatives.length} posts, slots=${JSON.stringify(slots)}`);

  /* Mark the client's package as scheduled (so it's not a dangling
     "waiting_brief"). Only for the PACKAGE flow — the per-day flow has no pkg. */
  if (pkg) {
    await getDB().collection("users").updateOne(
      { phone },
      { $set: { "activePackage.status": "scheduled", "activePackage.scheduledOrderId": r.insertedId.toString(), updatedAt: now } },
    ).catch(() => {});
  }

  await creationProgress.completeJob(progressId);

  return { orderId: r.insertedId.toString(), sessionId, posts: creatives.length, slots };
  } catch (err) {
    console.error(`[social-campaign] ${phone} auto-fulfill FAILED: ${err.message}`);
    // Package flow: fall back to the manager queue so the paid purchase isn't lost.
    // Per-day flow (no pkg): surface the error so the caller doesn't charge for nothing.
    if (pkg) {
      // Only tell the client "handed to our team" if the fallback actually queued.
      const queued = await fallbackToManager(phone, pkg, brief)
        .then(() => true)
        .catch(e => { console.error("[social-campaign] fallback also failed:", e.message); return false; });
      await creationProgress.failJob(progressId, queued ? "FALLBACK_MANAGER" : err.message);
      return null;
    }
    await creationProgress.failJob(progressId, err.message);
    throw err;
  }
}

/* Safety net: if automatic fulfillment fails (OpenAI quota, missing profile,
   etc.), put the purchase back on the manager's CPANEL queue so it still gets
   done — the client already paid. Mirrors the manual social-redeem path. */
async function fallbackToManager(phone, pkg, brief) {
  const db = getDB();
  const now = new Date();
  const items = pkg?.items || {};
  await db.collection("cpanel_pending_purchases").insertOne({
    phone, kind: "social_redemption", packageKey: pkg?.key, description: pkg?.name, name: pkg?.name,
    adsCount: 0, socialAdsCount: Number(items.social_ad) || Number(items.organicAds) || 0,
    organicPosts: 0, videosCount: 0, landingPagesCount: 0, logosCount: 0,
    coinsOverride: -(Number(pkg?.price) || 0), totalAmount: 0, brief: brief || null,
    source: "mobile-social-auto-fallback", createdAt: now, completedAt: now,
  });
  await db.collection("users").updateOne(
    { phone }, { $set: { "activePackage.status": "waiting_brief" } },
  ).catch(() => {});
  require("./wow-manager-notify.service").notifyManagerOfPurchase({
    clientPhone: phone, businessName: null, packageName: pkg?.name, amount: 0,
    coinsGranted: -(Number(pkg?.price) || 0), brief: brief || null,
  }).catch(() => {});
}

module.exports = { autoFulfillSocialCampaign };
