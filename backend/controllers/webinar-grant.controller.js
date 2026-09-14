/**
 * webinar-grant.controller.js
 *
 * POST /api/cpanel/clients/:phone/webinar-grant
 *
 * Grants a webinar client everything needed to see their products in the
 * app and unlock the ProductsTab — without a Cardcom purchase. Mirrors
 * paymentConfirm's DB writes for a 0₪ "חבילת וובינר":
 *   • users.activePackage + $push purchasedPackages (items: paidAds + ads = 3)
 *   • webCmpAccess / leadCmpAccess {purchased:true}  ("גישה לממומן" free)
 *   • completed cpanel_pending_purchases row (packages-history view)
 *
 * Auth: standard cpanel agent auth + per-client ownership gate (applied by
 * cpanel.routes.js). Called by the public webinar onboarding form right
 * after wow-ads generation, using the webinar agent's token.
 *
 * Idempotent: if the client already has an activePackage, only the access
 * flags are refreshed and the package is left untouched (never clobbers a
 * real paid package).
 */

const crypto = require("crypto");
const { getDB } = require("../config/db");

const PKG_NAME  = "חבילת וובינר";
const ADS_COUNT = 3;

/* The 0₪ webinar demo package. `items.ads` is the exact key the app's
   getPermissions checks for hasAdsAccess — without a purchasedPackages entry
   carrying it (key "personal_*", ads>0) the client never sees the ממומן
   section, even though the wow-ads were already generated. */
function makeWebinarPkg(purchasedAtISO) {
  return {
    key:         `personal_webinar_${crypto.randomBytes(4).toString("hex")}`,
    name:        PKG_NAME,
    purchasedAt: purchasedAtISO,
    items: { paidAds: ADS_COUNT, ads: ADS_COUNT, organicAds: 0, videos: 0, lps: 0, logos: 0 },
    coins:  0,
    status: "sent_to_creation",
  };
}

/* Completed pending-purchase row — feeds the packages-history view. */
function webinarPendingRow(phone, packageKey, purchasedAt) {
  return {
    lowProfileId:         `webinar_${crypto.randomBytes(8).toString("hex")}`,
    phone,
    kind:                 "personal",
    packageKey,
    packageName:          PKG_NAME,
    description:          PKG_NAME,
    name:                 PKG_NAME,
    totalAmount:          0,
    amountWithVat:        0,
    coinsOverride:        0,
    campaignTrafficCount: 0,
    campaignLeadsCount:   0,
    adsCount:             ADS_COUNT,
    socialAdsCount:       0,
    videosCount:          0,
    landingPagesCount:    0,
    logosCount:           0,
    saleSiteCount:        0,
    source:               "webinar_grant",
    createdAt:            purchasedAt,
    completedAt:          purchasedAt,
  };
}

/* ── GET /api/webinar/survey-stats?agent=webinar ────────────────────────
   PUBLIC aggregate of the onboarding-form opening survey, for the live
   "נתוני הסקר" slide in the webinar deck. Aggregate percentages only —
   no PII. Reads business_profiles.webinarSurvey for the agent's clients. */
exports.surveyStats = async (req, res) => {
  try {
    const agentName = (req.query.agent || "webinar").toString();
    const db = getDB();
    const clients = await db.collection("cpanel_clients")
      .find({ agentName }, { projection: { phone: 1 } }).toArray();
    const phones = [...new Set(clients.map(c => c.phone).filter(Boolean))];
    if (!phones.length) return res.json({ total: 0 });

    const rows = await db.collection("business_profiles").find(
      { phone: { $in: phones }, webinarSurvey: { $exists: true } },
      { projection: { webinarSurvey: 1 } },
    ).toArray();

    const total = rows.length;
    if (!total) return res.json({ total: 0 });
    const pct = (n) => Math.round((n / total) * 100);
    let tried = 0, multi = 0, self = 0, knows = 0, hoursSum = 0, hoursN = 0;
    for (const r of rows) {
      const s = r.webinarSurvey || {};
      if (s.triedPaid)    tried++;
      if (s.multiVendor)  multi++;
      if (s.selfManaged)  self++;
      if (s.knowsLeadCost) knows++;
      if (Number.isFinite(s.hoursPerWeek)) { hoursSum += s.hoursPerWeek; hoursN++; }
    }
    res.json({
      total,
      triedPaidPct:     pct(tried),
      selfManagedPct:   pct(self),
      multiVendorPct:   pct(multi),
      dontKnowCostPct:  pct(total - knows),
      avgHoursPerWeek:  hoursN ? Math.round((hoursSum / hoursN) * 10) / 10 : null,
    });
  } catch (err) {
    console.error("[WebinarGrant] surveyStats:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/clients/webinar-register  { phone } ───────────────
   Lightweight, Mongo-ONLY client creation for the webinar onboarding form.

   The standard POST /clients/add makes several synchronous Fireberry (CRM)
   API calls. Under webinar load (60 forms submitted at once) Fireberry
   rate-limits with 429 and ~95% of client creations fail. The Fireberry
   record is not needed by the webinar flow (ad pipeline + app read from
   Mongo), so this endpoint writes only the cpanel_clients mapping +
   support_chats owner — exactly what saveClientMapping does — with zero
   external calls. Idempotent (upsert on {agentId, phone}). */
exports.webinarRegister = async (req, res) => {
  try {
    const phone = (req.body?.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });
    if (!req.agent?._id) return res.status(401).json({ error: "not authenticated" });

    const agentId   = String(req.agent._id);
    const agentName = (req.agent.nickname || req.agent.name || "").replace(/"/g, "");
    const db = getDB();

    await db.collection("cpanel_clients").updateOne(
      { agentId, phone },
      { $set: { agentId, agentName, phone, customerName: phone, firebery1013Id: null, customerId: null },
        $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    await db.collection("support_chats").updateOne(
      { phone },
      { $set: { accountManagerId: agentId, accountManagerName: agentName || null } },
      { upsert: true },
    );

    return res.json({ success: true, phone, name: phone, source: "webinar_register" });
  } catch (err) {
    console.error("[WebinarGrant] webinarRegister:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/webinar/participants?agent=webinar ─────────────────
   Monitoring feed for the cpanel "וובינר" tab: every client registered by
   the webinar onboarding form (= clients of the webinar agent), joined with
   their characterization, gallery and generated wow-ads. One round-trip. */
exports.participants = async (req, res) => {
  try {
    const agentName = (req.query.agent || "webinar").toString();
    const db = getDB();

    const clients = await db.collection("cpanel_clients")
      .find({ agentName })
      .toArray();
    const phones = [...new Set(clients.map(c => c.phone).filter(Boolean))];
    if (!phones.length) return res.json({ participants: [], total: 0 });

    const [profiles, users, sessions] = await Promise.all([
      db.collection("business_profiles").find({ phone: { $in: phones } }).toArray(),
      db.collection("users").find(
        { phone: { $in: phones } },
        { projection: { phone: 1, activePackage: 1, createdAt: 1 } },
      ).toArray(),
      db.collection("wow_ads_sessions")
        .find({ phone: { $in: phones } })
        .sort({ createdAt: -1 })
        .toArray(),
    ]);

    const profByPhone = Object.fromEntries(profiles.map(p => [p.phone, p]));
    const userByPhone = Object.fromEntries(users.map(u => [u.phone, u]));
    /* newest session per phone (list is createdAt-desc) */
    const sessByPhone = {};
    for (const s of sessions) if (!sessByPhone[s.phone]) sessByPhone[s.phone] = s;

    const participants = clients.map(c => {
      const bp   = profByPhone[c.phone] || {};
      const user = userByPhone[c.phone] || {};
      const sess = sessByPhone[c.phone] || null;
      const ads  = (sess?.generatedAds || [])
        .filter(a => a && (a.imageUrl || a.headline))
        .map(a => ({
          id:       a.id,
          headline: a.headline || "",
          imageUrl: a.imageUrl || null,
          managerApproved: !!a.managerApprovedAt,
        }));

      return {
        phone:          c.phone,
        customerName:   c.customerName || null,
        businessName:   bp.businessName || null,
        categoryKey:    bp.categoryKey || null,
        about:          bp.about || "",
        logoUrl:        bp.logoUrl || null,
        images:         Array.isArray(bp.images) ? bp.images : [],
        servicesCount:  Array.isArray(bp.services) ? bp.services.length : 0,
        targetAudience: Array.isArray(bp.targetAudience) ? bp.targetAudience : [],
        profileUpdatedAt: bp.updatedAt || null,
        packageName:    user.activePackage?.name || null,
        registeredAt:   user.createdAt || bp.updatedAt || null,
        adsSession: sess ? {
          sessionId:  sess.sessionId,
          status:     sess.status,
          createdAt:  sess.createdAt,
          totalAds:   (sess.generatedAds || []).length,
          readyAds:   (sess.generatedAds || []).filter(a => a.imageUrl).length,
          clientApprovalStatus: sess.clientApprovalStatus || null,
        } : null,
        ads,
      };
    });

    /* newest first */
    participants.sort((a, b) =>
      new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));

    res.json({ participants, total: participants.length });
  } catch (err) {
    console.error("[WebinarGrant] participants:", err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.grant = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const db = getDB();
    const usersCol = db.collection("users");

    const now = new Date();
    /* Backdated 24h so the wow-ads session generated moments earlier falls
       inside the package's product-matching time window in ProductsTab. */
    const purchasedAt = new Date(Date.now() - 24 * 3600 * 1000);

    const user = await usersCol.findOne(
      { phone },
      { projection: { activePackage: 1, purchasedPackages: 1 } },
    );

    /* Free "גישה לממומן" — always granted/refreshed (idempotent). */
    const accessSet = {
      webCmpAccess:  { purchased: true, purchasedAt: now },
      leadCmpAccess: { purchased: true, purchasedAt: now },
      updatedAt: now,
    };

    /* Create the purchasable webinar offers (חודשי $300 / שנתי $240×12 /
       דף נחיתה ₪2,000 / עמוד עסקי ₪500) so they appear in the app's packages
       list + cpanel personal catalog, ready to buy. Best-effort — never
       blocks the grant. */
    try {
      await require("../services/webinar-subscription.service").createWebinarOffers(phone, req.agent);
    } catch (offerErr) {
      console.warn("[WebinarGrant] createWebinarOffers:", offerErr.message);
    }

    if (user?.activePackage) {
      /* Never clobber their real activePackage. But if that package has no
         ads (e.g. a custom organic/campaign package), the app's hasAdsAccess
         stays false and the webinar demo ads — already generated — never show.
         Add a 0₪ webinar ads package to purchasedPackages so hasAdsAccess
         opens, leaving activePackage untouched. Idempotent: skip if they
         already have ads access from any personal_* package. */
      const pkgs = Array.isArray(user.purchasedPackages) ? user.purchasedPackages : [];
      const hasAdsAccess = pkgs.some(
        p => (p.key || "").startsWith("personal_") && (p.items?.ads ?? 0) > 0);

      const update = { $set: accessSet };
      let granted = "access_only";
      if (!hasAdsAccess) {
        const pkg = makeWebinarPkg(purchasedAt.toISOString());
        update.$push = { purchasedPackages: pkg };
        granted = "access_and_webinar_ads";
        await db.collection("cpanel_pending_purchases")
          .insertOne(webinarPendingRow(phone, pkg.key, purchasedAt));
        console.log(`[WebinarGrant] ✅ ${phone} → ads access added alongside "${user.activePackage.name || user.activePackage.key}"`);
      }
      await usersCol.updateOne({ phone }, update);
      return res.json({ success: true, granted, package: user.activePackage.name || user.activePackage.key });
    }

    const pkg = makeWebinarPkg(purchasedAt.toISOString());

    await usersCol.updateOne(
      { phone },
      {
        $set:  { activePackage: pkg, ...accessSet },
        $push: { purchasedPackages: pkg },
        $setOnInsert: { phone, coinsUsed: 0, createdAt: now },
      },
      { upsert: true },
    );

    await db.collection("cpanel_pending_purchases")
      .insertOne(webinarPendingRow(phone, pkg.key, purchasedAt));

    console.log(`[WebinarGrant] ✅ ${phone} → ${PKG_NAME} (${ADS_COUNT} ads + campaign access)`);
    return res.json({ success: true, granted: "package_and_access", package: PKG_NAME });
  } catch (err) {
    console.error("[WebinarGrant] grant:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
