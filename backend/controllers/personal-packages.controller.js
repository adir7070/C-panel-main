/**
 * personal-packages.controller.js
 *
 * C-panel CRUD for per-client personal packages (agents only).
 * Mobile purchase flow is in packages.controller.js.
 *
 * Routes (all under /api/cpanel/clients/:phone — ownership gate applied):
 *   GET    /personal-catalog            → list active packages for client
 *   POST   /personal-catalog            → create
 *   PATCH  /personal-catalog/:id        → update (only if not purchased)
 *   DELETE /personal-catalog/:id        → soft-delete (active=false)
 *
 * Charge routes (registered before auth gate — Cardcom calls them directly):
 *   POST   /clients/:phone/personal-catalog/:id/charge-iframe  → chargePersonalIframe
 *   POST   /payment-confirm-personal                           → paymentConfirm (webhook)
 */

const axios = require("axios");
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const cardcomConfig = require("../config/cardcom.config");
const { createReceipt } = require("../utils/create-receipt");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { normalizePackageItems } = require("./cpanel.controller");

const USERS_COL  = "users";
const TRANS_COL  = "package_transactions";
const PENDING_COL = "cpanel_pending_purchases";

function withVAT(amount) {
  return Math.round(Number(amount) * 1.18);
}

/**
 * Expand bundle items (kind: "social" or "prebuilt") into their underlying
 * base-item counts. A personal package can contain bundle keys like
 * "social_pro" or "platinum" — but the customer's account is tracked in
 * base items only (ad, lp, video, social_ad, …), and ProductsTab renders
 * from those base counts. If the bundle keys reach normalizePackageItems
 * unexpanded, that function silently drops them (it whitelists 7 base
 * keys), so the social tier just disappears post-purchase.
 *
 * Strategy:
 * - Look up each key in cpanel_products
 * - kind === "social" | "prebuilt" → multiply the bundle's own .items map
 *   by the purchase count and merge into the output
 * - kind === "item" or unknown → pass through unchanged (normalize will
 *   handle base-key aliasing like ad → paidAds itself)
 *
 * Coins note: we deliberately do NOT credit bundle.coins here. That field
 * represents the standalone purchase cost of the bundle (e.g. social_pro
 * = 1000 coins debit when bought directly). The customer already paid
 * via the personal package's finalPrice — charging coins again would
 * double-bill.
 */
/* ── Catalog item inference ───────────────────────────────────────────
   Maps a product KEY to its base items map when the product carries no
   `items` map of its own. SINGLE SOURCE OF TRUTH shared by expandBundles
   (purchase-time, inline) and the inferCatalogBundles admin backfill
   (which writes these maps onto the product docs). Without the inline
   fallback, a product whose items map was never backfilled (e.g.
   ad_lead_10, ad_10) passes through expandBundles raw and is then dropped
   by normalizePackageItems — producing an empty package. */
const INFER_BASE_ITEMS = new Set(["ad", "social_ad", "lp", "video", "logo", "domain"]);
const INFER_KEY_PATTERN = /^([a-z_]+?)_(\d+)$/;
const INFER_EXPLICIT = {
  lead_cmp: { campaign_leads:   1 },
  web_cmp:  { campaign_traffic: 1 },
};
/* Compound bundles like "ad_lead_10" — N paid ads bundled with a single
   campaign slot. base → fn(count) → full items map. */
const INFER_COMPOUND = {
  ad_lead: n => ({ ad: n, campaign_leads:   1 }),
  ad_web:  n => ({ ad: n, campaign_traffic: 1 }),
};

function inferItemsFromKey(key) {
  if (!key) return null;
  if (INFER_EXPLICIT[key]) return { ...INFER_EXPLICIT[key] };
  const m = INFER_KEY_PATTERN.exec(key);
  if (!m) return null;
  const base = m[1];
  const n = parseInt(m[2], 10);
  if (INFER_BASE_ITEMS.has(base)) return { [base]: n };
  if (INFER_COMPOUND[base]) return INFER_COMPOUND[base](n);
  return null;
}

async function expandBundles(items) {
  const raw = items || {};
  const keys = Object.keys(raw).filter(k => Number(raw[k]) > 0);
  if (keys.length === 0) return {};
  const products = await getDB().collection("cpanel_products")
    .find({ key: { $in: keys } })
    .toArray();
  const byKey = new Map(products.map(p => [p.key, p]));
  const out = {};
  for (const k of keys) {
    const count = Number(raw[k]) || 0;
    const prod = byKey.get(k);

    /* "גישה" (access) products grant a capability only — per product spec
       they must NOT open anything in the CPANEL products tab (no ad panel,
       no quota). Several access products were mis-configured with an items
       map that expands into campaign_leads / campaign_traffic, so each one
       spawned an extra 10-ad panel (e.g. buying "קמפיין לידים" + the access
       line items produced 3 panels / 30 ads instead of 1). There's no
       access flag on the product doc, so we match the label: the canonical
       campaign products are labelled "קמפיין …", access products "גישת …".
       Skip access products entirely so only real products reach the map. */
    const label = String(prod?.label || prod?.name || "").trim();
    if (label.startsWith("גישה") || label.startsWith("גישת")) continue;

    /* Any product with a non-empty items map is treated as a bundle —
       regardless of kind. Some admin-created items (kind:"item") were
       set up with an items map after the fact so they expand at
       purchase but still show up in the personal-package builder UI
       (which filters by kind:"item"). */
    if (prod?.items && Object.keys(prod.items).length > 0) {
      for (const [innerKey, innerCount] of Object.entries(prod.items)) {
        const n = Number(innerCount) || 0;
        if (n > 0) out[innerKey] = (out[innerKey] || 0) + (n * count);
      }
      continue;
    }

    /* No DB items map — fall back to key-based inference so a product whose
       items map was never backfilled (ad_lead_10, ad_10, …) still expands
       instead of silently dropping to an empty package (normalizePackageItems
       only recognizes base keys, not ad_lead_10 / lead_cmp / …). */
    const inferred = inferItemsFromKey(k);
    if (inferred) {
      for (const [innerKey, innerCount] of Object.entries(inferred)) {
        const n = Number(innerCount) || 0;
        if (n > 0) out[innerKey] = (out[innerKey] || 0) + (n * count);
      }
      continue;
    }

    out[k] = (out[k] || 0) + count;
  }
  return out;
}

function normalizeCardcomPayload(body) {
  const root = Array.isArray(body) ? body[0] : body;
  if (!root || typeof root !== "object") return {};
  const LowProfileId = root.LowProfileId || root.lowProfileId || null;
  const Token =
    root.Token ||
    (root.TokenInfo       && root.TokenInfo.Token) ||
    (root.TranzactionInfo && root.TranzactionInfo.Token) ||
    null;
  const last4Raw =
    root.Last4Digits ||
    root.Last4CardDigits ||
    (root.TranzactionInfo && (root.TranzactionInfo.Last4CardDigitsString ||
                              root.TranzactionInfo.Last4CardDigits)) ||
    null;
  const Last4Digits = last4Raw != null ? String(last4Raw) : null;
  let ExpDate = root.ExpDate || null;
  if (!ExpDate && root.TokenInfo && root.TokenInfo.TokenExDate) {
    const t = String(root.TokenInfo.TokenExDate);
    ExpDate = t.length === 8 ? t.slice(4, 6) + t.slice(2, 4) : t;
  }
  return { LowProfileId, Token, Last4Digits, ExpDate };
}

const COL = () => getDB().collection("personal_packages");

/* ── helpers ──────────────────────────────────────────────────────────── */

function maxDiscountForAgent(agent) {
  const phone = String(agent?.phone || "").replace(/\D/g, "");
  if (agent?.name === "admin-boss") return 100;
  if (phone.endsWith("542587070")) return 100;
  if (agent?.role === "admin") return 100;
  return 20;
}

function computeFinalPrice(basePrice, discountPct, maxDiscount = 20) {
  const pct = Math.min(maxDiscount, Math.max(0, Number(discountPct) || 0));
  return Math.round(Number(basePrice) * (1 - pct / 100));
}

function validateDraft(body, maxDiscount = 20) {
  const { name, items, basePrice, discountPct, finalPrice, coins } = body;
  if (!name || !String(name).trim()) return "name is required";
  if (typeof items !== "object" || Array.isArray(items)) return "items must be an object";
  if ((discountPct ?? 0) > maxDiscount) return `discountPct cannot exceed ${maxDiscount}`;
  return null;
}

/* ── GET /api/cpanel/clients/:phone/personal-catalog ──────────────────── */
exports.list = async (req, res) => {
  try {
    const { phone } = req.params;
    // Make sure the 3 subscription tiers (REGULAR/PRO/VIP) are present in this
    // client's personal catalog (idempotent). Non-fatal if it fails.
    try {
      await require("../services/tier-subscription.service").ensureTierOffers(phone);
    } catch (e) {
      console.warn("[PersonalPackages] ensureTierOffers:", e.message);
    }
    const pkgs = await COL()
      .find({ phone, active: true })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(pkgs);
  } catch (err) {
    console.error("[PersonalPackages] list:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/clients/:phone/personal-catalog ─────────────────── */
exports.create = async (req, res) => {
  try {
    const { phone } = req.params;
    const agentId = req.agent._id;
    const maxDiscount = maxDiscountForAgent(req.agent);

    const err = validateDraft(req.body, maxDiscount);
    if (err) return res.status(400).json({ error: err });

    const { name, items, bullets, basePrice, discountPct, coins, notes, active } = req.body;
    const finalPrice = computeFinalPrice(basePrice, discountPct, maxDiscount);

    const doc = {
      phone,
      agentId,
      name: String(name).trim(),
      items: items || {},
      bullets: Array.isArray(bullets) ? bullets.map(String) : [],
      basePrice:   Number(basePrice)   || 0,
      discountPct: Math.min(maxDiscount, Math.max(0, Number(discountPct) || 0)),
      finalPrice,
      coins:       Number(coins)       || 0,
      currencyCode: 1,
      notes:       String(notes || "").trim(),
      active:      active !== false,
      purchased:   false,
      purchasedAt: null,
      createdAt:   new Date(),
      updatedAt:   new Date(),
    };

    const result = await COL().insertOne(doc);
    res.status(201).json({ ...doc, _id: result.insertedId });
  } catch (err) {
    console.error("[PersonalPackages] create:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── PATCH /api/cpanel/clients/:phone/personal-catalog/:id ────────────── */
exports.update = async (req, res) => {
  try {
    const { phone, id } = req.params;
    const maxDiscount = maxDiscountForAgent(req.agent);
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });

    const existing = await COL().findOne({ _id: new ObjectId(id), phone });
    if (!existing) return res.status(404).json({ error: "not found" });
    if (existing.purchased) return res.status(409).json({ error: "cannot edit a purchased package" });
    /* Webinar-service offers carry special pricing (USD, priceIncludesVat) —
       this endpoint recomputes finalPrice from ILS catalog items and would
       corrupt them (e.g. the USD $2,880 one-time offer). They are managed
       automatically by webinar-subscription.service, not hand-edited. */
    if (existing.isSubscription || existing.source === "webinar") {
      return res.status(409).json({ error: "חבילה מנוהלת אוטומטית — לא ניתנת לעריכה ידנית" });
    }

    const err = validateDraft({ ...existing, ...req.body }, maxDiscount);
    if (err) return res.status(400).json({ error: err });

    const { name, items, bullets, basePrice, discountPct, coins, notes, active } = { ...existing, ...req.body };
    const finalPrice = computeFinalPrice(basePrice, discountPct, maxDiscount);

    const $set = {
      name:        String(name).trim(),
      items:       items || {},
      bullets:     Array.isArray(bullets) ? bullets.map(String) : [],
      basePrice:   Number(basePrice)   || 0,
      discountPct: Math.min(maxDiscount, Math.max(0, Number(discountPct) || 0)),
      finalPrice,
      coins:       Number(coins)       || 0,
      notes:       String(notes || "").trim(),
      active:      active !== false,
      updatedAt:   new Date(),
    };

    await COL().updateOne({ _id: new ObjectId(id) }, { $set });
    res.json({ success: true, _id: id, ...$set });
  } catch (err) {
    console.error("[PersonalPackages] update:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── DELETE /api/cpanel/clients/:phone/personal-catalog/:id ───────────── */
exports.remove = async (req, res) => {
  try {
    const { phone, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });

    const existing = await COL().findOne({ _id: new ObjectId(id), phone });
    if (!existing) return res.status(404).json({ error: "not found" });

    await COL().updateOne(
      { _id: new ObjectId(id) },
      { $set: { active: false, updatedAt: new Date() } },
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[PersonalPackages] remove:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/clients/:phone/personal-catalog/:id/charge-iframe ── */
exports.chargePersonalIframe = async (req, res) => {
  try {
    const { phone, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });

    const pkg = await COL().findOne({ _id: new ObjectId(id), phone, active: true, purchased: false });
    if (!pkg) return res.status(404).json({ error: "חבילה אישית לא נמצאה או כבר נרכשה" });

    /* No fallback host — the old Iconiq servers are gone, and a silent
       fallback would send Cardcom's webhook and redirect nowhere. */
    const serverBaseUrl = (process.env.SERVER_BASE_URL || "").replace(/\/+$/, "");
    const cpanelBaseUrl = (process.env.CPANEL_BASE_URL || "").replace(/\/+$/, "");
    if (!serverBaseUrl || !cpanelBaseUrl) {
      return res.status(500).json({ error: "SERVER_BASE_URL / CPANEL_BASE_URL לא מוגדרים בשרת" });
    }

    /* Subscription packages (חבילת וובינר): charge the exact price — a
       "$300/mo" plan bills exactly $300 — in the package currency, and
       tokenize the card so the renewal job can charge next cycle. Mirrors
       the mobile flow in packages.controller.js (purchasePersonalIframe).
       priceIncludesVat (חבילת דף נחיתה): ₪2,000 is final — no VAT on top. */
    const isSub = pkg.isSubscription === true;
    const amountWithVat = (isSub || pkg.priceIncludesVat === true)
      ? pkg.finalPrice
      : withVAT(pkg.finalPrice);
    const user = await getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } });
    const clientName = user?.name || phone;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         amountWithVat,
      /* charge in the package currency (2=USD, 1=ILS) for one-time packages
         too — a USD one-time offer must not be billed in shekels */
      ISOCoinId:      pkg.currencyCode ?? 1,
      ProductName:    pkg.name,
      SuccessRedirectUrl: `${cpanelBaseUrl}/clients/${encodeURIComponent(phone)}/personal_catalog?personal_success=${id}`,
      ErrorRedirectUrl:   `${cpanelBaseUrl}/clients/${encodeURIComponent(phone)}/personal_catalog?personal_error=${id}`,
      WebHookUrl: `${serverBaseUrl}/api/cpanel/payment-confirm-personal?phone=${encodeURIComponent(phone)}&id=${id}`,
      ReturnValue:    `${phone}|cpanel_personal|${id}`,
      CreateInvoice:  false,
      IsCreateToken:  isSub ? true : false,
      Operation:      isSub ? 2 : 1,
      IsApplePay:     true,
      /* Bit only supports ILS — enabling it on a USD charge makes Cardcom fail */
      IsBit:          (pkg.currencyCode ?? 1) === 1,
      IsGooglePay:    true,
      CustomerName:   clientName,
      PhoneNumber:    phone,
    };

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, requestBody);
    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl   = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;
    const items        = pkg.items || {};

    if (lowProfileId) {
      await getDB().collection(PENDING_COL).insertOne({
        lowProfileId,
        phone,
        personalPackageId:    id,
        kind:                 "personal",
        packageKey:           `personal_${id}`,
        packageName:          pkg.name,
        description:          pkg.name,
        name:                 pkg.name,
        totalAmount:          pkg.finalPrice,
        amountWithVat,
        coinsOverride:        pkg.coins ?? 0,
        campaignTrafficCount: Number(items.campaign_traffic ?? items.campaignTraffic ?? 0) || 0,
        campaignLeadsCount:   Number(items.campaign_leads   ?? items.campaignLeads   ?? 0) || 0,
        adsCount:             Number(items.paidAds    ?? items.ad        ?? 0) || 0,
        socialAdsCount:       Number(items.organicAds ?? items.social_ad ?? 0) || 0,
        videosCount:          Number(items.videos     ?? items.video     ?? 0) || 0,
        landingPagesCount:    Number(items.lps        ?? items.lp        ?? 0) || 0,
        logosCount:           Number(items.logos      ?? items.logo      ?? 0) || 0,
        saleSiteCount:        Number(items.saleWebsite ?? items.sale_site ?? 0) || 0,
        source:               "cpanel_personal",
        createdAt:            new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[PersonalPackages] chargePersonalIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── Payment finalisation (shared by the webhook and the panel) ───────── */

const purchaseSync = require("../services/purchase-sync.service");
const CARDCOM_LP_RESULT_URL = "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult";

async function fetchLpResult(lowProfileId) {
  const r = await axios.post(CARDCOM_LP_RESULT_URL, {
    TerminalNumber: cardcomConfig.terminal,
    ApiName:        cardcomConfig.apiName,
    ApiPassword:    cardcomConfig.apiPassword,
    LowProfileId:   lowProfileId,
  }, { timeout: 10000 });
  return r.data;
}

/* The panel checks while the client may still be typing their card, so
   require a transaction id on top of ResponseCode 0 before trusting it. */
function lpResultIsPaid(data) {
  if (!data || data.ResponseCode !== 0) return false;
  return Number(data.TranzactionId || data.TranzactionInfo?.TranzactionId || 0) > 0;
}

/* ReturnValues issued with this handler's webhook URL: the catalog charge and
   the older public webinar checkout (packages.controller webinarPayIframe). */
function returnValueMatches(value, phone, id) {
  return !value
    || value === `${phone}|cpanel_personal|${id}`
    || value === `${phone}|webinar_web|${id}`;
}

/* Applies a verified personal-package payment to everything the panel reads,
   in the crash-safe order described in services/purchase-sync.service.js.
   The pending-purchase claim only stops concurrent callers (webhook + panel
   checks) from doing the same work in parallel. */
async function finalizePersonalPurchase({ phone, id, lowProfileId, lpResult, via }) {
  const db  = getDB();
  const now = new Date();
  if (!lowProfileId || !phone || !ObjectId.isValid(id)) return { status: "invalid" };
  // a paid page replayed under another phone/package stops here
  if (!returnValueMatches(lpResult?.ReturnValue, phone, id)) return { status: "mismatch" };
  const pending = await db.collection(PENDING_COL).findOne({ lowProfileId });
  if (pending && (pending.phone !== phone || String(pending.personalPackageId) !== String(id))) {
    return { status: "mismatch" };
  }

  if (await purchaseSync.paymentState(db, lowProfileId) === "done") {
    // already credited — finish the follow-up writes in case they were cut short
    if (pending) await purchaseSync.recordRevenue(db, { lowProfileId, phone });
    await purchaseSync.markLeadsActive(db, phone);
    return { status: "paid", already: true };
  }

  let claimedAt = null;
  if (pending) {
    const staleBefore = new Date(now.getTime() - 2 * 60 * 1000); // claim left by a crashed attempt
    const claim = await db.collection(PENDING_COL).findOneAndUpdate(
      {
        lowProfileId, completedAt: { $exists: false },
        $or: [{ finalizingAt: { $exists: false } }, { finalizingAt: { $lt: staleBefore } }],
      },
      { $set: { finalizingAt: now } },
    );
    // driver v6 returns the doc, v4/v5 wrap it in { value, ok }
    const claimed = claim && "ok" in claim && "value" in claim ? claim.value : claim;
    if (claimed) {
      claimedAt = now;
    } else {
      const cur = await db.collection(PENDING_COL).findOne({ lowProfileId }, { projection: { completedAt: 1 } });
      // not completed → another caller is on it; completed but not "done" → resume below
      if (!cur?.completedAt) return { status: "processing", already: true };
    }
  }

  try {
    const pkg = await COL().findOne({ _id: new ObjectId(id), phone });
    if (!pkg) throw new Error(`personal package ${id} not found for ${phone}`);
    const coinsToCredit = pkg.coins ?? 0;
    const isTier = pkg.source === "tier" && !!pkg.tier;

    const lock = await purchaseSync.lockPayment(db, lowProfileId, {
      phone, personalPackageId: id, packageName: pkg.name, amount: pkg.finalPrice,
      coinsGranted: coinsToCredit, source: "cpanel_personal", via,
    });
    if (lock === "done") return { status: "paid", already: true };

    /* Expand bundle keys (social_pro, social_standard, platinum, …) into
       base items before normalizing. Without this step, normalize drops
       the bundle keys and ProductsTab can't display what the customer
       actually purchased. */
    const expandedItems = await expandBundles(pkg.items || {});
    const packageEntry  = {
      key:         `personal_${id}`,
      name:        pkg.name,
      purchasedAt: now.toISOString(),
      items:       normalizePackageItems(expandedItems),
      coins:       coinsToCredit,
      status:      "waiting_brief",
      lowProfileId,
    };

    /* Subscription packages: Cardcom tokenized the card (Operation 2) —
       save the token on the user and record the recurring subscription so
       the renewal job can charge next cycle. Mirrors verifyPersonalPayment. */
    const tokenInfo   = lpResult?.TokenInfo;
    const txnInfo     = lpResult?.TranzactionInfo;
    const tokenUpdate = {};
    if (tokenInfo?.Token) {
      const month = String(tokenInfo.CardMonth).padStart(2, "0");
      const year  = String(tokenInfo.CardYear).slice(-2);
      tokenUpdate.paymentToken  = tokenInfo.Token;
      tokenUpdate.paymentExpiry = month + year;
      tokenUpdate.paymentLast4  = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
    }

    const credit = {
      $set:  { activePackage: packageEntry, ...tokenUpdate },
      $push: { purchasedPackages: packageEntry },
    };
    // Tier subscriptions RESET coins to the tier quota (done by
    // activateTierSubscription below) — so don't $inc coins here.
    if (!isTier && coinsToCredit > 0) credit.$inc = { coins: coinsToCredit };
    await purchaseSync.creditUserOnce(db, phone, lowProfileId, credit);

    await COL().updateOne(
      { _id: new ObjectId(id), purchased: { $ne: true } },
      { $set: { purchased: true, purchasedAt: now } },
    );

    if (isTier) {
      /* Not swallowed: if activation fails the lock stays "crediting", so the
         next webhook retry / panel check runs it again instead of leaving a
         "רמה" that was never activated. */
      await require("../services/tier-subscription.service").activateTierSubscription({
        phone, tier: pkg.tier, chargeMode: "paid",
        token: tokenUpdate.paymentToken || null,
        cardExpiry: tokenUpdate.paymentExpiry || null,
        last4: tokenUpdate.paymentLast4 || null,
      });
      // the all-clients "רמה" column reads cpanel_clients.tier
      await db.collection("cpanel_clients").updateOne({ phone }, { $set: { tier: pkg.tier } });
    } else if (pkg.isSubscription && tokenUpdate.paymentToken) {
      await require("../services/webinar-subscription.service").recordSubscription({
        phone, personalPackageId: id, pkg,
        token: tokenUpdate.paymentToken,
        cardExpiry: tokenUpdate.paymentExpiry,
        last4: tokenUpdate.paymentLast4,
      });
    }

    if (pending) await purchaseSync.recordRevenue(db, { lowProfileId, phone });
    await purchaseSync.markLeadsActive(db, phone);

    if (await purchaseSync.markPaymentDone(db, lowProfileId)) {
      // receipt
      createReceipt({
        phone, type: "package", description: pkg.name,
        amount: pkg.finalPrice, coinsGranted: coinsToCredit,
        source: "cpanel_personal", lowProfileId,
      }).catch(() => {});

      // notify manager (WhatsApp + SMS + socket cpanel_new_purchase)
      require("../services/wow-manager-notify.service")
        .notifyManagerOfPurchase({
          clientPhone: phone, businessName: null,
          packageName: pkg.name, amount: pkg.finalPrice, coinsGranted: coinsToCredit,
        })
        .catch(e => console.warn("[PersonalPackages] paymentConfirm notifyManager:", e.message));

      // purchase webhook
      Promise.resolve().then(async () => {
        const clientMapping = await getDB().collection("cpanel_clients").findOne(
          { phone }, { projection: { agentId: 1 } },
        );
        const agentDoc = clientMapping?.agentId
          ? await getDB().collection("agents").findOne(
              { _id: clientMapping.agentId },
              { projection: { name: 1, nickname: 1, email: 1, phone: 1 } },
            )
          : null;
        return sendPurchaseWebhook({
          event:     "purchase_success",
          source:    "cpanel_personal",
          timestamp: now.toISOString(),
          client:    { phone, name: null, businessName: null },
          manager: {
            id:    clientMapping?.agentId || null,
            name:  agentDoc?.nickname || agentDoc?.name || null,
            email: agentDoc?.email || null,
            phone: agentDoc?.phone || null,
          },
          package: {
            name:         pkg.name,
            kind:         "personal",
            amount:       pkg.finalPrice,
            coinsGranted: coinsToCredit,
            items:        pkg.items || {},
          },
          payment: { lowProfileId },
        });
      }).catch(e => console.warn("[PersonalPackages] paymentConfirm webhook:", e.message));

      console.log(`[PersonalPackages] ✅ ${via}: ${phone} → ${pkg.name} (+${coinsToCredit} coins)`);
    }
    return { status: "paid", packageName: pkg.name };
  } catch (err) {
    // release only our own claim so the next webhook retry / panel check can resume
    if (claimedAt) {
      await db.collection(PENDING_COL)
        .updateOne({ lowProfileId, finalizingAt: claimedAt }, { $unset: { finalizingAt: "" } })
        .catch(() => {});
    }
    throw err;
  }
}

/* ── POST /api/cpanel/payment-confirm-personal (Cardcom webhook) ──────── */
exports.paymentConfirm = async (req, res) => {
  res.sendStatus(200); // answer Cardcom immediately

  (async () => {
    try {
      const { LowProfileId } = normalizeCardcomPayload(req.body);
      const phone = req.query.phone || null;
      const id    = req.query.id    || null;
      if (!LowProfileId || !phone || !id) return;

      // skip the Cardcom round-trip for a payment that is fully applied
      if (await purchaseSync.paymentState(getDB(), LowProfileId) === "done") return;

      const lpResult = await fetchLpResult(LowProfileId);
      if (!lpResult || lpResult.ResponseCode !== 0) {
        console.warn("[PersonalPackages] paymentConfirm: Cardcom rejected", lpResult?.Description);
        return;
      }
      await finalizePersonalPurchase({ phone, id, lowProfileId: LowProfileId, lpResult, via: "webhook" });
    } catch (err) {
      console.error("[PersonalPackages] paymentConfirm async:", err.message);
    }
  })();
};

/* Checks this client's open Cardcom pages — for one package (`id`) or all of
   them — and applies any that were paid. "Open" means never completed, or
   completed while its lock is still "crediting" (an attempt died after the
   ledger write), which finalize resumes. Newest first, last 48h, at most 20
   Cardcom calls, one failing page doesn't stop the rest. */
async function confirmOpenPages(phone, id) {
  const db = getDB();
  const scope = { phone, ...(id ? { personalPackageId: id } : {}) };

  if (id) {
    // bought already (catalog or contract link) and fully applied → nothing to check.
    // Contract coin add-ons carry the package id too but don't buy the package.
    const completed = await db.collection(PENDING_COL)
      .find({ ...scope, completedAt: { $exists: true }, source: { $ne: "contract_coins" } }, { projection: { lowProfileId: 1 } })
      .toArray();
    for (const row of completed) {
      if (!row.lowProfileId || (await purchaseSync.paymentState(db, row.lowProfileId)) !== "crediting") {
        return { status: "paid", already: true, paid: [id] };
      }
    }
  }

  const since = new Date(Date.now() - 48 * 3600 * 1000);
  const rows = await db.collection(PENDING_COL)
    .find({ ...scope, source: { $nin: ["contract_pay", "contract_coins"] }, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray();

  const paid = [];        // applied by THIS call — the caller announces these
  const handled = new Set();
  let checks = 0;
  for (const row of rows) {
    const pkgId = row.personalPackageId ? String(row.personalPackageId) : null;
    if (!row.lowProfileId || !pkgId || handled.has(pkgId)) continue;
    if (row.completedAt && (await purchaseSync.paymentState(db, row.lowProfileId)) !== "crediting") continue;
    if (++checks > 20) break;
    let lpResult;
    try {
      lpResult = await fetchLpResult(row.lowProfileId);
    } catch (err) {
      console.warn(`[PersonalPackages] GetLpResult ${row.lowProfileId}:`, err.message);
      continue;
    }
    if (!lpResultIsPaid(lpResult)) continue;
    const r = await finalizePersonalPurchase({ phone, id: pkgId, lowProfileId: row.lowProfileId, lpResult, via: "panel" });
    if (r.status === "paid") {
      handled.add(pkgId);
      if (!r.already) paid.push(pkgId); // someone else applied it → they announce it
    }
    if (id) return { ...r, paid };
  }
  if (id) return { status: rows.length ? "pending" : "no_charge", paid };
  return { status: paid.length ? "paid" : "none", paid };
}

/* ── POST /api/cpanel/clients/:phone/personal-catalog/:id/confirm-payment ──
   Panel-side confirmation for one package. Cardcom's webhook can't reach a
   local or firewalled server, so the catalog tab polls this while a charge
   window is open, and the Cardcom return page calls it. Safe to repeat. */
exports.confirmPayment = async (req, res) => {
  try {
    const { phone, id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "invalid id" });
    res.json(await confirmOpenPages(phone, id));
  } catch (err) {
    console.error("[PersonalPackages] confirmPayment:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/clients/:phone/personal-catalog/confirm-open-charges ──
   Same check across every package of the client. The client page calls it on
   load and when the window regains focus, so a payment whose charge window was
   closed — or whose catalog tab the manager left — still lands. */
exports.confirmOpenCharges = async (req, res) => {
  try {
    res.json(await confirmOpenPages(req.params.phone, null));
  } catch (err) {
    console.error("[PersonalPackages] confirmOpenCharges:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/personal-catalog/infer-catalog-bundles ───────────
   Admin-created cpanel_products often use keys like "social_ad_10" or
   "ad_10" meaning "this bundle contains N × <base_item>". They were
   saved as flat catalog items with no `kind` or `items` map, so
   expandBundles can't unfold them and the customer's account ends up
   with all-zero items.

   This endpoint walks the catalog and infers structure:

   1. Keys matching /^(base)_(\d+)$/ where base ∈ known base items →
      kind:"social", items:{ base: N }
   2. Explicit aliases for human-named keys:
        lead_cmp   → { campaign_leads: 1 }
        web_cmp    → { campaign_traffic: 1 }
   3. Anything else: left alone (returned in `skipped` array).

   Only touches products that don't already have a non-empty `items`
   map — protects products the admin explicitly configured. Idempotent.
   Returns { updated, skipped } so caller can verify what changed. */
/* ── POST /api/cpanel/personal-catalog/restore-item-kind ───────────────
   Sister-fix to inferCatalogBundles. The earlier run flipped kind from
   "item" to "social" for admin-created keys like social_ad_10, ad_10,
   lead_cmp, web_cmp — which made them disappear from the personal-
   package builder modal (it lists products of kind:"item" only).

   Now that expandBundles accepts ANY product with a non-empty items
   map regardless of kind, we can safely restore kind:"item" for these
   products. They'll reappear in the builder UI AND continue to expand
   at purchase time. Idempotent — only touches products with a non-
   empty items map. */
exports.restoreItemKind = async (req, res) => {
  try {
    const PRODUCTS = getDB().collection("cpanel_products");
    const candidates = await PRODUCTS.find({
      kind: "social",
      items: { $type: "object" },
    }).toArray();
    const result = [];
    for (const p of candidates) {
      if (!p.items || Object.keys(p.items).length === 0) continue;
      /* Only flip the ones we touched earlier — pattern <base>_<N> or
         explicit alias keys. Leave the original DEFAULT_SOCIAL plans
         (social_standard / social_pro) alone since they're true
         "social-kind" packages with their own UI. */
      const isHandRolled = /^([a-z_]+?)_(\d+)$/.test(p.key)
                        || ["lead_cmp", "web_cmp"].includes(p.key);
      if (!isHandRolled) continue;
      await PRODUCTS.updateOne(
        { _id: p._id },
        { $set: { kind: "item", updatedAt: new Date() } },
      );
      result.push({ key: p.key, name: p.name || p.label });
      console.log(`[restore-item-kind] ${p.key} → kind:"item"`);
    }
    res.json({ ok: true, updatedCount: result.length, updated: result });
  } catch (err) {
    console.error("[restore-item-kind] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

exports.inferCatalogBundles = async (req, res) => {
  try {
    const PRODUCTS = getDB().collection("cpanel_products");
    const products = await PRODUCTS.find({}).toArray();

    const updated = [];
    const skipped = [];

    for (const p of products) {
      if (p.items && Object.keys(p.items).length > 0) continue; // already configured

      /* Same inference expandBundles applies inline at purchase — keeping
         both on inferItemsFromKey means a backfilled catalog and a
         never-backfilled one expand identically. */
      const newItems = inferItemsFromKey(p.key);
      if (!newItems) {
        skipped.push({ key: p.key, name: p.name, label: p.label });
        continue;
      }

      /* Keep kind unchanged — expandBundles matches on the items map alone,
         so the product stays in the personal-package builder UI (which
         filters by kind:"item"). */
      await PRODUCTS.updateOne(
        { _id: p._id },
        { $set: { items: newItems, updatedAt: new Date() } },
      );
      updated.push({ key: p.key, name: p.name || p.label, items: newItems });
      console.log(`[infer-catalog-bundles] ${p.key} items=${JSON.stringify(newItems)}`);
    }

    res.json({ ok: true, updatedCount: updated.length, skippedCount: skipped.length, updated, skipped });
  } catch (err) {
    console.error("[infer-catalog-bundles] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/cpanel/clients/:phone/personal-catalog/diagnose ──────────
   Diagnostic dump of EVERYTHING relevant to a customer's package state.
   Returns raw activePackage from DB (with key/status), all matching
   personal_packages source docs, and a summary of purchasedPackages.
   Use this to figure out why ProductsTab isn't showing what you expect. */
exports.diagnoseClientPackages = async (req, res) => {
  try {
    const phone = req.params.phone || req.query.phone;
    if (!phone) return res.status(400).json({ error: "phone required" });

    const user = await getDB().collection(USERS_COL).findOne(
      { phone },
      { projection: { activePackage: 1, purchasedPackages: 1, coins: 1, coinsUsed: 1 } },
    );
    if (!user) return res.status(404).json({ error: "user not found" });

    /* Pull source personal_packages for every personal_<id> key we find. */
    const collectIds = (entries) =>
      entries
        .filter(e => e?.key?.startsWith("personal_"))
        .map(e => e.key.slice("personal_".length))
        .filter(id => ObjectId.isValid(id))
        .map(id => new ObjectId(id));

    const allEntries = [
      ...(user.activePackage ? [user.activePackage] : []),
      ...(Array.isArray(user.purchasedPackages) ? user.purchasedPackages : []),
    ];
    const ids = collectIds(allEntries);
    const sources = ids.length
      ? await COL().find({ _id: { $in: ids } }).toArray()
      : [];
    const sourceByKey = new Map(sources.map(s => [`personal_${s._id}`, s]));

    const enrich = (entry) => entry && ({
      key:         entry.key,
      name:        entry.name,
      status:      entry.status,
      purchasedAt: entry.purchasedAt,
      items:       entry.items,
      coins:       entry.coins,
      sourceItems: sourceByKey.get(entry.key)?.items ?? null,
      sourceName:  sourceByKey.get(entry.key)?.name  ?? null,
    });

    res.json({
      phone,
      coins:     user.coins ?? 0,
      coinsUsed: user.coinsUsed ?? 0,
      activePackage:     enrich(user.activePackage),
      purchasedPackages: (user.purchasedPackages || []).map(enrich),
    });
  } catch (err) {
    console.error("[diagnose-client-packages] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/cpanel/personal-catalog/repair-active-package ───────────
   One-shot migration for customers who purchased a personal package
   BEFORE the expandBundles fix shipped. Re-reads the source personal
   package by ID, runs bundle-expansion → normalize, and updates BOTH:
     - users.activePackage.items (if it's a personal package)
     - users.purchasedPackages[i].items (for each personal entry in history)

   Body: { phone: "0526761205" }
   Returns: { ok, activeChanged, historyChanged, before, after } so the
   caller can confirm what was fixed. Idempotent — running twice does
   nothing on the second call. */
exports.repairActivePackage = async (req, res) => {
  try {
    const phone = (req.body?.phone || req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });

    const user = await getDB().collection(USERS_COL).findOne(
      { phone },
      { projection: { activePackage: 1, purchasedPackages: 1 } },
    );
    if (!user) return res.status(404).json({ error: "user not found" });

    const report = { ok: true, activeChanged: false, historyChanged: 0, entries: [] };

    /* Helper: given a package entry that has a personal_<id> key, look
       up the source personal_packages doc, run expand+normalize, and
       return the new items if they differ — or null if no change. */
    const computeFixedItems = async (entry) => {
      if (!entry?.key || !entry.key.startsWith("personal_")) return null;
      const id = entry.key.slice("personal_".length);
      if (!ObjectId.isValid(id)) return null;
      const srcPkg = await COL().findOne({ _id: new ObjectId(id) });
      if (!srcPkg) return null;
      const expanded   = await expandBundles(srcPkg.items || {});
      const normalized = normalizePackageItems(expanded);
      const before = entry.items || {};
      const allKeys = new Set([...Object.keys(before), ...Object.keys(normalized)]);
      let changed = false;
      for (const k of allKeys) {
        if ((before[k] || 0) !== (normalized[k] || 0)) { changed = true; break; }
      }
      return changed ? { before, after: normalized } : null;
    };

    // ── activePackage ────────────────────────────────────────────────
    if (user.activePackage) {
      const fix = await computeFixedItems(user.activePackage);
      if (fix) {
        await getDB().collection(USERS_COL).updateOne(
          { phone },
          { $set: { "activePackage.items": fix.after } },
        );
        report.activeChanged = true;
        report.entries.push({ scope: "activePackage", key: user.activePackage.key, ...fix });
        console.log(`[repair-active-package] phone=${phone} updated activePackage.items`);
      }
    }

    // ── purchasedPackages history ────────────────────────────────────
    const history = Array.isArray(user.purchasedPackages) ? user.purchasedPackages : [];
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const fix = await computeFixedItems(entry);
      if (!fix) continue;
      await getDB().collection(USERS_COL).updateOne(
        { phone },
        { $set: { [`purchasedPackages.${i}.items`]: fix.after } },
      );
      report.historyChanged += 1;
      report.entries.push({ scope: `purchasedPackages[${i}]`, key: entry.key, ...fix });
      console.log(`[repair-active-package] phone=${phone} updated purchasedPackages[${i}].items`);
    }

    return res.json(report);
  } catch (err) {
    console.error("[repair-active-package] error:", err.message);
    res.status(500).json({ error: err.message });
  }
};
