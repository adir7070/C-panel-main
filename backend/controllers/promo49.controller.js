/**
 * promo49.controller.js
 *
 * Public marketing-landing purchase flow for the KLIQ "מבצע 49" — a new client
 * buys the PRO tier at the ₪49 first-month intro price straight from a landing
 * page (no app, no login). After Cardcom confirms the payment we PROVISION the
 * client end-to-end so they can immediately log into the app (phone + OTP) with
 * full access:
 *   users (name)  +  business_profiles (name)  +  cpanel_clients/support_chats
 *   (owned by the promo manager, tagged source:"promo49")  +  activateTierSubscription
 *   (the `subscriptions` active doc that unlocks getPermissions).
 *
 * Mirrors the proven tier-subscription.controller Cardcom plumbing (Operation 2,
 * token, WebHookUrl ?phone=&tier=, cpanel_pending_purchases row). The one hard
 * rule (see auth.controller): the phone MUST be stored canonical `972XXXXXXXXX`
 * — the same form app-login normalizes to — or none of the docs join.
 */
const axios = require("axios");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const cardcomConfig = require("../config/cardcom.config");
const cardcom = require("../services/cardcom.service");
const tierSub = require("../services/tier-subscription.service");
const { requiredEnv } = require("../utils/required-env");

const PENDING_COL = "cpanel_pending_purchases";
const TRANS_COL = "package_transactions";
const PROMO_SOURCE = "promo49";
const PROMO_TIER = "PRO";

/* Israeli mobile → canonical 972XXXXXXXXX (same rule as auth.controller). */
function normalizeIlPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const m = digits.match(/^(?:972|0)(5\d{8})$/);
  return m ? `972${m[1]}` : null;
}

/* The manager who "owns" promo clients in CPANEL. Configurable via
   PROMO49_AGENT_ID; defaults to the admin-boss agent. */
async function resolvePromoOwner(db) {
  const envId = process.env.PROMO49_AGENT_ID;
  if (envId) {
    try { const a = await db.collection("agents").findOne({ _id: new ObjectId(envId) }); if (a) return a; } catch (_) {}
  }
  return db.collection("agents").findOne({ name: "admin-boss" });
}

// POST /api/promo49/purchase  { name, phone, businessName? } → { url }
exports.purchase = async (req, res) => {
  try {
    const name = (req.body.name || "").toString().trim();
    const businessName = (req.body.businessName || "").toString().trim();
    const phone = normalizeIlPhone(req.body.phone);
    if (!name) return res.status(400).json({ error: "נא להזין שם" });
    if (!phone) return res.status(400).json({ error: "מספר טלפון לא תקין" });

    const def = await tierSub.getTierDef(PROMO_TIER);
    if (!def || !(def.monthlyPrice > 0)) return res.status(500).json({ error: "מסלול PRO לא זמין" });

    // Intro price for the FIRST charge (one-time per client); renewals bill full.
    const introEligible = !!def.introEnabled && def.introPrice > 0 && !(await tierSub.hasUsedIntro(phone, PROMO_TIER));
    const firstAmount = introEligible ? def.introPrice : def.monthlyPrice;

    // Capture the lead up front (name) so we have it even before payment clears.
    await getDB().collection("users").updateOne(
      { phone },
      { $set: { phone, name, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );

    const serverBaseUrl = requiredEnv("SERVER_BASE_URL");
    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,
      Amount: firstAmount,
      ISOCoinId: 1, // ILS
      ProductName: introEligible
        ? `מנוי PRO — חודש ראשון במבצע ₪${def.introPrice} (אח״כ ₪${def.monthlyPrice}/חודש)`
        : `מנוי PRO — חודשי`,
      SuccessRedirectUrl: `${serverBaseUrl}/api/promo49/return?status=success`,
      ErrorRedirectUrl: `${serverBaseUrl}/api/promo49/return?status=error`,
      WebHookUrl: `${serverBaseUrl}/api/promo49/confirm?phone=${encodeURIComponent(phone)}&tier=${PROMO_TIER}`,
      ReturnValue: `${phone}|promo49|${PROMO_TIER}`,
      CreateInvoice: false,
      IsCreateToken: true,
      Operation: 2, // charge + create token (for monthly renewal)
      IsApplePay: true,
      IsBit: true,
      IsGooglePay: true,
      CustomerName: name,
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
        tier: PROMO_TIER,
        packageName: def.name,
        monthlyPrice: def.monthlyPrice,
        introApplied: introEligible,
        firstAmount,
        source: PROMO_SOURCE,
        leadName: name,
        leadBusinessName: businessName || null,
        createdAt: new Date(),
      });
    }
    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Promo49] purchase:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/promo49/confirm?phone=&tier=  (Cardcom webhook)
exports.confirm = async (req, res) => {
  res.sendStatus(200); // ack Cardcom immediately

  (async () => {
    try {
      const lowProfileId = req.body?.LowProfileId || req.body?.lowProfileId || req.query.lpid;
      const phone = normalizeIlPhone(req.query.phone) || req.query.phone;
      if (!lowProfileId || !phone) return;

      // idempotency guard
      if (await getDB().collection(TRANS_COL).findOne({ lowProfileId })) return;

      const pending = await getDB().collection(PENDING_COL).findOne({ lowProfileId });
      const introApplied = !!pending?.introApplied;
      const leadName = pending?.leadName || null;
      const leadBusinessName = pending?.leadBusinessName || null;

      const verify = await cardcom.verifyLowProfilePayment(lowProfileId);
      if (!verify || verify.ResponseCode !== 0) {
        console.warn("[Promo49] confirm: Cardcom rejected", verify?.Description);
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

      const db = getDB();

      // 1) users — token + name + source tag
      await db.collection("users").updateOne(
        { phone },
        { $set: {
            ...(token ? { paymentToken: token, paymentExpiry: cardExpiry, paymentLast4: last4 } : {}),
            ...(leadName ? { name: leadName } : {}),
            source: PROMO_SOURCE,
            updatedAt: new Date(),
          },
          $setOnInsert: { phone, createdAt: new Date() },
        },
        { upsert: true },
      );

      // 2) business_profiles — so content creation has business context
      await db.collection("business_profiles").updateOne(
        { phone },
        { $set: { phone, ...(leadBusinessName ? { businessName: leadBusinessName } : {}), updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );

      // 3) cpanel_clients + support_chats — appear in CPANEL, owned by the promo
      //    manager, TAGGED source:"promo49" (the מבצע49 tab filters on this).
      const owner = await resolvePromoOwner(db);
      const agentId = owner ? String(owner._id) : "promo49";
      const agentName = (owner ? (owner.nickname || owner.name || "") : "מבצע 49").replace(/"/g, "");
      await db.collection("cpanel_clients").updateOne(
        { phone },
        { $set: { phone, customerName: leadName || phone, source: PROMO_SOURCE, promoProvisionedAt: new Date() },
          $setOnInsert: { agentId, agentName, firebery1013Id: null, customerId: null, createdAt: new Date() } },
        { upsert: true },
      );
      await db.collection("support_chats").updateOne(
        { phone },
        { $set: { accountManagerId: agentId, accountManagerName: agentName || null },
          $setOnInsert: { phone } },
        { upsert: true },
      );

      // 4) THE UNLOCK — active PRO subscription + coin reset. introApplied →
      //    records intro consumption + delays the first full-price renewal.
      await tierSub.activateTierSubscription({ phone, tier: PROMO_TIER, chargeMode: "paid", token, cardExpiry, last4, introApplied });
      // tag the subscription doc too, for reporting
      await db.collection("subscriptions").updateOne({ phone, source: "tier" }, { $set: { promoSource: PROMO_SOURCE } });

      // idempotency lock + audit
      await db.collection(TRANS_COL).insertOne({
        lowProfileId, phone, kind: "tier_subscription", tier: PROMO_TIER,
        source: PROMO_SOURCE, amount: txnInfo?.Amount ?? null, at: new Date(),
      });
      console.log(`[Promo49] ✅ provisioned + PRO active: ${phone} (${leadName || "?"})`);
    } catch (err) {
      console.error("[Promo49] confirm async:", err.message);
    }
  })();
};

// GET /api/promo49/return — Cardcom redirect landing (success/error)
exports.paymentReturn = (req, res) => {
  const ok = req.query.status === "success";
  res.set("Content-Type", "text/html; charset=utf-8").send(
`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "התשלום התקבל" : "התשלום נכשל"}</title>
<style>body{font-family:system-ui,'Segoe UI',sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(160deg,#EAF1FF,#E6FBF6);color:#0500C8;text-align:center;padding:24px}.card{background:#fff;border-radius:24px;padding:40px 28px;max-width:440px;box-shadow:0 30px 60px -20px rgba(5,0,200,.25)}.big{font-size:56px;margin:0}h1{margin:12px 0 6px;font-size:24px}p{color:#3A3A3A;font-size:16px;line-height:1.6}.store{display:inline-block;margin:6px;padding:12px 18px;border-radius:12px;background:#0500C8;color:#fff;text-decoration:none;font-weight:800}</style></head>
<body><div class="card">
${ok
  ? `<p class="big">🎉</p><h1>המנוי הופעל!</h1><p>הכל מוכן. הורידו את אפליקציית <b>KLIQ</b> והתחברו עם אותו מספר הטלפון — החשבון שלכם פתוח עם כל האופציות.</p>
     <div><a class="store" href="https://play.google.com/store/apps/details?id=com.iconiqmedia.adsmanager" target="_blank" rel="noopener">Google Play</a><a class="store" href="https://apps.apple.com/il/app/kliq/id6755148289" target="_blank" rel="noopener">App Store</a></div>`
  : `<p class="big">❌</p><h1>התשלום לא הושלם</h1><p>לא בוצע חיוב. אפשר לחזור לדף ולנסות שוב.</p>`}
</div></body></html>`,
  );
};
