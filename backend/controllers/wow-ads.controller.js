/**
 * WOW Ads controller — exposes the 10-ads pipeline via cpanel routes.
 *
 *   POST /cpanel/clients/:phone/wow-ads/generate           — start pipeline
 *   GET  /cpanel/clients/:phone/wow-ads                    — fetch latest session
 *   GET  /cpanel/clients/:phone/wow-ads/status             — quick polling
 *   POST /cpanel/clients/:phone/wow-ads/:adId/regenerate   — regenerate one ad image
 */

const multer = require("multer");
const { getDB } = require("../config/db");
const {
  runAdsPipeline,
  regenerateSingleAd,
  markAdRegenerating,
  failAdRegenerate,
  updateAdText,
  generatePromotionDescription,
  getLatestSessionForPhone,
  setManagerApproval,
  setClientApprovalToken,
  getSessionByClientApprovalToken,
  setClientApprovalDecision,
  setAdImageFromUpload,
} = require("../services/wow-ads.service");

/* Direct handle to the wow_ads_sessions collection so the controller
   can stash campaign metadata that the pipeline service doesn't know
   about (campaignName + the original raw overrides object, surfaced
   to the cpanel campaign-list view). */
const sessionsCol = () => getDB().collection("wow_ads_sessions");
const { notifyManagerOfClientDecision } = require("../services/wow-manager-notify.service");
const { autoBumpToSentToCreation } = require("../services/package-lifecycle.service");

/* When the manager opens the active-package ads panel, we should only
   show sessions generated UNDER the currently-active package — not
   leftover work from an older package. Otherwise a client who just
   bought a new package sees their previous package's ads in the
   "active" view, identical to the products card of the older
   package itself. Returns ms timestamp of the active purchase, or
   null if there is no activePackage on the user doc. */
async function activePackageSinceMs(phone) {
  try {
    const u = await getDB().collection("users").findOne(
      { phone },
      { projection: { activePackage: 1 } },
    );
    const t = u?.activePackage?.purchasedAt;
    if (!t) return null;
    const ms = typeof t === "string" ? Date.parse(t) : new Date(t).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch (_e) {
    return null;
  }
}

function sessionPredatesActive(sess, sinceMs) {
  if (!sinceMs || !sess?.createdAt) return false;
  const t = new Date(sess.createdAt).getTime();
  return Number.isFinite(t) && t < sinceMs;
}

function notifyManagerOnDecision(req, sess, decision, feedback) {
  const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const previewUrl = sess.clientApprovalToken ? `${baseUrl}/wow-ads-preview/${sess.clientApprovalToken}` : null;
  /* Fire-and-forget — never block the client's response on the WhatsApp/SMS push. */
  notifyManagerOfClientDecision({
    kind: "ads",
    decision,
    clientPhone: sess.phone,
    businessName: sess.brief?.businessName,
    feedback,
    previewUrl,
  }).catch(err => console.warn("[wow-ads] notifyManager failed:", err.message));
}

const adImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    cb(ok.includes(file.mimetype) ? null : new Error(`bad mime ${file.mimetype}`), ok.includes(file.mimetype));
  },
});
exports.adImageUploadMw = adImageUpload.single("image");

function newSessionId() {
  return `wad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build a brief payload from the client's business_profile.
 * The pipeline expects: businessName, businessField, businessNiche, about,
 * services, phone, promotion, designStyle, targetAudience, preferredColors, logo.
 */
async function buildBriefForClient(phone) {
  const profile = await getDB().collection("business_profiles").findOne({ phone });
  if (!profile) throw new Error("business_profile not found for this client");

  const required = [];
  if (!profile.businessName)      required.push("businessName");
  if (!profile.categoryKey)       required.push("categoryKey");
  if (!profile.services?.length)  required.push("services");
  if (!profile.pageGoal)          required.push("pageGoal");
  if (required.length) {
    const err = new Error(`חסרים שדות באיפיון: ${required.join(", ")}`);
    err.code = "INCOMPLETE_PROFILE";
    throw err;
  }

  const services = (profile.services || [])
    .map(s => `${s.title}${s.description ? ` — ${s.description}` : ""}${s.price ? ` (${s.price})` : ""}`)
    .join("; ");

  // Accept any non-empty string ref — including data: URLs (fetchAssetBuffer decodes them directly).
  const isValidAssetRef = (u) => typeof u === "string" && u.length > 0;
  const safeLogo = isValidAssetRef(profile.logoUrl) ? profile.logoUrl : null;
  if (safeLogo?.startsWith("data:")) {
    console.log(`[wow-ads] logo for ${phone} is a data: URL (${Math.round(safeLogo.length / 1024)}kb) — will decode in-memory`);
  }
  // Client photos: read BOTH images[] (cpanel/canonical) AND the legacy
  // generalImages[] (where the iOS app stored uploads), deduped — so a photo
  // reaches the ad pipeline no matter which field holds it. Additive: never
  // drops a ref that worked before.
  const seenImg = new Set();
  const galleryImages = [
    ...(Array.isArray(profile.images) ? profile.images : []),
    ...(Array.isArray(profile.generalImages) ? profile.generalImages : []),
  ].filter(u => isValidAssetRef(u) && !seenImg.has(u) && seenImg.add(u));
  // Service photo: imageUrl, falling back to the first images[] entry.
  const serviceImages = (profile.services || [])
    .map(s => (isValidAssetRef(s.imageUrl) ? s.imageUrl
              : (Array.isArray(s.images) ? s.images.find(isValidAssetRef) : null)))
    .filter(isValidAssetRef);
  const safeImages    = [...galleryImages, ...serviceImages];

  return {
    businessName:     profile.businessName,
    businessField:    profile.categoryKey,
    businessNiche:    Array.isArray(profile.subCategoryKeys) ? profile.subCategoryKeys.join(", ") : "",
    about:            profile.about || "",
    services,
    phone,
    promotion:        profile.promotion || "",
    designStyle:      profile.designStyle,
    targetAudience:   Array.isArray(profile.targetAudience) ? profile.targetAudience : [],
    // Ad language (2-letter code). Missing → Hebrew, so existing ads are unchanged.
    language:         profile.language || "he",
    preferredColors:  profile.preferredColors || null,
    logo:             safeLogo,
    images:           safeImages,
    /* Per-client opt-ins for contact info in ads. Default OFF on the
       form, so a missing/false value means "do not surface". When true
       the ad pipeline must render the actual number/address on the
       creative (see buildNanoPromptPrompt). */
    includePhoneInAds:   profile.includePhoneInAds   === true,
    includeAddressInAds: profile.includeAddressInAds === true,
    businessPhone:       profile.businessPhone || "",
    address:             profile.address       || "",
  };
}

/* ── POST /cpanel/clients/:phone/wow-ads/generate ───────────────────── */

exports.generateWowAds = async (req, res) => {
  try {
    const { phone } = req.params;
    /* slotKey scopes this session to a specific campaign slot so multiple
       independent ad-sets can coexist for the same phone.
       Passed as query param (?slotKey=campaign_traffic_0) or body field. */
    const slotKey = req.query.slotKey || req.body?.slotKey || null;

    /* Campaign overrides — a one-off promotional campaign can pass a
       partial brief in req.body.overrides that gets MERGED on top of
       the client's permanent characterization, just for this session.
       The client's business_profiles document is untouched.

       Typical use: "World Cup 22:00 late-night" campaign that needs
       different colors, different services list, different promotion
       text — without rewriting the client's standing profile.

       Recognized override fields are the same ones the brief carries:
         preferredColors, services, promotion, designStyle,
         targetAudience, businessNiche, about
       Any other field passes through to runAdsPipeline as-is, so the
       pipeline can grow new override fields later without controller
       changes.

       campaignName is metadata only — stored on the session for the
       cpanel campaign-list view, never read by the pipeline. */
    const rawOverrides   = req.body?.overrides && typeof req.body.overrides === "object" ? req.body.overrides : null;
    const campaignName   = (req.body?.campaignName || "").toString().slice(0, 120) || null;
    const requestedQuota = req.body?.quota != null ? parseInt(req.body.quota, 10) : null;

    // Build brief from saved characterization
    let brief;
    try {
      brief = await buildBriefForClient(phone);
    } catch (err) {
      if (err.code === "INCOMPLETE_PROFILE") {
        return res.status(400).json({ error: err.message, code: "INCOMPLETE_PROFILE" });
      }
      throw err;
    }

    /* Merge overrides on top of the brief. Strings replace; objects
       (preferredColors) deep-merge so a campaign-blue primary doesn't
       wipe the secondary/accent slots the client picked permanently.

       Campaign מיוחד intent (per product owner, 2026-06-18):
         FROM characterization: business details + logo + client scene photos
         FROM campaign form:    services, promotion, designStyle, colors
       Photos kept as references so gpt-image-2 has visual brand anchors.

       Free-text override fields are TRUNCATED before merge — when the
       manager types a long Hebrew promotion or design-style sentence,
       it bloats the gpt-4o prompt that builds the nano-prompt, which in
       turn produces denser Hebrew copy that gpt-image-2 must render on
       1080×1080 alongside 5 photo refs + logo. The combination pushed
       images.edit past the 75s timeout in prod (see incident
       2026-06-18 wad_mqj8hjoz_9b11eq — two consecutive 75s timeouts).
       Caps below preserve intent without overloading the image call. */
    const OVERRIDE_LIMITS = {
      promotion:     120,
      designStyle:    60,
      services:      150,
      about:         300,
      targetAudience: 0,  // array — skip char cap
    };
    if (rawOverrides) {
      const cleanOverrides = {};
      for (const [k, v] of Object.entries(rawOverrides)) {
        if (v == null || v === "") continue;
        const cap = OVERRIDE_LIMITS[k];
        if (cap && typeof v === "string" && v.length > cap) {
          cleanOverrides[k] = v.slice(0, cap).trim();
        } else {
          cleanOverrides[k] = v;
        }
      }
      if (cleanOverrides.preferredColors && typeof cleanOverrides.preferredColors === "object") {
        cleanOverrides.preferredColors = { ...(brief.preferredColors || {}), ...cleanOverrides.preferredColors };
      }
      Object.assign(brief, cleanOverrides);

      /* Reference-image policy in campaign mode:
           - If the override explicitly supplied images (manager uploaded
             campaign-specific reference photos via the modal), USE them.
             Capped at 3 to keep the EDIT payload light enough to finish
             inside the per-call timeout — past incidents (wad_mqj8hjoz,
             wad_mqj9nl1p, wad_mqja93ji, wad_mqjdt2bf) showed that 5+
             refs reliably hang gpt-image-2.
           - Otherwise drop the brief's stored scene photos so the call
             falls back to images.generate (text + logo only) which
             consistently completes in 30-50s. */
      const overrideImages = Array.isArray(cleanOverrides.images)
        ? cleanOverrides.images.filter(u => typeof u === "string" && u).slice(0, 3)
        : null;
      if (overrideImages && overrideImages.length > 0) {
        brief.images = overrideImages;
        console.log(`[wow-ads] applied campaign overrides for ${phone}/${slotKey}: ${Object.keys(cleanOverrides).join(", ")} (${overrideImages.length} campaign image ref(s) in use)`);
      } else {
        brief.images = [];
        console.log(`[wow-ads] applied campaign overrides for ${phone}/${slotKey}: ${Object.keys(cleanOverrides).join(", ")} (scene photos dropped → GENERATE mode, logo retained)`);
      }
    }

    /* Pull the paid-ads quota AND the active-package fingerprint from
       the user's activePackage. Quota controls how many ads the pipeline
       produces; packageId tags the session so the new "packages history"
       view on the products screen can group products under the right
       package the customer paid for. */
    let quota = 10;
    let packageId = null;
    try {
      const user = await getDB().collection("users").findOne(
        { phone }, { projection: { activePackage: 1 } },
      );
      const ap = user?.activePackage;
      if (ap?.id && ap?.purchasedAt) {
        packageId = `pkg_${ap.id || "custom"}_${String(ap.purchasedAt).replace(/[:.]/g, "-")}`;
      }
    } catch (err) {
      console.warn(`[wow-ads] could not read activePackage for ${phone}: ${err.message}`);
    }
    if (packageId) brief.packageId = packageId;

    /* Manual quota override (e.g. preview pass with quota=1). Clamped
       to [1, 30] inside runAdsPipeline anyway. */
    if (requestedQuota && Number.isFinite(requestedQuota)) {
      quota = requestedQuota;
    }

    const sessionId = newSessionId();

    /* Auto-bump package status from waiting_brief → sent_to_creation on
       first generation. No-op if status is anything else. Fire-and-forget. */
    autoBumpToSentToCreation(phone, "wow-ads-generate").catch(() => {});

    /* Campaign metadata (special-campaign flow) is passed INTO
       runAdsPipeline so it lands in the SAME atomic session-creation upsert
       as status/slotKey/phone/brief. A previous separate parallel stash
       upsert raced that creation: if the stash inserted the doc first,
       runAdsPipeline's $setOnInsert (status, slotKey, phone) became a no-op,
       so a deploy mid-generation left the special campaign with no status —
       and the resume scanner keys off status, so it was never resumed. */
    const campaignMeta = (rawOverrides || campaignName)
      ? { campaignName, campaignOverrides: rawOverrides || null }
      : null;

    // Fire pipeline asynchronously — return sessionId immediately so frontend can poll
    runAdsPipeline(sessionId, phone, brief, quota, slotKey, campaignMeta).catch(err =>
      console.error(`[wow-ads] pipeline crashed for ${sessionId}:`, err)
    );

    res.json({
      success: true,
      sessionId,
      status: "generating_texts",
      quota,
      slotKey,
      campaignName,
      hasOverrides: !!rawOverrides,
    });
  } catch (err) {
    console.error("[wow-ads] generate failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /cpanel/clients/:phone/wow-ads ─────────────────────────────── */

exports.getWowAds = async (req, res) => {
  try {
    const { phone } = req.params;
    const slotKey = req.query.slotKey || null;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone, slotKey),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({
      session: {
        sessionId:      sess.sessionId,
        status:         sess.status,
        totalAds:       sess.totalAds,
        completedCount: sess.completedCount,
        generatedAds:   sess.generatedAds || [],
        error:          sess.error,
        createdAt:      sess.createdAt,
        updatedAt:      sess.updatedAt,
        /* Campaign metadata — present only for one-off campaigns
           started via the cpanel "🎯 קמפיין מיוחד" flow. The cpanel
           uses these to render the campaign card + the "approved →
           generate more" button without an extra round-trip. */
        slotKey:           sess.slotKey || null,
        campaignName:      sess.campaignName || null,
        campaignOverrides: sess.campaignOverrides || null,
        campaignCreatedAt: sess.campaignCreatedAt || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /cpanel/clients/:phone/wow-ads/status ──────────────────────── */

exports.getWowAdsStatus = async (req, res) => {
  try {
    const { phone } = req.params;
    const slotKey = req.query.slotKey || null;
    const [sess, sinceMs] = await Promise.all([
      getLatestSessionForPhone(phone, slotKey),
      activePackageSinceMs(phone),
    ]);
    if (!sess || sessionPredatesActive(sess, sinceMs)) return res.json({ session: null });
    res.json({
      sessionId:      sess.sessionId,
      status:         sess.status,
      totalAds:       sess.totalAds,
      completedCount: sess.completedCount,
      hasImages:      (sess.generatedAds || []).filter(a => a.imageUrl).length,
      error:          sess.error,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-ads/:adId/regenerate ───────────── */

exports.regenerateWowAd = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const slotKey = req.query.slotKey || req.body?.slotKey || null;
    const userChangeRequest = typeof req.body?.userChangeRequest === "string"
      ? req.body.userChangeRequest.trim() || null
      : null;
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });

    /* Mark the ad as regenerating immediately so the frontend's polling
       loop can show a spinner on this card. */
    await markAdRegenerating(sess.sessionId, adId);

    /* Fire the slow pipeline async — Heroku has a hard 30s router timeout
       (H12 → 503), and Gemini image gen + B2 round-trips routinely exceed
       that. regenerateSingleAd clears the regenerating flag on success;
       failAdRegenerate clears it (and stores the error) on failure. */
    regenerateSingleAd(sess.sessionId, adId, userChangeRequest)
      .catch(err => {
        console.error("[wow-ads] regenerate (async) failed:", err);
        failAdRegenerate(sess.sessionId, adId, err.message).catch(() => {});
      });

    res.status(202).json({ success: true, status: "regenerating", sessionId: sess.sessionId });
  } catch (err) {
    console.error("[wow-ads] regenerate kickoff failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-ads/:adId/image — upload custom image ── */

exports.uploadWowAdImage = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const slotKey = req.query.slotKey || null;
    if (!req.file) return res.status(400).json({ error: "image file required (multipart 'image')" });
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const ad = await setAdImageFromUpload(sess.sessionId, adId, req.file.buffer, req.file.mimetype);
    res.json({ success: true, ad });
  } catch (err) {
    console.error("[wow-ads] upload image failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-ads/:adId/promotion-description ──
   Generate a rich Hebrew "promotion-ready" body for the ad. Doesn't touch
   the image — just adds ad.promotionDescription that the manager can copy
   into Meta Ads Manager / Facebook when posting. */

exports.generateAdPromotionDescription = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const slotKey = req.query.slotKey || null;
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const ad = await generatePromotionDescription(sess.sessionId, adId, sess.brief);
    res.json({ success: true, ad });
  } catch (err) {
    console.error("[wow-ads] generate promotion description failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── PUT /cpanel/clients/:phone/wow-ads/:adId — edit text fields only ── */

exports.updateWowAdText = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const slotKey = req.query.slotKey || null;
    const { headline, description, cta } = req.body || {};
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });

    const ad = await updateAdText(sess.sessionId, adId, { headline, description, cta });
    res.json({ success: true, ad });
  } catch (err) {
    console.error("[wow-ads] update text failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-ads/:adId/approve — manager approve ── */

exports.managerApproveAd = async (req, res) => {
  try {
    const { phone, adId } = req.params;
    const slotKey = req.query.slotKey || null;
    const approved = req.body?.approved !== false; // default true
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const ad = await setManagerApproval(sess.sessionId, adId, approved);
    res.json({ success: true, ad });
  } catch (err) {
    console.error("[wow-ads] manager approve failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /cpanel/clients/:phone/wow-ads/send-approval — push to client ── */

exports.sendAdsForApproval = async (req, res) => {
  try {
    const { phone } = req.params;
    const slotKey = req.query.slotKey || null;
    const sess = await getLatestSessionForPhone(phone, slotKey);
    if (!sess) return res.status(404).json({ error: "no session for this client" });
    const approvedCount = (sess.generatedAds || []).filter(a => a.managerApprovedAt && a.imageUrl).length;
    if (approvedCount === 0) {
      return res.status(400).json({ error: "אין מודעות מאושרות לשליחה — אשר לפחות מודעה אחת קודם" });
    }

    const token = await setClientApprovalToken(sess.sessionId);
    const baseUrl = process.env.SERVER_BASE_URL || `${req.protocol}://${req.get("host")}`;
    const previewUrl = `${baseUrl}/wow-ads-preview/${token}`;

    const businessName = sess.brief?.businessName || "העסק שלך";
    const message =
      `שלום! 👋\n\n` +
      `הכנו עבורך ${approvedCount} מודעות שיווקיות ל"${businessName}". ` +
      `אשמח אם תוכל/י לאשר אותן או לכתוב לנו אם משהו דורש שינוי.\n\n` +
      `📄 לתצוגה ואישור:\n${previewUrl}\n\n` +
      `תודה!`;

    const sentChannels = [];
    try {
      const greenApi = require("../services/greenapi.service");
      await greenApi.sendMessage(phone, message);
      sentChannels.push("whatsapp");
    } catch (e) {
      console.warn("[wow-ads] WhatsApp send failed:", e.message);
    }
    try {
      const { sendSMS } = require("../services/sms4free.service");
      await sendSMS(phone, message);
      sentChannels.push("sms");
    } catch (e) {
      console.warn("[wow-ads] SMS send failed:", e.message);
    }

    res.json({ success: true, token, previewUrl, approvedCount, sentChannels });
  } catch (err) {
    console.error("[wow-ads] send approval failed:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ── Public preview HTML (GET /wow-ads-preview/:token, no auth) ───────── */

exports.publicAdsPreviewHtml = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getSessionByClientApprovalToken(token);
    if (!sess) {
      res.status(404).set("Content-Type", "text/html; charset=utf-8").send(notFoundHtml());
      return;
    }
    res.set("Content-Type", "text/html; charset=utf-8").send(renderAdsPreviewHtml(sess, token));
  } catch (err) {
    res.status(500).set("Content-Type", "text/html; charset=utf-8")
      .send(`<h1>שגיאה</h1><p>${escapeHtml(err.message || "שגיאה")}</p>`);
  }
};

/* ── Public approve / reject endpoints ──────────────────────────────── */

exports.publicApproveAds = async (req, res) => {
  try {
    const { token } = req.params;
    const sess = await getSessionByClientApprovalToken(token);
    if (!sess) return res.status(404).json({ error: "invalid token" });
    if (sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected") {
      return res.status(400).json({ error: "already responded" });
    }
    await setClientApprovalDecision(token, "approved");
    notifyManagerOnDecision(req, sess, "approved");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.publicRejectAds = async (req, res) => {
  try {
    const { token } = req.params;
    const feedback = (req.body?.feedback || "").trim().slice(0, 1000);
    const sess = await getSessionByClientApprovalToken(token);
    if (!sess) return res.status(404).json({ error: "invalid token" });
    if (sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected") {
      return res.status(400).json({ error: "already responded" });
    }
    await setClientApprovalDecision(token, "rejected", feedback);
    notifyManagerOnDecision(req, sess, "rejected", feedback);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ─── HTML helpers ─── */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function notFoundHtml() {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<title>הקישור לא תקף</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:Heebo,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0b1430;text-align:center;padding:20px}div{max-width:420px}h1{font-size:28px;margin:0 0 12px;font-weight:800}p{color:#64748b;line-height:1.6}</style>
</head><body><div><h1>הקישור לא תקף או פג תוקף</h1><p>צור קשר עם מנהל התיק שלך לקבלת קישור חדש.</p></div></body></html>`;
}

function renderAdsPreviewHtml(sess, token) {
  const businessName = sess.brief?.businessName || "העסק שלך";
  const ads = (sess.generatedAds || []).filter(a => a.managerApprovedAt && a.imageUrl);
  const responded = sess.clientApprovalStatus === "approved" || sess.clientApprovalStatus === "rejected";
  const proxyOrigin = ""; // image URLs already start with /api/img?... so they resolve relative

  const adsMarkup = ads.map(a => `
    <article class="ad">
      <img src="${escapeHtml(proxyOrigin + a.imageUrl)}" alt="ad ${a.id}" loading="lazy" />
      <div class="ad-body">
        <h3>${escapeHtml(a.headline || "")}</h3>
        <p>${escapeHtml(a.description || "")}</p>
        <span class="cta">${escapeHtml(a.cta || "")}</span>
      </div>
    </article>`).join("");

  const responseBar = responded ? `
    <div class="resp-done resp-${escapeHtml(sess.clientApprovalStatus)}">
      ${sess.clientApprovalStatus === "approved"
        ? `<strong>✓ אישרת את המודעות — תודה!</strong> ניצור איתך קשר בקרוב.`
        : `<strong>✗ העברת בקשה לשינויים</strong>${sess.clientFeedback ? ` — "${escapeHtml(sess.clientFeedback)}"` : ""} — מנהל התיק יחזור אליך.`}
    </div>` : `
    <div class="actions">
      <button id="approve-btn" class="btn btn-ok">אשר את כל המודעות</button>
      <button id="reject-btn"  class="btn btn-no">בקשה לשינויים</button>
    </div>
    <div id="reject-form" class="reject-form" hidden>
      <textarea id="reject-text" placeholder="מה לשנות?" rows="4"></textarea>
      <div class="actions">
        <button id="reject-send" class="btn btn-no">שלח</button>
        <button id="reject-cancel" class="btn btn-quiet">ביטול</button>
      </div>
    </div>`;

  return `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>אישור מודעות — ${escapeHtml(businessName)}</title>
<style>
:root{--ink:#0b1430;--ink-2:#475569;--brand:#1E3A8A;--ok:#059669;--no:#dc2626;--rule:#e2e8f0}
*{box-sizing:border-box}
body{font-family:Heebo,system-ui,sans-serif;margin:0;background:#f8fafc;color:var(--ink);line-height:1.55}
header{padding:24px 16px;background:#fff;border-bottom:1px solid var(--rule);text-align:center}
header h1{margin:0;font-size:22px;font-weight:800}
header p{margin:6px 0 0;color:var(--ink-2);font-size:14px}
main{padding:20px 16px;max-width:1080px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.ad{background:#fff;border:1px solid var(--rule);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.ad img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block}
.ad-body{padding:14px}
.ad-body h3{margin:0 0 6px;font-size:15px;font-weight:800}
.ad-body p{margin:0 0 8px;font-size:13px;color:var(--ink-2)}
.ad-body .cta{display:inline-block;padding:4px 12px;background:var(--brand);color:#fff;border-radius:6px;font-size:11px;font-weight:700}
.actions{display:flex;gap:10px;justify-content:center;margin:24px 0;flex-wrap:wrap}
.btn{padding:14px 28px;border:0;border-radius:999px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}
.btn-ok{background:var(--ok);color:#fff}
.btn-no{background:var(--no);color:#fff}
.btn-quiet{background:#fff;color:var(--ink);border:1px solid var(--rule)}
.reject-form{max-width:520px;margin:0 auto 24px;padding:16px;background:#fff;border:1px solid var(--rule);border-radius:14px}
.reject-form textarea{width:100%;padding:12px;border:1px solid var(--rule);border-radius:10px;font-family:inherit;font-size:14px;resize:vertical}
.resp-done{max-width:560px;margin:24px auto;padding:18px 22px;border-radius:14px;text-align:center;font-size:15px;line-height:1.6}
.resp-approved{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
.resp-rejected{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
</style></head><body>
<header>
  <h1>10 המודעות של ${escapeHtml(businessName)}</h1>
  <p>בדוק את המודעות ולחץ על אחת האפשרויות למטה</p>
</header>
<main>
  <div class="grid">${adsMarkup || "<p style='text-align:center;color:#64748b'>אין מודעות מאושרות לתצוגה.</p>"}</div>
  ${responseBar}
</main>
<script>
(function(){
  var token = ${JSON.stringify(token)};
  var approveBtn = document.getElementById('approve-btn');
  var rejectBtn  = document.getElementById('reject-btn');
  var rejForm    = document.getElementById('reject-form');
  var rejText    = document.getElementById('reject-text');
  var rejSend    = document.getElementById('reject-send');
  var rejCancel  = document.getElementById('reject-cancel');

  function post(path, body){
    return fetch(path, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body || {}),
    }).then(function(r){ return r.json().then(function(j){ return r.ok ? j : Promise.reject(j); }); });
  }

  if (approveBtn) approveBtn.addEventListener('click', function(){
    approveBtn.disabled = true; approveBtn.textContent = 'שולח...';
    post('/api/wow-ads-preview/' + token + '/approve').then(function(){ location.reload(); })
      .catch(function(e){ alert((e && e.error) || 'שגיאה'); approveBtn.disabled = false; approveBtn.textContent = 'אשר את כל המודעות'; });
  });
  if (rejectBtn) rejectBtn.addEventListener('click', function(){ rejForm.hidden = false; rejectBtn.scrollIntoView({behavior:'smooth'}); });
  if (rejCancel) rejCancel.addEventListener('click', function(){ rejForm.hidden = true; });
  if (rejSend) rejSend.addEventListener('click', function(){
    rejSend.disabled = true; rejSend.textContent = 'שולח...';
    post('/api/wow-ads-preview/' + token + '/reject', { feedback: rejText.value }).then(function(){ location.reload(); })
      .catch(function(e){ alert((e && e.error) || 'שגיאה'); rejSend.disabled = false; rejSend.textContent = 'שלח'; });
  });
})();
</script>
</body></html>`;
}
