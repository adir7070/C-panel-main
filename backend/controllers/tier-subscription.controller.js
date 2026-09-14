/**
 * tier-subscription.controller.js
 *
 * Client-facing subscription tiers (REGULAR/PRO/VIP). New clients purchase a
 * monthly recurring subscription; the first charge tokenizes the card (Cardcom
 * Operation 2) so the renewal sweep (tier-subscription.service) can charge each
 * month. Existing clients were grandfathered to a FREE REGULAR tier by
 * scripts/migrate-clients-to-tier.js.
 *
 * Coins are NEVER exposed here — responses advertise price + access only. The
 * monthly coin quota is a hidden backend usage-control granted on activation.
 *
 * Routes (mounted under /api/subscription, no auth — mobile-facing):
 *   GET  /tiers            → purchasable tiers (no coins)
 *   GET  /status?phone=    → this client's subscription status
 *   POST /purchase         → { phone, tier } → Cardcom payment URL
 *   POST /payment-confirm  → Cardcom webhook → activate paid subscription
 */
const axios = require("axios");
const { getDB } = require("../config/db");
const cardcomConfig = require("../config/cardcom.config");
const cardcom = require("../services/cardcom.service");
const tierSub = require("../services/tier-subscription.service");
const { requiredEnv } = require("../utils/required-env");

const PENDING_COL = "cpanel_pending_purchases";
const TRANS_COL = "package_transactions";

// GET /api/subscription/tiers — advertise price + access, never coins.
exports.getTiers = async (req, res) => {
  try {
    const plans = await getDB()
      .collection("subscription_plans")
      .find({ isActive: { $ne: false } })
      .sort({ sortOrder: 1 })
      .toArray();
    const data = plans.map((p) => {
      const key = p.tier || String(p.name).toUpperCase();
      const fb = tierSub.TIER_DEFS[key] || {};
      const introPrice = Number(p.introPrice) || fb.introPrice || 0;
      const introMonths = Number(p.introMonths) || fb.introMonths || 1;
      const introEnabled = (p.introEnabled !== undefined ? Boolean(p.introEnabled) : !!fb.introEnabled) && introPrice > 0;
      return {
        tier: key,
        name: p.name,
        description: p.description || "",
        monthlyPrice: p.monthlyPrice,
        color: p.color || "#0095ff",
        // First-month intro promo (e.g. PRO ₪49 first month, then ₪249/mo).
        introEnabled,
        introPrice: introEnabled ? introPrice : 0,
        introMonths: introEnabled ? introMonths : 0,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[TierSub] getTiers:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// GET /api/subscription/status?phone=
exports.getMyStatus = async (req, res) => {
  const phone = (req.query.phone || "").toString().trim();
  if (!phone) return res.status(400).json({ error: "phone is required" });
  try {
    const sub = await tierSub.getActiveSubscription(phone);
    res.json({
      success: true,
      data: {
        subscriptionActive: !!sub,
        tier: sub?.tier || null,
        planName: sub?.packageName || null,
        nextRenewalAt: sub?.nextChargeAt || null,
        grandfathered: !!sub?.grandfathered,
      },
    });
  } catch (err) {
    console.error("[TierSub] getMyStatus:", err.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// POST /api/subscription/purchase   { phone, tier }
exports.purchaseTier = async (req, res) => {
  try {
    const phone = (req.body.phone || "").toString().trim();
    const tier = (req.body.tier || "").toString().trim().toUpperCase();
    if (!phone || !tier) return res.status(400).json({ error: "phone and tier are required" });

    const def = await tierSub.getTierDef(tier);
    if (!def) return res.status(404).json({ error: `unknown tier: ${tier}` });
    if (!(def.monthlyPrice > 0)) return res.status(400).json({ error: "tier has no price" });

    // Intro promo: charge the intro price for the FIRST charge (one-time per
    // client), then the saved token renews at the full monthlyPrice. The stored
    // recurring amount is set to monthlyPrice at activation, so renewals bill full.
    const introEligible = !!def.introEnabled && def.introPrice > 0 && !(await tierSub.hasUsedIntro(phone, def.tier));
    const firstAmount = introEligible ? def.introPrice : def.monthlyPrice;

    const serverBaseUrl = requiredEnv("SERVER_BASE_URL");
    const user = await getDB().collection("users").findOne({ phone }, { projection: { name: 1 } });
    const clientName = user?.name || phone;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      Amount: firstAmount, // first charge (intro price if eligible, else monthly)
      ISOCoinId: 1, // ILS
      ProductName: introEligible
        ? `מנוי ${def.name} — חודש ראשון במבצע ₪${def.introPrice} (אח״כ ₪${def.monthlyPrice}/חודש)`
        : `מנוי ${def.name} — חודשי`,
      SuccessRedirectUrl: `${serverBaseUrl}/api/subscription/return?status=success`,
      ErrorRedirectUrl: `${serverBaseUrl}/api/subscription/return?status=error`,
      WebHookUrl: `${serverBaseUrl}/api/subscription/payment-confirm?phone=${encodeURIComponent(phone)}&tier=${def.tier}`,
      ReturnValue: `${phone}|tier|${def.tier}`,
      CreateInvoice: false,
      IsCreateToken: true, // tokenize the card for monthly renewal
      Operation: 2, // charge + create token
      IsApplePay: true,
      IsBit: true, // ILS supports Bit
      IsGooglePay: true,
      CustomerName: clientName,
      PhoneNumber: phone,
    };

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, requestBody);
    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }
    const paymentUrl = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await getDB().collection(PENDING_COL).insertOne({
        lowProfileId,
        phone,
        kind: "tier_subscription",
        tier: def.tier,
        packageName: def.name,
        monthlyPrice: def.monthlyPrice,
        introApplied: introEligible,   // first charge was the intro price
        firstAmount,
        source: "tier",
        createdAt: new Date(),
      });
    }
    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[TierSub] purchaseTier:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/subscription/payment-confirm   (Cardcom webhook)
exports.paymentConfirm = async (req, res) => {
  res.sendStatus(200); // ack Cardcom immediately

  (async () => {
    try {
      const lowProfileId = req.body?.LowProfileId || req.body?.lowProfileId || req.query.lpid;
      const phone = req.query.phone || null;
      const tier = (req.query.tier || "").toString().toUpperCase() || null;
      if (!lowProfileId || !phone || !tier) return;

      // idempotency guard
      const done = await getDB().collection(TRANS_COL).findOne({ lowProfileId });
      if (done) return;

      // Recover whether the FIRST charge used the intro promo (recorded at purchase).
      const pending = await getDB().collection(PENDING_COL).findOne({ lowProfileId });
      const introApplied = !!pending?.introApplied;

      const verify = await cardcom.verifyLowProfilePayment(lowProfileId);
      if (!verify || verify.ResponseCode !== 0) {
        console.warn("[TierSub] paymentConfirm: Cardcom rejected", verify?.Description);
        return;
      }

      const tokenInfo = verify.TokenInfo;
      const txnInfo = verify.TranzactionInfo;
      let token = null, cardExpiry = null, last4 = null;
      if (tokenInfo?.Token) {
        token = tokenInfo.Token;
        cardExpiry = String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2);
        last4 = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
      }

      if (token) {
        await getDB().collection("users").updateOne(
          { phone },
          { $set: { paymentToken: token, paymentExpiry: cardExpiry, paymentLast4: last4, updatedAt: new Date() } },
        );
      }

      // Activate the paid subscription — grants the tier's monthly quota (RESET).
      // introApplied → records intro consumption + delays the first full-price renewal.
      await tierSub.activateTierSubscription({ phone, tier, chargeMode: "paid", token, cardExpiry, last4, introApplied });

      // idempotency lock + audit
      await getDB().collection(TRANS_COL).insertOne({
        lowProfileId,
        phone,
        kind: "tier_subscription",
        tier,
        amount: txnInfo?.Amount ?? null,
        at: new Date(),
      });
      console.log(`[TierSub] ✅ paid subscription active: ${phone} → ${tier}`);
    } catch (err) {
      console.error("[TierSub] paymentConfirm async:", err.message);
    }
  })();
};

// GET /api/subscription/return — Cardcom success/error redirect landing (mobile
// closes the in-app browser; a tiny page is enough).
exports.paymentReturn = (req, res) => {
  const ok = req.query.status === "success";
  res.set("Content-Type", "text/html; charset=utf-8").send(
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "התשלום התקבל" : "התשלום נכשל"}</title></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>${ok ? "✅ המנוי הופעל!" : "❌ התשלום לא הושלם"}</h2><p>${ok ? "אפשר לחזור לאפליקציה." : "אפשר לנסות שוב מהאפליקציה."}</p></body></html>`,
  );
};
