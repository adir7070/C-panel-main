/**
 * webinar-subscription.service.js
 *
 * The webinar offer family — four personal_packages offers created for every
 * webinar client, on TOP of the existing personal_packages + Cardcom token
 * infrastructure:
 *
 * Prices are charged in ILS but DISPLAYED to the client in USD (₪ ≈ $ × 3):
 *   • "חבילת וובינר חודשי"  — ₪897/mo (shown $299). 5,000 coins/mo, all three
 *     campaign accesses (leads + traffic + social).
 *   • "חבילת וובינר שנתי"   — same + landing page + strategy call. ₪597/mo
 *     (shown $199) billed as ONE yearly charge of ₪7,164. 5,000 coins/mo.
 *   • "חבילת דף נחיתה"      — one-time ₪447 (shown $149) FINAL, VAT included.
 *   • "חבילת פתיחת עמוד עסקי" — one-time ₪147 (shown $49) FINAL, VAT included,
 *     Meta business-page setup service only. Not a subscription.
 *
 *   • createWebinarOffers(phone, agent) → upserts the purchasable offers into
 *     personal_packages. They then show automatically in the app
 *     (GET /api/packages/personal) and in the cpanel personal catalog.
 *
 *   • recordSubscription(...)           → after a successful first charge (which
 *     saved a card token), writes a `subscriptions` doc so the renewal job can
 *     charge the token every cycle (month / year).
 *
 *   • renewDueSubscriptions()           → the charge sweep. GATED by
 *     env SUBSCRIPTION_RENEWAL_ENABLED — until that is "true" it runs in
 *     DRY-RUN (logs what it would charge, charges nothing). This prevents an
 *     untested billing job from touching real cards. First renewal is ~30 days
 *     out, so there is ample time to verify before enabling. Yearly subs also
 *     get their monthly coin top-up here (no card involved — always live).
 */

const { getDB } = require("../config/db");

const PKG_KEY      = "webinar_subscription";
const COINS        = 5000;
const CURRENCY_USD = 2;          // Cardcom ISOCoinId: 2 = USD, 1 = ILS
const CURRENCY_ILS = 1;
const RENEWAL_ENABLED = () => String(process.env.SUBSCRIPTION_RENEWAL_ENABLED || "").toLowerCase() === "true";

/* Kept for backward compat with older imports/logs. */
const PKG_NAME  = "חבילת וובינר חודשי";
const PRICE_USD = 300;

/* ── TEST PRICING ───────────────────────────────────────────────────────
   When true, EVERY webinar offer costs ₪1 (all offers are ILS) so the whole
   purchase flow can be tested end-to-end against a real ~1-shekel Cardcom
   charge. ⚠️ Set back to false BEFORE going live, then reopen /packages (or
   re-run the grant) so the offers are rewritten at their real prices. */
const TEST_PRICING = false;
const _price = (real) => (TEST_PRICING ? 1 : real);

function addMonths(date, n){
  const d = new Date(date);
  const target = d.getMonth() + n;
  d.setMonth(target);
  return d;
}

/* Items keys map (via normalizePackageItems) to the access flags getPermissions
   checks: campaign_leads→leads, campaign_traffic→traffic, social_ad→social.
   lp → landing page quota. */
const CAMPAIGN_ITEMS = { campaign_leads: 1, campaign_traffic: 1, social_ad: 1 };
const CAMPAIGN_BULLETS = [
  "🎯 קמפיין לידים",
  "🌐 קמפיין טראפיק",
  "📣 קמפיין סושיאל",
  "🪙 5,000 מטבעות בחודש",
];

/* The three webinar offers. `key` identifies each offer; `match` is the upsert
   filter — for the monthly offer it also matches pre-existing docs created
   before `key` existed (they were monthly-only), so they get renamed in place
   instead of duplicated. */
const OFFERS = [
  {
    key: "webinar_monthly",
    match: (phone) => ({ phone, source: "webinar", billingCycle: "monthly", purchased: false }),
    doc: {
      name: "חבילת וובינר חודשי",
      items: { ...CAMPAIGN_ITEMS },
      bullets: [...CAMPAIGN_BULLETS, "🔄 מתחדש כל חודש"],
      basePrice:   _price(897),
      finalPrice:  _price(897),
      coins:       COINS,
      currencyCode: CURRENCY_ILS,
      isSubscription: true,
      billingCycle:   "monthly",
      notes: "חבילת וובינר — מנוי חודשי מתחדש, ₪897 לחודש (מוצג ללקוח $299)",
    },
  },
  {
    key: "webinar_yearly",
    match: (phone) => ({ phone, source: "webinar", billingCycle: "yearly", purchased: false }),
    doc: {
      name: "חבילת וובינר שנתי",
      items: { ...CAMPAIGN_ITEMS, lp: 1 },
      bullets: [...CAMPAIGN_BULLETS, "🖥️ דף נחיתה מתנה", "📞 שיחת אסטרטגיה", "💳 ₪597 לחודש בחיוב שנתי אחד"],
      basePrice:   _price(7164),
      finalPrice:  _price(7164),
      monthlyPrice: _price(597),
      coins:       COINS,
      currencyCode: CURRENCY_ILS,
      isSubscription: true,
      billingCycle:   "yearly",
      notes: "חבילת וובינר שנתי — ₪597×12 בתשלום שנתי אחד, כולל דף נחיתה ושיחת אסטרטגיה (מוצג ללקוח $199/חודש)",
    },
  },
  {
    key: "webinar_landing_page",
    match: (phone) => ({ phone, source: "webinar", key: "webinar_landing_page", purchased: false }),
    doc: {
      name: "חבילת דף נחיתה",
      items: { lp: 1 },
      bullets: ["🖥️ דף נחיתה מעוצב ומותאם אישית"],
      basePrice:   _price(447),
      finalPrice:  _price(447),
      coins:       0,
      currencyCode: CURRENCY_ILS,
      isSubscription: false,
      /* ₪447 is the FINAL charge (shown to the client as $149) — VAT included,
         charge flows must not add 18% on top */
      priceIncludesVat: true,
      notes: "דף נחיתה בלבד — תשלום חד-פעמי 447 ₪ כולל מע\"מ (מוצג ללקוח $149)",
    },
  },
  {
    /* Meta business-page setup only — a one-time ₪500 service line-item.
       meta_pages is a fulfillment marker (normalize drops it → no app
       permission), the charge fires the purchase webhook for the manager. */
    key: "webinar_business_page",
    match: (phone) => ({ phone, source: "webinar", key: "webinar_business_page", purchased: false }),
    doc: {
      name: "חבילת פתיחת עמוד עסקי",
      items: { meta_pages: 1 },
      bullets: ["📘 פתיחת עמוד עסקי ב-Meta"],
      basePrice:   _price(147),
      finalPrice:  _price(147),
      coins:       0,
      currencyCode: CURRENCY_ILS,
      isSubscription: false,
      /* ₪147 is the FINAL charge (shown to the client as $49) — VAT included */
      priceIncludesVat: true,
      notes: "פתיחת עמוד עסקי ב-Meta — תשלום חד-פעמי 147 ₪ כולל מע\"מ (מוצג ללקוח $49)",
    },
  },
];

/* Idempotent — one open offer per (phone, offer). A purchased subscription
   hides both subscription offers; a purchased landing-page offer hides only
   the landing-page offer (a monthly subscriber may still buy an LP). */
async function createWebinarOffers(phone, agent){
  const db = getDB();
  const agentId   = agent?._id ? String(agent._id) : null;
  const agentName = (agent?.nickname || agent?.name || "webinar").replace(/"/g, "");

  const purchased = await db.collection("personal_packages")
    .find({ phone, source: "webinar", purchased: true },
          { projection: { key: 1, isSubscription: 1 } })
    .toArray();
  /* Subscriptions are mutually exclusive — a purchased monthly/yearly sub
     hides both subscription offers. One-time offers hide only themselves,
     matched by key (so buying the landing page no longer hides the annual
     one-time or business-page offers). */
  const hasSub        = purchased.some(p => p.isSubscription);
  const purchasedKeys = new Set(purchased.map(p => p.key).filter(Boolean));

  const result = { created: [], skipped: [] };
  for (const offer of OFFERS){
    const isSub = offer.doc.isSubscription === true;
    const alreadyOwned = isSub ? hasSub : purchasedKeys.has(offer.key);
    if (alreadyOwned) {
      result.skipped.push(offer.key);
      continue;
    }
    await db.collection("personal_packages").updateOne(
      offer.match(phone),
      {
        $set: {
          phone,
          agentId:  agentId || null,
          agentName: agentName || "webinar",
          key: offer.key,
          discountPct: 0,
          active: true,
          purchased: false,
          source: "webinar",
          updatedAt: new Date(),
          ...offer.doc,
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    result.created.push(offer.key);
  }
  return result;
}

/* Backward-compat alias (old callers created just the monthly offer). */
const createWebinarOffer = createWebinarOffers;

/* Called from the purchase-verify path once the first charge succeeded AND a
   card token was saved on the user. Records the recurring subscription.
   billingCycle comes from the package: "yearly" → next charge in 12 months
   with a monthly coin top-up in between; anything else → monthly. */
async function recordSubscription({ phone, personalPackageId, pkg, token, cardExpiry, last4 }){
  const db = getDB();
  const now = new Date();
  const billingCycle = pkg?.billingCycle === "yearly" ? "yearly" : "monthly";
  const cycleMonths  = billingCycle === "yearly" ? 12 : 1;
  await db.collection("subscriptions").updateOne(
    { phone, source: "webinar" },
    {
      $set: {
        phone,
        personalPackageId: personalPackageId ? String(personalPackageId) : null,
        packageName: pkg?.name || PKG_NAME,
        source: "webinar",
        token: token || null,
        cardExpiry: cardExpiry || null,
        last4: last4 || null,
        amount: pkg?.finalPrice ?? PRICE_USD,
        currency: pkg?.currencyCode ?? CURRENCY_USD,
        coins: pkg?.coins ?? COINS,
        items: pkg?.items || { campaign_leads: 1, campaign_traffic: 1, social_ad: 1 },
        billingCycle,
        /* yearly: coins are granted monthly without a charge (purchase itself
           credited month #1, so the first top-up is a month out) */
        nextCoinsAt: billingCycle === "yearly" ? addMonths(now, 1) : null,
        status: "active",
        startedAt: now,
        lastChargedAt: now,
        nextChargeAt: addMonths(now, cycleMonths),
        failedCharges: 0,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  console.log(`[webinar-sub] recorded active ${billingCycle} subscription for ${phone} (next charge ${addMonths(now,cycleMonths).toISOString().slice(0,10)})`);
}

/* ── renewal sweep ─────────────────────────────────────────────────────
   Charges the saved card token for every due subscription. Tops up coins
   and pushes nextChargeAt forward a cycle (month / year) on success;
   escalates on failure.
   Runs DRY (no charges) unless SUBSCRIPTION_RENEWAL_ENABLED=true.
   Yearly subs also get a monthly coin top-up here — no card involved,
   so it runs live regardless of the flag. */
async function renewDueSubscriptions(){
  const db = getDB();
  const live = RENEWAL_ENABLED();
  const now = new Date();

  /* Monthly coin top-up for yearly subscriptions (already paid upfront). */
  const coinsDue = await db.collection("subscriptions").find({
    status: "active",
    billingCycle: "yearly",
    nextCoinsAt: { $lte: now },
  }).limit(200).toArray();
  for (const sub of coinsDue){
    try {
      const coins = sub.coins || COINS;
      await db.collection("users").updateOne(
        { phone: sub.phone },
        { $inc: { coins } },
      );
      await db.collection("subscriptions").updateOne(
        { _id: sub._id },
        { $set: { nextCoinsAt: addMonths(now, 1), updatedAt: now } },
      );
      console.log(`[webinar-sub] 🪙 yearly top-up ${sub.phone} (+${coins} coins)`);
    } catch (err){
      console.warn(`[webinar-sub] coin top-up failed ${sub.phone}: ${err.message}`);
    }
  }

  const due = await db.collection("subscriptions").find({
    status: "active",
    source: { $ne: "tier" }, // tier subs are handled by tier-subscription.service
    nextChargeAt: { $lte: now },
  }).limit(200).toArray();

  if (due.length === 0) return { charged: 0, coinTopUps: coinsDue.length, dry: !live };

  console.log(`[webinar-sub] ${due.length} subscription(s) due · mode=${live ? "LIVE" : "DRY-RUN"}`);
  let charged = 0, failed = 0;
  const cardcom = require("./cardcom.service");

  for (const sub of due){
    if (!live){
      console.log(`[webinar-sub][DRY] would charge ${sub.phone} ${sub.amount} (cur ${sub.currency}) via token …${sub.last4 || "?"}`);
      continue;
    }
    try {
      if (!sub.token) throw new Error("no saved token");
      const result = await cardcom.chargeSavedToken({
        token:      sub.token,
        cardExpiry: sub.cardExpiry,
        amount:     sub.amount,
        currency:   sub.currency,
        phone:      sub.phone,
        productName: sub.packageName,
      });
      if (!result || result.success === false) throw new Error(result?.error || "charge failed");

      const cycleMonths = sub.billingCycle === "yearly" ? 12 : 1;
      await db.collection("users").updateOne(
        { phone: sub.phone },
        { $inc: { coins: sub.coins || COINS } },
      );
      await db.collection("subscriptions").updateOne(
        { _id: sub._id },
        { $set: {
            lastChargedAt: now,
            nextChargeAt: addMonths(now, cycleMonths),
            /* restart the monthly coin cadence from this charge */
            ...(sub.billingCycle === "yearly" ? { nextCoinsAt: addMonths(now, 1) } : {}),
            failedCharges: 0,
            updatedAt: now,
        } },
      );
      console.log(`[webinar-sub] ✅ renewed ${sub.phone} (${sub.billingCycle || "monthly"}, +${sub.coins} coins)`);
      charged++;
    } catch (err){
      const fails = (sub.failedCharges || 0) + 1;
      const giveUp = fails >= 3;
      await db.collection("subscriptions").updateOne(
        { _id: sub._id },
        { $set: {
            failedCharges: fails,
            lastError: err.message,
            status: giveUp ? "past_due" : "active",
            /* still active → retry in 24h; gave up → leave nextChargeAt as-is */
            nextChargeAt: giveUp ? sub.nextChargeAt : new Date(now.getTime() + 24 * 3600e3),
            updatedAt: now,
        } },
      );
      console.warn(`[webinar-sub] ❌ charge failed ${sub.phone} (${fails}/3): ${err.message}`);
      failed++;
    }
  }
  return { charged, failed, coinTopUps: coinsDue.length, dry: !live };
}

let _timer = null;
function startRenewalWatchdog(intervalMs = 6 * 3600e3){
  if (_timer) return;
  _timer = setInterval(() => { renewDueSubscriptions().catch(e => console.error("[webinar-sub] sweep:", e.message)); }, intervalMs);
  if (_timer.unref) _timer.unref();
  console.log(`[webinar-sub] renewal watchdog started (every ${Math.round(intervalMs/3600e3)}h · ${RENEWAL_ENABLED() ? "LIVE" : "DRY-RUN"})`);
}

module.exports = {
  PKG_KEY, PKG_NAME, PRICE_USD, COINS, CURRENCY_USD,
  createWebinarOffer,
  createWebinarOffers,
  recordSubscription,
  renewDueSubscriptions,
  startRenewalWatchdog,
};
