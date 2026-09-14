/**
 * social-redeem.service — redeem a social-kind package by DEBITING the
 * client's coin balance (no Cardcom, no money). Shared by:
 *   - mobile:  POST /api/packages/redeem-with-coins
 *   - cpanel:  POST /api/cpanel/clients/:phone/redeem-social-package
 *
 * The debit + activePackage write happens atomically via a single
 * findOneAndUpdate with a `coins: { $gte: cost }` guard, so two
 * simultaneous clicks can't double-spend coins.
 */
const { getDB } = require("../config/db");
const { getPackageByKey } = require("./cpanel-products.service");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { billingEnabled } = require("../utils/billing");

const USERS_COL = "users";
const TRANS_COL = "package_transactions";

/**
 * Redeem a social plan against the client's coin balance.
 *
 * @param {object} args
 * @param {string} args.phone         — client phone (already normalized)
 * @param {string} args.packageKey    — must exist with kind === "social"
 * @param {object} [args.actor]       — { id, name } of who initiated (admin/agent)
 * @param {"mobile"|"cpanel"|"agent"} [args.source="mobile"]
 * @param {object} [args.brief]       — optional brief captured by the
 *   mobile app BEFORE redemption — { concept, importantInfo[], cta }.
 *   Persisted inline on `users.activePackage.brief` and the
 *   `cpanel_pending_purchases` mirror row, plus passed through to the
 *   manager notification and purchase webhook. Defaults to null.
 *
 * @returns {Promise<{
 *   success: true,
 *   packageName: string,
 *   coinsCharged: number,
 *   coinsRemaining: number,
 * } | {
 *   success: false,
 *   reason: "package_not_found"|"insufficient_coins"|"user_not_found",
 *   message: string,
 *   coinsRequired?: number,
 *   coinsAvailable?: number,
 * }>}
 */
async function redeem({ phone, packageKey, actor = null, source = "mobile", brief = null, schedule = null, facebook = null, instagram = null, focusService = null }) {
  if (!phone || !packageKey) {
    return { success: false, reason: "bad_input", message: "phone ו-packageKey נדרשים" };
  }

  const pkg = await getPackageByKey(packageKey);
  if (!pkg || pkg.kind !== "social") {
    return { success: false, reason: "package_not_found", message: "חבילה לא נמצאה" };
  }

  // While billing is off the plan is free: no cost, no balance guard, no debit.
  // The price is only consulted — and only validated — when actually charging.
  const charging = billingEnabled();
  const cost = charging ? (Number(pkg.price) || 0) : 0;
  if (charging && cost <= 0) {
    return { success: false, reason: "package_not_found", message: "חבילה ללא מחיר תקין" };
  }

  const db = getDB();
  const now = new Date();

  /* Normalize the incoming brief — accept whatever the caller sent but
     coerce to the documented shape so downstream consumers don't have
     to defend against e.g. importantInfo being a single string. */
  const safeBrief = brief && typeof brief === "object" ? {
    concept:       typeof brief.concept === "string" ? brief.concept : "",
    importantInfo: Array.isArray(brief.importantInfo) ? brief.importantInfo.filter(Boolean) : [],
    cta:           typeof brief.cta === "string" ? brief.cta : "",
  } : null;

  const packageEntry = {
    key:         pkg.key,
    name:        pkg.name,
    purchasedAt: now.toISOString(),
    items:       pkg.items || {},
    coins:       0,            // no coins GRANTED — they were debited
    status:      "waiting_brief",
    brief:       safeBrief,
  };

  /* Atomic debit + activePackage set. Guards against:
       - User missing (matched: 0).
       - Insufficient coins (matched: 0).
       - Double-click races (only one $inc fires for either click). */
  const result = await db.collection(USERS_COL).findOneAndUpdate(
    charging ? { phone, coins: { $gte: cost } } : { phone },
    {
      $set:  { activePackage: packageEntry, updatedAt: now },
      ...(charging ? { $inc: { coins: -cost, coinsUsed: cost } } : {}),
      $push: { purchasedPackages: packageEntry },
    },
    { returnDocument: "after", projection: { coins: 1, name: 1 } },
  );

  if (!result) {
    /* Either the user doesn't exist, or coins < cost. Distinguish by a
       lookup so the caller can show the right error. */
    const user = await db.collection(USERS_COL).findOne(
      { phone },
      { projection: { coins: 1 } },
    );
    if (!user) {
      return { success: false, reason: "user_not_found", message: "לקוח לא נמצא" };
    }
    return {
      success: false,
      reason: "insufficient_coins",
      message: "אין מספיק טוקנים לרכישת החבילה",
      coinsRequired:  cost,
      coinsAvailable: user.coins || 0,
    };
  }

  /* Record the redemption so cpanel history + audit can see it. */
  await db.collection(TRANS_COL).insertOne({
    phone,
    packageKey:   pkg.key,
    packageName:  pkg.name,
    amount:       0,           // no money exchanged
    coinsCharged: cost,
    coinsGranted: 0,
    source:       `${source}-coins-redemption`,
    actor:        actor || null,
    createdAt:    now,
  });

  /* FULLY AUTOMATIC mobile social campaign — the client picked a publishing
     schedule, so generate the posts at CPANEL quality and schedule them to
     publish at the client's chosen times. NO manager, NO cpanel_pending_purchases,
     nothing shown in CPANEL. The social twin of the ADS campaign-brief auto-flow. */
  const autoFulfill = Array.isArray(schedule) && schedule.length > 0;
  if (autoFulfill) {
    require("./social-campaign.service")
      .autoFulfillSocialCampaign({ phone, pkg, brief: safeBrief, schedule, facebook, instagram, focusService })
      .catch(err => console.error("[social-redeem] auto-fulfill failed:", err.message));
  } else {
  /* Mirror to cpanel_pending_purchases so the CPanel history view
     (listClientPackages) shows this redemption alongside paid packages.
     Money fields zeroed; coinsOverride records the debit. */
  try {
    const items = pkg.items || {};
    await db.collection("cpanel_pending_purchases").insertOne({
      phone,
      kind:        "social_redemption",
      packageKey:  pkg.key,
      description: pkg.name,
      name:        pkg.name,
      adsCount:          Number(items.paidAds)    || 0,
      socialAdsCount:    Number(items.social_ad)  || Number(items.organicAds) || 0,
      organicPosts:      0,
      videosCount:       Number(items.videos)     || 0,
      landingPagesCount: Number(items.lps)        || 0,
      logosCount:        Number(items.logos)      || 0,
      coinsOverride:     -cost,                  // negative = debit, not grant
      totalAmount:       0,
      brief:             safeBrief,              // null if caller omitted
      source:            `${source}-coins-redemption`,
      createdAt:         now,
      completedAt:       now,
    });
  } catch (err) {
    console.warn("[social-redeem] cpanel_pending_purchases insert failed:", err.message);
  }

  /* Notify the assigned manager — same path as a Cardcom purchase. */
  require("./wow-manager-notify.service")
    .notifyManagerOfPurchase({
      clientPhone:  phone,
      businessName: null,
      packageName:  pkg.name,
      amount:       0,
      coinsGranted: -cost,
      brief:        safeBrief,
    })
    .catch(err => console.warn("[social-redeem] notifyManagerOfPurchase failed:", err.message));
  } // end manual (non-auto-fulfill) flow

  /* Webhook (purchase_success with money=0, coins=-cost). */
  Promise.resolve().then(async () => {
    const clientMapping = await db.collection("cpanel_clients").findOne(
      { phone },
      { projection: { agentId: 1 } },
    );
    const agentDoc = clientMapping?.agentId
      ? await db.collection("agents").findOne(
          { _id: clientMapping.agentId },
          { projection: { name: 1, nickname: 1, email: 1, phone: 1 } },
        )
      : null;
    return sendPurchaseWebhook({
      event:     "purchase_success",
      source:    `${source}-coins-redemption`,
      timestamp: now.toISOString(),
      client:    { phone },
      manager: {
        id:    clientMapping?.agentId || null,
        name:  agentDoc?.nickname || agentDoc?.name || null,
        email: agentDoc?.email || null,
        phone: agentDoc?.phone || null,
      },
      package: {
        name:         pkg.name,
        kind:         "social",
        amount:       0,
        coinsGranted: -cost,
        items:        pkg.items || {},
        brief:        safeBrief,
      },
      payment: { lowProfileId: null },
    });
  }).catch(err => console.warn("[social-redeem] webhook failed:", err.message));

  console.log(`[social-redeem] ${phone} → ${pkg.name} (-${cost} coins, balance: ${result.coins})`);

  return {
    success: true,
    packageName:    pkg.name,
    coinsCharged:   cost,
    coinsRemaining: result.coins,
  };
}

module.exports = { redeem };
