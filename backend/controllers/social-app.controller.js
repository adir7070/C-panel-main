/**
 * social-app.controller — the per-day "ליצירת מודעה" generation for the mobile app.
 *
 * Same server pipeline as the package auto-fulfill (generate HQ organic post →
 * ai_creation_orders → appears via GET /api/app/posts), but generates ONLY the
 * requested number of posts (default 1) for the chosen day, with NO package.
 * Billing is handled app-side (per-post coins), like the existing per-day flow.
 *
 * Fire-and-forget (mirrors the package flow) so the request returns immediately
 * and never hits the router timeout while gpt-image-2 runs.
 */
const { getDB } = require("../config/db");
const { billingEnabled } = require("../utils/billing");

// Coins charged per generated social post (Instagram). Flat, client-visible price.
const SOCIAL_AD_PRICE = 90;
const TRANS_COL = "coin_transactions";

exports.generateSocialDay = async (req, res) => {
  try {
    const { phone, brief, focusService, schedule, facebook, instagram, count } = req.body || {};
    if (!phone) return res.status(400).json({ success: false, error: "phone is required" });
    if (!Array.isArray(schedule) || schedule.length === 0) {
      return res.status(400).json({ success: false, error: "schedule (with a date) is required" });
    }

    require("../services/social-campaign.service")
      .autoFulfillSocialCampaign({
        phone,
        pkg: null,                       // no package — per-day single post
        brief,
        schedule,
        facebook,
        instagram,
        focusService,
        countOverride: Number(count) || 1,
      })
      .catch(err => console.error(`[social-day] ${phone} generation failed:`, err.message));

    return res.json({ success: true });
  } catch (err) {
    console.error("[social-day] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * createSocialWithCoins — the app "בחרו כמות" flow: the client picks N posts at
 * SOCIAL_AD_PRICE coins each, so we charge N × SOCIAL_AD_PRICE atomically, then
 * fire generation of EXACTLY N posts (same auto-fulfill pipeline, countOverride = N).
 * End-to-end guarantee: pay for N → get N.
 *
 * The debit is race-safe (findOneAndUpdate with a `coins >= cost` guard), so two
 * simultaneous taps can't double-spend. Generation is fire-and-forget (mirrors the
 * package flow) so the request returns immediately.
 *
 * Returns { success:true, coinsCharged, coinsRemaining }
 *   or   { success:false, reason:"insufficient_coins"|"user_not_found"|"bad_input", ... }
 */
exports.createSocialWithCoins = async (req, res) => {
  try {
    const { phone, brief, focusService, schedule, facebook, instagram, count } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, reason: "bad_input", message: "phone is required" });
    }
    if (!Array.isArray(schedule) || schedule.length === 0) {
      return res.status(400).json({ success: false, reason: "bad_input", message: "schedule (with a date) is required" });
    }
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const charging = billingEnabled();
    const cost = charging ? n * SOCIAL_AD_PRICE : 0;

    const db = getDB();

    // Atomic, race-safe debit — succeeds only if the user currently has >= cost coins.
    // Free posts have nothing to guard, so the balance filter and the $inc both drop;
    // the lookup stays so a missing user is still reported rather than silently served.
    const updated = await db.collection("users").findOneAndUpdate(
      charging ? { phone, coins: { $gte: cost } } : { phone },
      charging
        ? { $inc: { coins: -cost }, $set: { updatedAt: new Date() } }
        : { $set: { updatedAt: new Date() } },
      { returnDocument: "after", projection: { coins: 1 } },
    );

    if (!updated) {
      // No match → either the user doesn't exist or coins < cost. Distinguish.
      const user = await db.collection("users").findOne({ phone }, { projection: { coins: 1 } });
      if (!user) {
        return res.json({ success: false, reason: "user_not_found", message: "משתמש לא נמצא" });
      }
      return res.json({
        success: false,
        reason: "insufficient_coins",
        message: "אין מספיק מטבעות",
        coinsRequired: cost,
        coinsAvailable: user.coins || 0,
      });
    }

    const coinsRemaining = updated.coins ?? 0;

    // Bookkeeping — mirror coins.controller deductCoins so the ledger stays consistent.
    // Nothing was charged while billing is off, so no ledger row is written.
    if (cost > 0) {
      await db.collection(TRANS_COL).insertOne({
        phone,
        type: "deduct",
        amount: cost,
        action: "social_ad_create",
        quantity: n,
        reason: "יצירת פוסטים לסושיאל",
        balance_after: coinsRemaining,
        created_at: new Date(),
      }).catch(err => console.error("[social-create] tx log failed:", err.message));
    }

    // Fire generation of EXACTLY n posts (fire-and-forget, like generate-day).
    require("../services/social-campaign.service")
      .autoFulfillSocialCampaign({
        phone,
        pkg: null,
        brief,
        schedule,
        facebook,
        instagram,
        focusService,
        countOverride: n,
      })
      .catch(err => console.error(`[social-create] ${phone} generation failed:`, err.message));

    return res.json({ success: true, coinsCharged: cost, coinsRemaining });
  } catch (err) {
    console.error("[social-create] error:", err.message);
    return res.status(500).json({ success: false, reason: "bad_input", message: err.message });
  }
};
