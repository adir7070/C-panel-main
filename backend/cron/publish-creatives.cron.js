const cron = require("node-cron");
const { DB } = require("../config/db");
const fbService = require("../services/facebook.service");
const igService = require("../services/instagram.service");
const cpanelCtrl = require("../controllers/cpanel.controller");

const SERVER_BASE_URL = process.env.BASE_URL || "https://iconiq-b19bf9d01fab.herokuapp.com";

// Ensure relative image URLs become absolute before sending to external APIs
function toAbsoluteUrl(url) {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${SERVER_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * If the order arrived without facebook/instagram tokens (the C-panel
 * social-schedule path sends empty objects), resolve the client's
 * credentials from Fireberry/Mongo at publish time. WOW Ads orders
 * already carry their own tokens and pass through untouched.
 *
 * Returns a clone of the order with `.facebook` / `.instagram` populated
 * where possible. Doesn't write back to DB — fresh resolution every
 * 15-min cron tick is safer than caching a possibly-expired snapshot.
 */
async function hydrateTokensIfMissing(order) {
  const hasFb = order.facebook?.pageToken && order.facebook?.pageId;
  const hasIg = order.instagram?.token && order.instagram?.id;
  if (hasFb && hasIg) return order;
  if (!order.phone) return order;
  try {
    const creds = await cpanelCtrl.getClientFbCredentials(order.phone);

    let pageToken = order.facebook?.pageToken;
    let pageId = order.facebook?.pageId;

    if (!hasFb && creds?.userToken && creds?.pageId) {
      pageId = creds.pageId;
      pageToken = await cpanelCtrl.getPageAccessToken(creds.userToken, creds.pageId) || creds.userToken;
    }

    // Resolve Instagram account ID from the Facebook page at publish time
    let igId = order.instagram?.id;
    if (!igId && pageToken && pageId) {
      try {
        const axios = require("axios");
        const { data } = await axios.get(
          `https://graph.facebook.com/v23.0/${pageId}`,
          { params: { fields: "instagram_business_account{id}", access_token: pageToken } }
        );
        igId = data?.instagram_business_account?.id || null;
        if (igId) console.log(`[PublishCron] Resolved IG id=${igId} for ${order.phone}`);
      } catch (e) {
        console.warn(`[PublishCron] IG ID lookup failed for ${order.phone}: ${e.message}`);
      }
    }

    return {
      ...order,
      facebook: hasFb ? order.facebook : {
        ...(order.facebook || {}),
        pageToken,
        pageId,
        userToken: creds?.userToken || null,
      },
      instagram: hasIg ? order.instagram : {
        ...(order.instagram || {}),
        token: creds?.igToken || order.instagram?.token || null,
        id: igId,
      },
    };
  } catch (err) {
    console.warn(`[PublishCron] hydrate failed for ${order.phone}: ${err.message}`);
    return order;
  }
}

// Hebrew day letter → JS getDay() (0=Sun, 1=Mon, ... 6=Sat)
const HEBREW_DAY_MAP = { א: 0, ב: 1, ג: 2, ד: 3, ה: 4, ו: 5, ש: 6 };

const orders = () => DB.collection("ai_creation_orders");

/**
 * Returns current time as "HH:MM" and Hebrew day letter — Israel timezone.
 */
function getCurrentSlotKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  let hh = get("hour");
  if (hh === "24") hh = "00"; // midnight edge case
  const mm = get("minute").padStart(2, "0");

  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const jsDay = weekdays.indexOf(get("weekday"));
  const hebrewDay = Object.keys(HEBREW_DAY_MAP).find((k) => HEBREW_DAY_MAP[k] === jsDay);

  // "YYYY-MM-DD" in Israel timezone
  const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);

  return { time: `${hh}:${mm}`, day: hebrewDay, todayDate };
}

/**
 * Publish one creative (post or carousel) to Facebook and/or Instagram.
 * Returns a publishLog entry.
 */
async function publishCreative(creative, order, slotTime, slotDay) {
  const { type, desc, imageUrl, slides } = creative;
  const { facebook, instagram } = order;
  const logEntry = {
    slot: slotTime,
    day: slotDay,
    publishedAt: new Date(),
    facebook: null,
    instagram: null,
  };

  const imageUrls = (type === "carousel"
    ? (slides || []).filter((s) => s.imageUrl).map((s) => s.imageUrl)
    : imageUrl ? [imageUrl] : []
  ).map(toAbsoluteUrl);

  if (imageUrls.length === 0) {
    logEntry.facebook = { status: "skipped", error: "no images available" };
    logEntry.instagram = { status: "skipped", error: "no images available" };
    return logEntry;
  }

  // ── Facebook ────────────────────────────────────────────────────────────
  if (facebook?.pageToken && facebook?.pageId) {
    try {
      let result;
      if (type === "carousel") {
        result = await fbService.publishCarousel(facebook.pageToken, facebook.pageId, imageUrls, desc);
      } else {
        result = await fbService.publishPhoto(facebook.pageToken, facebook.pageId, imageUrls[0], desc);
      }
      logEntry.facebook = { status: "success", postId: result.postId };
    } catch (err) {
      logEntry.facebook = { status: "failed", error: err.response?.data?.error?.message || err.message };
    }
  }

  // ── Instagram ───────────────────────────────────────────────────────────
  if (instagram?.token && instagram?.id) {
    try {
      let result;
      if (type === "carousel") {
        result = await igService.publishCarousel(instagram.token, instagram.id, imageUrls, desc);
      } else {
        result = await igService.publishPhoto(instagram.token, instagram.id, imageUrls[0], desc);
      }
      logEntry.instagram = { status: "success", postId: result.postId, permalink: result.permalink || null };
    } catch (err) {
      logEntry.instagram = { status: "failed", error: err.response?.data?.error?.message || err.message };
    }
  }

  return logEntry;
}

/**
 * Main cron handler — runs every 15 min at :00/:15/:30/:45
 */
async function runPublishCron() {
  const { time, day, todayDate } = getCurrentSlotKey();
  const tag = `[PublishCron ${time} ${day}]`;
  console.log(`${tag} Running`);

  // Match weekly recurring slots (Hebrew day letter) OR one-time specific-date slots
  const matchingOrders = await orders()
    .find({
      creativesStatus: "completed",
      creativesFullyPublished: { $ne: true },
      $or: [
        { "publish.slots": { $elemMatch: { time, days: day } } },
        { "publish.slots": { $elemMatch: { time, specificDate: todayDate } } },
      ],
    })
    .toArray();

  if (matchingOrders.length === 0) {
    console.log(`${tag} No matching orders`);
    return;
  }

  console.log(`${tag} ${matchingOrders.length} order(s) to process`);

  for (const order of matchingOrders) {
    const orderId = order._id;
    const creatives = order.creatives || [];
    const pointer = order.publishPointer ?? 0;

    // Skip already-failed creatives to find next publishable one
    let nextPointer = pointer;
    while (
      nextPointer < creatives.length &&
      (creatives[nextPointer].status === "failed" ||
       creatives[nextPointer].status === "cancelled")
    ) {
      nextPointer++;
    }

    if (nextPointer >= creatives.length) {
      // All published
      await orders().updateOne(
        { _id: orderId },
        { $set: { creativesFullyPublished: true, updatedAt: new Date() } }
      );
      console.log(`${tag} Order ${orderId} — all creatives published ✅`);
      continue;
    }

    const creative = creatives[nextPointer];
    console.log(`${tag} Order ${orderId} — publishing creative[${nextPointer}] (${creative.type})`);

    const hydratedOrder = await hydrateTokensIfMissing(order);
    const logEntry = await publishCreative(creative, hydratedOrder, time, day);

    const fbStatus = logEntry.facebook?.status ?? "—";
    const igStatus = logEntry.instagram?.status ?? "—";
    const anySuccess = fbStatus === "success" || igStatus === "success";
    logEntry.overallStatus = anySuccess ? (fbStatus === igStatus ? "success" : "partial") : "failed";

    // Advance pointer only if at least one platform succeeded
    const newPointer = anySuccess ? nextPointer + 1 : nextPointer;

    const publishLogField = `creatives.${nextPointer}.publishLog`;
    await orders().updateOne(
      { _id: orderId },
      {
        $push: { [publishLogField]: logEntry },
        $set: {
          publishPointer: newPointer,
          [`creatives.${nextPointer}.status`]: anySuccess ? "published" : "failed",
          updatedAt: new Date(),
        },
      }
    );

    console.log(`${tag} Order ${orderId} — FB: ${fbStatus} | IG: ${igStatus} | overall: ${logEntry.overallStatus}`);
  }
}

/**
 * Publish the next pending creative for every order — no time/slot filter.
 * Used by the manual trigger endpoint for testing / recovery.
 * Returns an array of result objects.
 */
async function runPublishAll() {
  const tag = "[PublishAll]";
  console.log(`${tag} Running manual trigger`);

  const pending = await orders()
    .find({ creativesStatus: "completed", creativesFullyPublished: { $ne: true } })
    .toArray();

  console.log(`${tag} ${pending.length} order(s) with pending creatives`);

  const results = [];

  for (const order of pending) {
    const orderId = order._id;
    const creatives = order.creatives || [];
    const pointer = order.publishPointer ?? 0;

    // Skip already-failed creatives
    let nextPointer = pointer;
    while (
      nextPointer < creatives.length &&
      (creatives[nextPointer].status === "failed" ||
       creatives[nextPointer].status === "cancelled")
    ) {
      nextPointer++;
    }

    if (nextPointer >= creatives.length) {
      await orders().updateOne(
        { _id: orderId },
        { $set: { creativesFullyPublished: true, updatedAt: new Date() } }
      );
      results.push({ orderId, creativeIndex: null, overall: "all_done" });
      continue;
    }

    const creative = creatives[nextPointer];
    const logEntry = await publishCreative(creative, order, "manual", null);

    const fbStatus = logEntry.facebook?.status ?? "—";
    const igStatus = logEntry.instagram?.status ?? "—";
    const anySuccess = fbStatus === "success" || igStatus === "success";
    logEntry.overallStatus = anySuccess ? (fbStatus === igStatus ? "success" : "partial") : "failed";

    const newPointer = anySuccess ? nextPointer + 1 : nextPointer;
    const publishLogField = `creatives.${nextPointer}.publishLog`;

    await orders().updateOne(
      { _id: orderId },
      {
        $push: { [publishLogField]: logEntry },
        $set: {
          publishPointer: newPointer,
          [`creatives.${nextPointer}.status`]: anySuccess ? "published" : "failed",
          updatedAt: new Date(),
        },
      }
    );

    console.log(`${tag} Order ${orderId} creative[${nextPointer}] — FB: ${fbStatus} | IG: ${igStatus} | overall: ${logEntry.overallStatus}`);

    results.push({
      orderId,
      creativeIndex: nextPointer,
      imageUrls: creative.type === "carousel"
        ? (creative.slides || []).map((s) => s.imageUrl).filter(Boolean)
        : [creative.imageUrl].filter(Boolean),
      fb: fbStatus,
      fbError: logEntry.facebook?.error ?? null,
      fbPostId: logEntry.facebook?.postId ?? null,
      ig: igStatus,
      igError: logEntry.instagram?.error ?? null,
      igPostId: logEntry.instagram?.postId ?? null,
      igPermalink: logEntry.instagram?.permalink ?? null,
      overall: logEntry.overallStatus,
    });
  }

  return results;
}

/**
 * Register and start the cron job.
 * Call once at server boot.
 */
function startPublishCron() {
  // Runs at :00, :15, :30, :45 of every hour — Israel time
  cron.schedule("0,15,30,45 * * * *", async () => {
    try {
      await runPublishCron();
    } catch (err) {
      console.error("[PublishCron] Uncaught error:", err.message);
    }
  });
  console.log("⏰ PublishCron started (every 15 min at :00/:15/:30/:45)");
}

module.exports = { startPublishCron, runPublishAll };
