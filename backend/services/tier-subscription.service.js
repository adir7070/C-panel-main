/**
 * tier-subscription.service.js
 *
 * The app's subscription model: three monthly recurring tiers that grant FULL
 * app access. Coins are a HIDDEN backend usage-control quota — the client never
 * sees them; every AI/creation action still debits coins behind the scenes so
 * we can cap how much a client generates. On each monthly cycle the quota
 * RESETS (coins = quota, coinsUsed = 0) — it does NOT accumulate.
 *
 *   REGULAR  ₪149/mo  → 2,000 coins
 *   PRO      ₪249/mo  → 4,000 coins
 *   VIP      ₪549/mo  → 6,000 coins
 *
 * Reuses the shared `subscriptions` collection + Cardcom saved-token charging
 * (same machinery as webinar-subscription.service). Two charge modes:
 *   • "paid" — renewal charges the saved card token each month, then resets coins.
 *   • "free" — grandfathered clients: monthly coin RESET with NO card charge,
 *              ever. Their refresh runs even while live billing is in DRY-RUN.
 *
 * The editable source of truth for prices/coins is the `subscription_plans`
 * collection (operator UI); TIER_DEFS below is the seed + fallback.
 */
const { getDB } = require("../config/db");

const RENEWAL_ENABLED = () =>
  String(process.env.SUBSCRIPTION_RENEWAL_ENABLED || "").toLowerCase() === "true";

const CURRENCY_ILS = 1; // Cardcom ISOCoinId: 1 = ILS

/* Canonical tier definitions — seeds subscription_plans and is the fallback if
   the DB row is missing. `coins` is the monthly quota that RESETS each cycle. */
const TIER_DEFS = {
  REGULAR: { tier: "REGULAR", name: "REGULAR", monthlyPrice: 149, coins: 2000, sortOrder: 1, color: "#0095ff" },
  // PRO first-month intro promo: ₪49 the first month, then the regular ₪249/mo.
  // The intro affects ONLY the first charge; the stored recurring amount stays
  // monthlyPrice so renewals bill full price. One-time per client (introUsedTiers).
  PRO:     { tier: "PRO",     name: "PRO",     monthlyPrice: 249, coins: 4000, sortOrder: 2, color: "#7c3aed", introPrice: 49, introMonths: 1, introEnabled: true },
  VIP:     { tier: "VIP",     name: "VIP",     monthlyPrice: 549, coins: 6000, sortOrder: 3, color: "#f59e0b" },
};

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/* Resolve a tier's price/coins, preferring the editable DB row and falling back
   to TIER_DEFS. Returns null for an unknown tier. */
async function getTierDef(tier) {
  const key = String(tier || "").toUpperCase();
  const fallback = TIER_DEFS[key] || null;
  try {
    const plan = await getDB().collection("subscription_plans").findOne({ tier: key });
    if (plan) {
      // Intro promo (editable per-plan in CPANEL): first-charge price for a set
      // number of months, then the regular monthlyPrice on renewal.
      const introEnabled = plan.introEnabled !== undefined ? Boolean(plan.introEnabled) : !!(fallback?.introEnabled);
      const introPrice = Number(plan.introPrice) || fallback?.introPrice || 0;
      const introMonths = Number(plan.introMonths) || fallback?.introMonths || 1;
      return {
        tier: key,
        name: plan.name || fallback?.name || key,
        monthlyPrice: Number(plan.monthlyPrice) || fallback?.monthlyPrice || 0,
        coins: Number(plan.coinsIncluded) || fallback?.coins || 0,
        color: plan.color || fallback?.color || "#0095ff",
        introEnabled: introEnabled && introPrice > 0,
        introPrice,
        introMonths,
      };
    }
  } catch (_) { /* DB not ready — use fallback */ }
  if (fallback) {
    return {
      ...fallback,
      introEnabled: !!fallback.introEnabled && (fallback.introPrice || 0) > 0,
      introPrice: fallback.introPrice || 0,
      introMonths: fallback.introMonths || 1,
    };
  }
  return fallback;
}

/* Has this client already consumed the intro promo for a given tier? The intro
   is one-time per client so a re-subscribe doesn't get the promo price again. */
async function hasUsedIntro(phone, tier) {
  if (!phone) return false;
  const key = String(tier || "").toUpperCase();
  const sub = await getDB().collection("subscriptions").findOne(
    { phone, source: "tier" },
    { projection: { introUsedTiers: 1 } },
  );
  return Array.isArray(sub?.introUsedTiers) && sub.introUsedTiers.includes(key);
}

/* RESET the monthly quota (never accumulate): coins = quota, coinsUsed = 0.
   Handles BOTH accounting conventions in the codebase (coins-direct and
   coinsRemaining = coins − coinsUsed) — after a reset both read `quota`. */
async function resetCoins(phone, coins, reason) {
  const db = getDB();
  await db.collection("users").updateOne(
    { phone },
    {
      $set: { coins, coinsUsed: 0, updatedAt: new Date() },
      $setOnInsert: { phone, createdAt: new Date() },
    },
    { upsert: true },
  );
  await db.collection("coin_transactions").insertOne({
    phone,
    type: "reset",
    amount: coins,
    reason: reason || "subscription_cycle",
    balance_after: coins,
    created_at: new Date(),
  });
}

/**
 * Activate (or update) a tier subscription for a phone and grant the initial
 * monthly quota immediately (RESET).
 *   chargeMode "paid" → the renewal sweep charges the saved card each month.
 *   chargeMode "free" → grandfathered: monthly RESET, no charge, ever.
 */
async function activateTierSubscription({ phone, tier, chargeMode = "paid", token = null, cardExpiry = null, last4 = null, introApplied = false }) {
  if (!phone) throw new Error("phone is required");
  const db = getDB();
  const def = await getTierDef(tier);
  if (!def) throw new Error(`unknown tier: ${tier}`);
  const now = new Date();
  const isFree = chargeMode === "free";
  // When an intro promo was applied, hold off the first FULL-price renewal until
  // the intro period ends (introMonths); otherwise the standard 1-month cycle.
  const cycleMonths = introApplied ? (def.introMonths || 1) : 1;

  const update = {
    $set: {
      phone,
      source: "tier",
      tier: def.tier,
      packageName: def.name,
      token: isFree ? null : token,
      cardExpiry: isFree ? null : cardExpiry,
      last4: isFree ? null : last4,
      amount: isFree ? 0 : def.monthlyPrice, // ALWAYS the recurring price — renewals bill full, even after an intro charge
      currency: CURRENCY_ILS,
      coins: def.coins,
      coinMode: "reset",
      chargeMode: isFree ? "free" : "paid",
      billingCycle: "monthly",
      status: "active",
      startedAt: now,
      lastChargedAt: now,
      nextChargeAt: addMonths(now, cycleMonths),
      failedCharges: 0,
      updatedAt: now,
    },
    $setOnInsert: { createdAt: now },
  };
  // Record intro consumption so a later re-subscribe doesn't get the promo again.
  if (introApplied) update.$addToSet = { introUsedTiers: def.tier };

  await db.collection("subscriptions").updateOne({ phone, source: "tier" }, update, { upsert: true });
  if (def.coins > 0) await resetCoins(phone, def.coins, "subscription_start");
  const priceNote = isFree ? "FREE grandfathered"
    : introApplied ? `₪${def.introPrice} intro (then ₪${def.monthlyPrice}/mo)`
    : "₪" + def.monthlyPrice + "/mo";
  console.log(`[tier-sub] activated ${def.tier} for ${phone} (${priceNote}, ${def.coins} coins)`);
  return def;
}

/* Ensure the 3 tier offers exist as personal_packages for a phone, so they show
   in the CPANEL personal catalog (getPersonalCatalog) and the app's personal
   packages as purchasable/upgradeable monthly subscriptions. Idempotent — never
   un-purchases an offer already bought (purchased is only set on insert). */
async function ensureTierOffers(phone) {
  if (!phone) return;
  const db = getDB();
  for (const key of ["REGULAR", "PRO", "VIP"]) {
    const def = await getTierDef(key);
    if (!def || !(def.monthlyPrice > 0)) continue;
    await db.collection("personal_packages").updateOne(
      { phone, source: "tier", tier: def.tier },
      {
        $set: {
          phone,
          source: "tier",
          tier: def.tier,
          name: `מנוי ${def.name}`,
          items: {},
          bullets: [
            "✅ גישה מלאה לכל האפליקציה",
            "🎨 יצירת מודעות, תמונות וקמפיינים ללא הגבלת פיצ'רים",
            "🔄 מתחדש כל חודש",
          ],
          basePrice: def.monthlyPrice,
          finalPrice: def.monthlyPrice,
          monthlyPrice: def.monthlyPrice,
          discountPct: 0,
          coins: def.coins,
          // First-month intro promo (e.g. PRO ₪49 first month, then ₪249/mo)
          introEnabled: !!def.introEnabled,
          introPrice: def.introEnabled ? def.introPrice : 0,
          introMonths: def.introEnabled ? def.introMonths : 0,
          currencyCode: 1, // ILS
          isSubscription: true,
          billingCycle: "monthly",
          priceIncludesVat: true, // tier prices are final — no VAT on top
          active: true,
          updatedAt: new Date(),
        },
        $setOnInsert: { purchased: false, purchasedAt: null, createdAt: new Date() },
      },
      { upsert: true },
    );
  }
}

/* The access gate's source of truth: any ACTIVE subscription (tier or legacy
   webinar) means full app access. status "past_due"/"cancelled" → not active. */
async function getActiveSubscription(phone) {
  if (!phone) return null;
  return getDB().collection("subscriptions").findOne({ phone, status: "active" });
}
async function hasActiveSubscription(phone) {
  return !!(await getActiveSubscription(phone));
}

/**
 * Monthly sweep for TIER subscriptions (source: "tier" only — webinar subs are
 * handled by webinar-subscription.service).
 *   free  → RESET coins + advance; runs even in DRY-RUN (no card involved).
 *   paid  → charge saved token (LIVE only), then RESET coins + advance.
 * 3 consecutive failed charges → status "past_due" (access revoked → read-only).
 */
async function renewTierSubscriptions() {
  const db = getDB();
  const live = RENEWAL_ENABLED();
  const now = new Date();

  const due = await db.collection("subscriptions").find({
    source: "tier",
    status: "active",
    nextChargeAt: { $lte: now },
  }).limit(500).toArray();

  if (due.length === 0) return { refreshed: 0, charged: 0, dry: !live };

  console.log(`[tier-sub] ${due.length} tier subscription(s) due · mode=${live ? "LIVE" : "DRY-RUN"}`);
  let refreshed = 0, charged = 0, failed = 0;
  const cardcom = require("./cardcom.service");

  for (const sub of due) {
    const isFree = sub.chargeMode === "free" || !(sub.amount > 0);
    try {
      if (!isFree) {
        if (!live) {
          console.log(`[tier-sub][DRY] would charge ${sub.phone} ₪${sub.amount} via token …${sub.last4 || "?"}`);
          continue; // don't refresh a paid sub we didn't actually charge
        }
        if (!sub.token) throw new Error("no saved token");
        const result = await cardcom.chargeSavedToken({
          token:      sub.token,
          cardExpiry: sub.cardExpiry,
          amount:     sub.amount,
          currency:   sub.currency || CURRENCY_ILS,
          phone:      sub.phone,
          productName: sub.packageName,
        });
        if (!result || result.success === false) throw new Error(result?.error || "charge failed");
        charged++;
      }

      // RESET the monthly quota (both free + paid).
      const coins = sub.coins || TIER_DEFS[sub.tier]?.coins || 0;
      if (coins > 0) await resetCoins(sub.phone, coins, "subscription_cycle");
      await db.collection("subscriptions").updateOne(
        { _id: sub._id },
        { $set: {
            lastChargedAt: isFree ? (sub.lastChargedAt || now) : now,
            nextChargeAt: addMonths(now, 1),
            failedCharges: 0,
            updatedAt: now,
        } },
      );
      refreshed++;
      console.log(`[tier-sub] 🔄 ${isFree ? "refreshed(free)" : "renewed(paid)"} ${sub.phone} ${sub.tier} (reset ${coins} coins)`);
    } catch (err) {
      const fails = (sub.failedCharges || 0) + 1;
      const giveUp = fails >= 3;
      await db.collection("subscriptions").updateOne(
        { _id: sub._id },
        { $set: {
            failedCharges: fails,
            lastError: err.message,
            status: giveUp ? "past_due" : "active",
            nextChargeAt: giveUp ? sub.nextChargeAt : new Date(now.getTime() + 24 * 3600e3),
            updatedAt: now,
        } },
      );
      console.warn(`[tier-sub] ❌ charge failed ${sub.phone} (${fails}/3): ${err.message}`);
      failed++;
    }
  }
  return { refreshed, charged, failed, dry: !live };
}

let _timer = null;
function startTierRenewalWatchdog(intervalMs = 6 * 3600e3) {
  if (_timer) return;
  _timer = setInterval(() => {
    renewTierSubscriptions().catch((e) => console.error("[tier-sub] sweep:", e.message));
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  console.log(`[tier-sub] renewal watchdog started (every ${Math.round(intervalMs / 3600e3)}h · ${RENEWAL_ENABLED() ? "LIVE" : "DRY-RUN"})`);
}

module.exports = {
  TIER_DEFS,
  getTierDef,
  hasUsedIntro,
  resetCoins,
  activateTierSubscription,
  ensureTierOffers,
  getActiveSubscription,
  hasActiveSubscription,
  renewTierSubscriptions,
  startTierRenewalWatchdog,
};
