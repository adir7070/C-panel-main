/**
 * packages.controller.js
 * Mobile-facing endpoints for prebuilt package purchase.
 * No agent auth — called directly by the mobile app.
 */

const axios = require("axios");
const cardcomConfig = require("../config/cardcom.config");
const { getDB } = require("../config/db");
const DB = require("../utils/DB");
const { listAll, getPackageByKey } = require("../services/cpanel-products.service");
const { sendPurchaseWebhook } = require("../utils/purchase-webhook");
const { createReceipt } = require("../utils/create-receipt");
const { withVAT } = require("../services/cardcom.service");
const { generateContractPdf, buildContractViewHtml } = require("../services/pdf-contract.service");
const { uploadImage } = require("../services/backblaze.service");
const { getCustomerByPhone } = require("../services/fireberry-customers.service");
const { billingEnabled } = require("../utils/billing");
const purchaseSync = require("../services/purchase-sync.service");
const { requiredEnv } = require("../utils/required-env");

// Fetch contract rules always from Atlas — the canonical source.
// Admin UI on Heroku writes only to Atlas (no AWS_MONGO_URI there), so AWS MongoDB
// may lag behind. Atlas is always up-to-date regardless of which server made the change.
// On AWS: Atlas is DB._fallbackDb. On Heroku: Atlas is getDB() (primary).
async function fetchContractRules() {
  const sort = { priority: 1, createdAt: 1 };
  const atlasDb = DB._fallbackDb || getDB();
  let rules = await atlasDb.collection("contract_rules").find({}).sort(sort).toArray().catch(() => []);
  if (rules.length === 0 && DB._fallbackDb) {
    rules = await getDB().collection("contract_rules").find({}).sort(sort).toArray().catch(() => []);
  }
  return rules;
}

async function fetchAlwaysPages() {
  const atlasDb = DB._fallbackDb || getDB();
  const docs = await atlasDb.collection("contract_doc_names")
    .find({ alwaysInclude: true })
    .sort({ sortOrder: 1, fileName: 1 })
    .toArray()
    .catch(() => []);
  return docs.map(d => d.fileName);
}

const USERS_COL = "users";
const PENDING_COL = "package_pending_purchases";
const TRANS_COL = "package_transactions";

/* ── GET /api/packages ──────────────────────────────────────────────── */
exports.listPackages = async (_req, res) => {
  try {
    const { prebuilt } = await listAll();
    res.json({ success: true, packages: prebuilt });
  } catch (err) {
    console.error("[Packages] listPackages:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/social ──────────────────────────────────────────
   Returns the social-only tier (social_weekly / social_biweekly /
   social_monthly). These are NOT bought via Cardcom — they're redeemed
   against the client's coin balance via /api/packages/redeem-with-coins.

   `price` and `coins` are the same number (the coin cost shown on the card),
   so while billing is off both report 0 and the app renders the plans as free
   without a client release. The catalog itself is left untouched — only this
   response is zeroed, and only here, because no money path reads it. */
exports.listSocialPackages = async (_req, res) => {
  try {
    const { social } = await listAll();
    const packages = (social || []).map(p =>
      billingEnabled() ? p : { ...p, price: 0, coins: 0 },
    );
    res.json({ success: true, packages });
  } catch (err) {
    console.error("[Packages] listSocialPackages:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/redeem-with-coins ──────────────────────────────
   Debits the client's coin balance and activates the social package.
   No Cardcom. No money. Idempotent at the user-level via the atomic
   coins>=cost guard (re-tap returns insufficient_coins after the
   balance has dropped below the package price).

   Body: { phone, packageKey }
   200  { success:true, packageName, coinsCharged, coinsRemaining }
   400  { success:false, reason:"insufficient_coins", coinsRequired, coinsAvailable }
   404  { success:false, reason:"package_not_found"|"user_not_found" } */
exports.redeemWithCoins = async (req, res) => {
  try {
    // schedule (the client's chosen publish slots) + FB/IG creds turn this into
    // the FULLY AUTOMATIC social campaign: generate + schedule-publish, no manager.
    const { phone, packageKey, brief, schedule, facebook, instagram, focusService } = req.body || {};
    const result = await require("../services/social-redeem.service").redeem({
      phone, packageKey, brief, schedule, facebook, instagram, focusService, source: "mobile",
    });
    if (result.success) return res.json(result);
    const status = result.reason === "insufficient_coins" ? 400
                 : result.reason === "package_not_found"  ? 404
                 : result.reason === "user_not_found"     ? 404
                 : 400;
    return res.status(status).json(result);
  } catch (err) {
    console.error("[Packages] redeemWithCoins:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/* ── POST /api/packages/purchase-iframe ────────────────────────────── */
exports.purchaseIframe = async (req, res) => {
  try {
    const { phone, packageKey } = req.body;
    if (!phone || !packageKey) {
      return res.status(400).json({ error: "חסרים phone ו-packageKey" });
    }

    const pkg = await getPackageByKey(packageKey);
    if (!pkg || pkg.kind !== "prebuilt") {
      /* Social plans intentionally rejected here — they're not paid via
         Cardcom, they're redeemed against the client's coin balance via
         POST /api/packages/redeem-with-coins. */
      return res.status(404).json({ error: "חבילה לא נמצאה" });
    }

    const baseUrl = requiredEnv("SERVER_BASE_URL");

    const user = await getDB().collection(USERS_COL).findOne(
      { phone },
      { projection: { name: 1 } },
    );
    const clientName = user?.name || phone;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName: cardcomConfig.apiName,
      ApiPassword: cardcomConfig.apiPassword,

      Amount: pkg.price,
      ISOCoinId: 1, // שקלים
      ProductName: pkg.name,

      SuccessRedirectUrl: `${cardcomConfig.successURL}?type=package&package=${packageKey}`,
      ErrorRedirectUrl: `${cardcomConfig.errorURL}?type=package`,
      NotifyURL: `${baseUrl}/api/packages/payment-notify?phone=${encodeURIComponent(phone)}&packageKey=${packageKey}`,

      ReturnValue: `${phone}|${packageKey}`,
      CreateInvoice: false,
      IsCreateToken: false,
      Operation: 1,
      IsApplePay: true,
      IsBit: true,
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
        packageKey,
        packageName: pkg.name,
        amount: pkg.price,
        coins: pkg.coins ?? 0,
        source: "mobile",
        createdAt: new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Packages] purchaseIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/verify-payment ─────────────────────────────── */
exports.verifyPayment = async (req, res) => {
  try {
    const { lowProfileId, phone, packageKey } = req.body;
    if (!lowProfileId || !phone) {
      return res.status(400).json({ error: "חסרים lowProfileId ו-phone" });
    }

    // מניעת כפילות
    const existing = await getDB().collection(TRANS_COL).findOne({ lowProfileId });
    if (existing) {
      return res.json({ success: true, alreadyProcessed: true, packageName: existing.packageName });
    }

    // אימות עם קרדקום
    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName: cardcomConfig.apiName,
        ApiPassword: cardcomConfig.apiPassword,
        LowProfileId: lowProfileId,
      },
    );

    const data = verifyRes.data;
    console.log("[Packages] verifyPayment Cardcom response:", JSON.stringify(data));

    // ResponseCode 0 = API call succeeded; OperationResponse may vary by terminal/3DS flow
    // so we rely only on ResponseCode (same pattern as payment.controller.js coins flow)
    if (!data || data.ResponseCode !== 0) {
      sendPurchaseWebhook({
        event:     "purchase_rejected",
        source:    "mobile_app",
        timestamp: new Date().toISOString(),
        client:    { phone },
        error:     data?.Description || "התשלום לא אושר",
        payment:   { lowProfileId },
      }).catch(() => {});
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    // שליפת פרטי החבילה
    const pending = await getDB().collection(PENDING_COL).findOne({ lowProfileId });
    const resolvedKey = packageKey || pending?.packageKey;
    const pkg = resolvedKey ? await getPackageByKey(resolvedKey) : null;

    const packageName = pkg?.name || pending?.packageName || resolvedKey || "חבילה";
    const coinsToCredit = pkg?.coins ?? pending?.coins ?? 0;
    const amount = pkg?.price ?? pending?.amount ?? 0;

    const now = new Date();

    const packageEntry = {
      key:         resolvedKey,
      name:        packageName,
      purchasedAt: now.toISOString(),
      items:       pkg?.items ?? {},
      coins:       coinsToCredit,
      status:      "waiting_brief",
    };

    // שמירת טוקן לחיוב עתידי (אם קרדקום החזיר)
    const tokenInfo = data.TokenInfo;
    const txnInfo   = data.TranzactionInfo;
    const tokenUpdate = {};
    if (tokenInfo?.Token) {
      const month = String(tokenInfo.CardMonth).padStart(2, "0");
      const year  = String(tokenInfo.CardYear).slice(-2);
      tokenUpdate.paymentToken  = tokenInfo.Token;
      tokenUpdate.paymentExpiry = month + year;
      tokenUpdate.paymentLast4  = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
    }

    // עדכון activePackage + הוספה למערך purchasedPackages + קרדיט מטבעות
    await getDB().collection(USERS_COL).updateOne(
      { phone },
      {
        $set:  { activePackage: packageEntry, ...tokenUpdate },
        $push: { purchasedPackages: packageEntry },
        $inc:  { coins: coinsToCredit },
      },
      { upsert: false },
    );

    // רשומת עסקה
    await getDB().collection(TRANS_COL).insertOne({
      lowProfileId,
      phone,
      packageKey: resolvedKey,
      packageName,
      amount,
      coinsGranted: coinsToCredit,
      source: "mobile",
      createdAt: now,
    });

    /* Persist to cpanel_pending_purchases so the C-panel's history view
       (listClientPackages) sees this purchase. Without this row, mobile
       purchases vanish from the products screen as soon as the NEXT one
       lands and overwrites users.activePackage — that's the bug that
       made yesterday's package disappear after today's purchase. Shape
       matches the C-panel iframe-charge flow so activePackageFromPending
       maps it correctly. */
    try {
      const items = pkg?.items || {};
      await getDB().collection("cpanel_pending_purchases").insertOne({
        phone,
        lowProfileId,
        kind:        "package",
        packageKey:  resolvedKey,
        description: packageName,
        name:        packageName,
        adsCount:          Number(items.paidAds)    || 0,
        socialAdsCount:    Number(items.organicAds) || 0,
        organicPosts:      0,
        videosCount:       Number(items.videos)     || 0,
        landingPagesCount: Number(items.lps)        || 0,
        logosCount:        Number(items.logos)      || 0,
        coinsOverride:     coinsToCredit,
        totalAmount:       amount,
        source:            "mobile",
        createdAt:         now,
        completedAt:       now,
      });
    } catch (err) {
      /* Non-fatal — the user got their package, coins, etc. The history
         row just helps the C-panel render the older package card. */
      console.warn("[Packages] cpanel_pending_purchases insert failed:", err.message);
    }

    console.log(`[Packages] ✅ Package activated: ${phone} → ${packageName} (+${coinsToCredit} coins)`);
    createReceipt({ phone, type: "package", description: packageName, amount, coinsGranted: coinsToCredit, source: "mobile_app", lowProfileId }).catch(() => {});

    /* Real-time popup to the assigned account manager + WhatsApp/SMS.
       Fire-and-forget: never block the client's success response on
       notification side-effects. */
    require("../services/wow-manager-notify.service")
      .notifyManagerOfPurchase({
        clientPhone:  phone,
        businessName: pending?.businessName || null,
        packageName,
        amount,
        coinsGranted: coinsToCredit,
      })
      .catch(err => console.warn("[Packages] notifyManagerOfPurchase failed:", err.message));

    // Fire purchase webhook — fire-and-forget
    Promise.resolve().then(async () => {
      const clientMapping = await getDB().collection("cpanel_clients").findOne(
        { phone },
        { projection: { agentId: 1 } },
      );
      const agentDoc = clientMapping?.agentId
        ? await getDB().collection("agents").findOne(
            { _id: clientMapping.agentId },
            { projection: { name: 1, nickname: 1, email: 1, phone: 1 } },
          )
        : null;
      return sendPurchaseWebhook({
        event:     "purchase_success",
        source:    "mobile_app",
        timestamp: new Date().toISOString(),
        client: {
          phone,
          name:        pending?.businessName || null,
          businessName: pending?.businessName || null,
        },
        manager: {
          id:    clientMapping?.agentId || null,
          name:  agentDoc?.nickname || agentDoc?.name || null,
          email: agentDoc?.email || null,
          phone: agentDoc?.phone || null,
        },
        package: {
          name:         packageName,
          kind:         "package",
          amount,
          coinsGranted: coinsToCredit,
          items:        pkg?.items || {},
        },
        payment: {
          lowProfileId,
          last4: txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "") || null,
          expDate: tokenInfo ? (String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2)) : null,
        },
      });
    }).catch(err => console.warn("[Packages] purchase webhook failed:", err.message));

    res.json({ success: true, packageName, coinsGranted: coinsToCredit });
  } catch (err) {
    console.error("[Packages] verifyPayment:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/charge-token ───────────────────────────────── */
exports.chargeToken = async (req, res) => {
  try {
    const { phone, packageKey } = req.body;
    if (!phone || !packageKey) {
      return res.status(400).json({ error: "חסרים phone ו-packageKey" });
    }

    const db = getDB();

    const user = await db.collection(USERS_COL).findOne({ phone });
    if (!user?.paymentToken) {
      return res.status(400).json({ error: "לא נמצא כרטיס שמור" });
    }

    const pkg = await getPackageByKey(packageKey);
    if (!pkg || pkg.kind !== "prebuilt") {
      /* Social plans intentionally rejected here — they're not paid via
         Cardcom, they're redeemed against the client's coin balance via
         POST /api/packages/redeem-with-coins. */
      return res.status(404).json({ error: "חבילה לא נמצאה" });
    }

    const requestBody = {
      TerminalNumber: Number(cardcomConfig.terminal),
      ApiName: cardcomConfig.apiName,
      Amount: pkg.price,
      ISOCoinId: 1,
      Token: user.paymentToken,
      CardExpirationMMYY: user.paymentExpiry,
    };

    const cardcomRes = await axios.post(cardcomConfig.doTransactionUrl, requestBody);
    const data = cardcomRes.data;

    if (!data || data.ResponseCode !== 0) {
      sendPurchaseWebhook({
        event:     "purchase_rejected",
        source:    "mobile_app",
        timestamp: new Date().toISOString(),
        client:    { phone },
        package:   { name: pkg.name, kind: "package", amount: pkg.price },
        error:     data?.Description || "התשלום לא אושר",
        payment:   { lowProfileId: null },
      }).catch(() => {});
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    const coinsToCredit = pkg.coins ?? 0;
    const now = new Date();

    const packageEntry = {
      key:         packageKey,
      name:        pkg.name,
      purchasedAt: now.toISOString(),
      items:       pkg.items ?? {},
      coins:       coinsToCredit,
      status:      "waiting_brief",
    };

    await db.collection(USERS_COL).updateOne(
      { phone },
      {
        $set:  { activePackage: packageEntry, updatedAt: now },
        $push: { purchasedPackages: packageEntry },
        $inc:  { coins: coinsToCredit },
      },
    );

    await db.collection(TRANS_COL).insertOne({
      transactionId: data.TransactionId,
      phone,
      packageKey,
      packageName: pkg.name,
      amount: pkg.price,
      coinsGranted: coinsToCredit,
      source: "mobile-token",
      createdAt: now,
    });

    console.log(`[Packages] ✅ Token charge: ${phone} → ${pkg.name} (+${coinsToCredit} coins)`);
    createReceipt({ phone, type: "package", description: pkg.name, amount: pkg.price, coinsGranted: coinsToCredit, source: "mobile_app", lowProfileId: null }).catch(() => {});

    // Fire purchase webhook — fire-and-forget
    Promise.resolve().then(async () => {
      const clientMapping = await db.collection("cpanel_clients").findOne({ phone }, { projection: { agentId: 1 } });
      const agentDoc = clientMapping?.agentId
        ? await db.collection("agents").findOne({ _id: clientMapping.agentId }, { projection: { name: 1, nickname: 1, email: 1, phone: 1 } })
        : null;
      return sendPurchaseWebhook({
        event:     "purchase_success",
        source:    "mobile_app",
        timestamp: new Date().toISOString(),
        client:    { phone },
        manager: {
          id:    clientMapping?.agentId || null,
          name:  agentDoc?.nickname || agentDoc?.name || null,
          email: agentDoc?.email || null,
          phone: agentDoc?.phone || null,
        },
        package: {
          name:         pkg.name,
          kind:         "package",
          amount:       pkg.price,
          coinsGranted: coinsToCredit,
          items:        pkg.items || {},
        },
        payment: {
          transactionId: data.TransactionId || null,
          last4: user.paymentLast4 || null,
          expDate: user.paymentExpiry || null,
        },
      });
    }).catch(err => console.warn("[Packages] token charge webhook failed:", err.message));

    res.json({ success: true, packageName: pkg.name, coinsGranted: coinsToCredit, message: "החבילה הופעלה בהצלחה" });
  } catch (err) {
    console.error("[Packages] chargeToken:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/payment-notify (Cardcom webhook) ───────────── */
exports.paymentNotify = async (req, res) => {
  // קרדקום שולח webhook אחרי תשלום — לוג בלבד, האימות הולך דרך verify-payment
  try {
    const { phone, packageKey } = req.query;
    console.log(`[Packages] paymentNotify webhook: phone=${phone}, key=${packageKey}`);
    res.status(200).send("OK");
  } catch (err) {
    res.status(200).send("OK"); // תמיד להחזיר 200 לקרדקום
  }
};

/* ── GET /api/packages/personal?phone=xxx ───────────────────────────── */
exports.listPersonal = async (req, res) => {
  try {
    const phone = (req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const pkgs = await getDB()
      .collection("personal_packages")
      .find(
        { phone, active: true, purchased: false },
        /* currencyCode/isSubscription/billingCycle stay in — the app needs
           them to render $ vs ₪ and the monthly-price caption */
        { projection: { notes: 0, agentId: 0 } },
      )
      .sort({ createdAt: -1 })
      .toArray();

    // Bullets fallback: for packages saved before bullets were introduced,
    // derive them on-the-fly from item keys using the catalog labels.
    const needsEnrich = pkgs.some(p => !p.bullets || p.bullets.length === 0);
    let catalogItemMap = {};
    if (needsEnrich) {
      const catalogItems = await getDB()
        .collection("cpanel_products")
        .find({ kind: "item", active: { $ne: false } }, { projection: { key: 1, label: 1, emoji: 1 } })
        .toArray();
      catalogItemMap = Object.fromEntries(catalogItems.map(i => [i.key, i]));
    }

    const enriched = pkgs.map(pkg => {
      const bullets = (pkg.bullets && pkg.bullets.length > 0)
        ? pkg.bullets
        : Object.entries(pkg.items || {})
            .filter(([, qty]) => qty > 0)
            .map(([key]) => {
              const ci = catalogItemMap[key];
              return ci ? [ci.emoji, ci.label].filter(Boolean).join(" ") : key;
            });

      return { ...pkg, bullets };
    });

    res.json({ success: true, packages: enriched });
  } catch (err) {
    console.error("[Packages] listPersonal:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/my-purchases?phone=xxx ───────────────────────── */
// Returns purchased personal packages (active=true, purchased=true) with contract status.
exports.myPurchases = async (req, res) => {
  try {
    const phone = (req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const pkgs = await getDB()
      .collection("personal_packages")
      .find(
        { phone, active: true, purchased: true },
        { projection: { notes: 0, agentId: 0 } },
      )
      .sort({ purchasedAt: -1 })
      .toArray();

    res.json({ success: true, packages: pkgs });
  } catch (err) {
    console.error("[Packages] myPurchases:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/purchase-personal-iframe ───────────────────── */
exports.purchasePersonalIframe = async (req, res) => {
  try {
    const { phone, personalPackageId } = req.body;
    if (!phone || !personalPackageId) {
      return res.status(400).json({ error: "חסרים phone ו-personalPackageId" });
    }

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ error: "personalPackageId לא תקין" });
    }

    const pkg = await getDB().collection("personal_packages").findOne({
      _id: new ObjectId(personalPackageId), phone, active: true, purchased: false,
    });
    if (!pkg) return res.status(404).json({ error: "חבילה אישית לא נמצאה" });

    const baseUrl = requiredEnv("SERVER_BASE_URL");
    const user = await getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } });
    const clientName = user?.name || phone;

    // Include any pending coin selection the client made in the contract
    const pendingCoin  = pkg.pendingContractCoin || null;
    const combined     = (pkg.finalPrice || 0) + (pendingCoin?.price || 0);
    /* Subscription packages: charge the exact price (no VAT added — a "$300/mo"
       plan bills exactly $300), in the package currency, and tokenize the card
       (Operation 2 + IsCreateToken) so the renewal job can charge monthly.
       priceIncludesVat packages (חבילת דף נחיתה ₪2,000): the package price is
       final — VAT applies only to an added coin package. */
    const isSub   = pkg.isSubscription === true;
    const inclVat = pkg.priceIncludesVat === true;
    const amountWithVat = isSub
      ? combined
      : inclVat
        ? (pkg.finalPrice || 0) + withVAT(pendingCoin?.price || 0)
        : withVAT(combined);

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         amountWithVat,
      /* charge in the package currency (2=USD, 1=ILS) for one-time packages
         too — a USD one-time offer must not be billed in shekels */
      ISOCoinId:      pkg.currencyCode ?? 1,
      ProductName:    pendingCoin ? `${pkg.name} + ${pendingCoin.name}` : pkg.name,
      SuccessRedirectUrl: `${cardcomConfig.successURL}?type=personal_package&package=${personalPackageId}`,
      ErrorRedirectUrl:   `${cardcomConfig.errorURL}?type=personal_package`,
      NotifyURL: `${baseUrl}/api/packages/payment-notify?phone=${encodeURIComponent(phone)}&personalPackageId=${personalPackageId}`,
      ReturnValue:    `${phone}|personal|${personalPackageId}`,
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

    if (lowProfileId) {
      await getDB().collection(PENDING_COL).insertOne({
        lowProfileId,
        phone,
        personalPackageId,
        packageName:         pkg.name,
        amount:              combined,       // נטו (ללא מע"מ), כולל מטבעות
        amountWithVat,                       // כולל מע"מ — מה שחויב בפועל
        coins:               pkg.coins ?? 0,
        pendingCoinKey:      pendingCoin?.key  || null,
        pendingCoinCoins:    pendingCoin?.coins || 0,
        pendingCoinPrice:    pendingCoin?.price || 0,
        source:              "mobile_personal",
        createdAt:           new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Packages] purchasePersonalIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/webinar-ensure-offers ───────────────────────────
   Public. Makes sure the webinar offers (monthly / yearly / landing page /
   business page) exist for this phone — creates any that are missing — then
   returns the fresh available + purchased lists. The /packages page calls this
   on load so the choice screen and the monthly add-ons are always available. */
exports.webinarEnsureOffers = async (req, res) => {
  try {
    const phone = ((req.body && req.body.phone) || req.query.phone || "").toString().trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });

    try {
      await require("../services/webinar-subscription.service")
        .createWebinarOffers(phone, { nickname: "webinar-web" });
    } catch (e) {
      console.warn("[Packages] webinarEnsureOffers:", e.message);
    }

    const db = getDB();
    const proj = { projection: { notes: 0, agentId: 0 } };
    const [available, purchased] = await Promise.all([
      db.collection("personal_packages").find({ phone, active: true, purchased: false }, proj).sort({ createdAt: -1 }).toArray(),
      db.collection("personal_packages").find({ phone, active: true, purchased: true }, proj).sort({ purchasedAt: -1 }).toArray(),
    ]);
    res.json({ success: true, available, purchased });
  } catch (err) {
    console.error("[Packages] webinarEnsureOffers:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/webinar-pay-iframe ──────────────────────────────
   Public (phone-only) charge for the self-serve webinar packages page
   (/packages). Same correct subscription/one-time Cardcom logic as
   purchasePersonalIframe, but built for a BROWSER (not the app WebView):
     • WebHookUrl → the public /payment-confirm-personal handler, which
       fulfils server-side (marks purchased, grants coins, records the
       subscription) — so the purchase completes even if the customer closes
       the browser right after paying.
     • Success/Error redirect the browser back to the packages page.
   Body: { phone, personalPackageId }. */
exports.webinarPayIframe = async (req, res) => {
  try {
    const { phone, personalPackageId } = req.body;
    if (!phone || !personalPackageId) {
      return res.status(400).json({ error: "חסרים phone ו-personalPackageId" });
    }
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ error: "personalPackageId לא תקין" });
    }

    const pkg = await getDB().collection("personal_packages").findOne({
      _id: new ObjectId(personalPackageId), phone, active: true, purchased: false,
    });
    if (!pkg) return res.status(404).json({ error: "חבילה אישית לא נמצאה" });

    const baseUrl = requiredEnv("SERVER_BASE_URL");
    const user = await getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } });
    const clientName = user?.name || phone;

    /* Subscription → charge exact price + tokenize (Operation 2). priceIncludesVat
       (₪2,000 / ₪500 one-time) → price is final. Otherwise add 18% VAT. */
    const isSub   = pkg.isSubscription === true;
    const inclVat = pkg.priceIncludesVat === true;
    const amountWithVat = (isSub || inclVat) ? (pkg.finalPrice || 0) : withVAT(pkg.finalPrice || 0);

    const pageUrl    = `${baseUrl}/packages`;
    const successUrl = `${pageUrl}?paid=1&phone=${encodeURIComponent(phone)}&pkg=${personalPackageId}`;
    const errorUrl   = `${pageUrl}?payfail=1&phone=${encodeURIComponent(phone)}`;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         amountWithVat,
      ISOCoinId:      pkg.currencyCode ?? 1,
      ProductName:    pkg.name,
      SuccessRedirectUrl: successUrl,
      ErrorRedirectUrl:   errorUrl,
      /* server-to-server fulfilment — fires even if the browser is closed */
      WebHookUrl: `${baseUrl}/api/cpanel/payment-confirm-personal?phone=${encodeURIComponent(phone)}&id=${personalPackageId}`,
      ReturnValue:    `${phone}|webinar_web|${personalPackageId}`,
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

    console.log(`[webinar-pay] created lp=${lowProfileId} phone=${phone} pkg=${personalPackageId} amount=${amountWithVat} ISOCoinId=${requestBody.ISOCoinId} op=${requestBody.Operation} bit=${requestBody.IsBit} createCode=${cardcomRes.data.ResponseCode}`);

    /* Pending row (same collection the confirm handler marks completed) so the
       purchase shows in history. */
    if (lowProfileId) {
      await getDB().collection("cpanel_pending_purchases").insertOne({
        lowProfileId,
        phone,
        personalPackageId,
        kind:                 "personal",
        packageKey:           `personal_${personalPackageId}`,
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
        source:               "webinar_web",
        createdAt:            new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Packages] webinarPayIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/webinar-pay-status ──────────────────────────────
   Public diagnostic. Given a lowProfileId, asks Cardcom for the transaction
   result and returns/logs the exact ResponseCode + Description — so a failed
   charge (e.g. "currency not supported") surfaces on the page and in the log
   instead of a generic "unexpected error". */
exports.webinarPayStatus = async (req, res) => {
  try {
    const lowProfileId = ((req.body && req.body.lowProfileId) || req.query.lowProfileId || "").toString();
    if (!lowProfileId) return res.status(400).json({ error: "lowProfileId is required" });
    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      { TerminalNumber: cardcomConfig.terminal, ApiName: cardcomConfig.apiName, ApiPassword: cardcomConfig.apiPassword, LowProfileId: lowProfileId },
    );
    const d   = verifyRes.data || {};
    const txn = d.TranzactionInfo || {};
    console.log(`[webinar-pay-status] lp=${lowProfileId} code=${d.ResponseCode} desc="${d.Description||""}" txnCode=${txn.ResponseCode} txnDesc="${txn.Description||""}"`);
    res.json({
      success: true,
      responseCode: d.ResponseCode ?? null,
      description: d.Description || null,
      txnResponseCode: txn.ResponseCode ?? null,
      txnDescription: txn.Description || null,
    });
  } catch (err) {
    console.error("[webinar-pay-status]", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/webinar-bundle-iframe ───────────────────────────
   Public. Charges SEVERAL of the phone's webinar packages in ONE Cardcom
   session (one total, one card entry). All items must share a currency (they
   are all ILS). If any item is a subscription the whole charge tokenises
   (Operation 2) — the first payment is the bundle total, renewals charge only
   the subscription's own price. Body: { phone, packageIds: [id,...] }. */
exports.webinarBundleIframe = async (req, res) => {
  try {
    const { phone } = req.body || {};
    const { ObjectId } = require("mongodb");
    const ids = [...new Set((Array.isArray(req.body?.packageIds) ? req.body.packageIds : []).map(String))]
      .filter(id => ObjectId.isValid(id));
    if (!phone || !ids.length) return res.status(400).json({ error: "חסרים phone ו-packageIds" });

    const pkgs = await getDB().collection("personal_packages").find({
      _id: { $in: ids.map(id => new ObjectId(id)) }, phone, active: true, purchased: false,
    }).toArray();
    if (!pkgs.length) return res.status(404).json({ error: "לא נמצאו חבילות לרכישה" });

    const currency = pkgs[0].currencyCode ?? 1;
    if (pkgs.some(p => (p.currencyCode ?? 1) !== currency)) {
      return res.status(400).json({ error: "לא ניתן לאחד חבילות במטבעות שונים" });
    }

    /* subscription / priceIncludesVat items are final; others get +18% VAT */
    let total = 0;
    for (const p of pkgs) {
      const inclVat = p.isSubscription === true || p.priceIncludesVat === true;
      total += inclVat ? (p.finalPrice || 0) : withVAT(p.finalPrice || 0);
    }
    const hasSub = pkgs.some(p => p.isSubscription === true);
    const productName = pkgs.map(p => p.name).join(" + ").slice(0, 240);

    const baseUrl = requiredEnv("SERVER_BASE_URL");
    const user = await getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } });
    const clientName = user?.name || phone;

    const pageUrl    = `${baseUrl}/packages`;
    const successUrl = `${pageUrl}?paid=1&phone=${encodeURIComponent(phone)}`;
    const errorUrl   = `${pageUrl}?payfail=1&phone=${encodeURIComponent(phone)}`;

    const requestBody = {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         total,
      ISOCoinId:      currency,
      ProductName:    productName,
      SuccessRedirectUrl: successUrl,
      ErrorRedirectUrl:   errorUrl,
      WebHookUrl: `${baseUrl}/api/packages/webinar-bundle-confirm?phone=${encodeURIComponent(phone)}`,
      ReturnValue:    `${phone}|webinar_bundle`,
      CreateInvoice:  false,
      IsCreateToken:  hasSub,
      Operation:      hasSub ? 2 : 1,
      IsApplePay:     true,
      IsBit:          currency === 1,
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

    console.log(`[webinar-bundle] created lp=${lowProfileId} phone=${phone} pkgs=${ids.length} total=${total} ISOCoinId=${currency} op=${requestBody.Operation}`);

    if (lowProfileId) {
      await getDB().collection("cpanel_pending_purchases").insertOne({
        lowProfileId, phone,
        kind:         "personal_bundle",
        packageIds:   ids,
        packageName:  productName,
        description:  productName,
        name:         productName,
        totalAmount:  total,
        amountWithVat: total,
        source:       "webinar_bundle",
        createdAt:    new Date(),
      });
    }

    res.json({ success: true, url: paymentUrl, lowProfileId, total });
  } catch (err) {
    console.error("[Packages] webinarBundleIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/webinar-bundle-confirm ──────────────────────────
   Fulfils a bundle after payment: marks every package in the bundle purchased,
   grants their coins, records the subscription (with the sub's OWN price for
   renewal, not the bundle total). Idempotent by lowProfileId. Serves BOTH the
   Cardcom WebHookUrl (server-side, survives a closed browser) and the page's
   post-redirect confirm call. */
exports.webinarBundleConfirm = async (req, res) => {
  try {
    const body = req.body || {};
    const lowProfileId = (body.LowProfileId || body.lowProfileId || body.lowprofilecode || req.query.lowProfileId || "").toString();
    if (!lowProfileId) return res.status(400).json({ error: "lowProfileId is required" });

    const existing = await getDB().collection(TRANS_COL).findOne({ lowProfileId });
    if (existing) return res.json({ success: true, alreadyProcessed: true });

    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      { TerminalNumber: cardcomConfig.terminal, ApiName: cardcomConfig.apiName, ApiPassword: cardcomConfig.apiPassword, LowProfileId: lowProfileId },
    );
    const data = verifyRes.data;
    if (!data || data.ResponseCode !== 0) {
      console.warn(`[webinar-bundle] Cardcom rejected lp=${lowProfileId}: ${data?.Description || ""}`);
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    const pending = await getDB().collection("cpanel_pending_purchases").findOne({ lowProfileId });
    const phone = (req.query.phone || body.phone || pending?.phone || "").toString();
    const ids = (pending?.packageIds || []).filter(Boolean);
    if (!phone || !ids.length) {
      console.warn(`[webinar-bundle] no pending bundle for lp=${lowProfileId}`);
      return res.json({ success: false, message: "לא נמצאה עסקה" });
    }

    const { ObjectId } = require("mongodb");
    const now = new Date();
    const tokenInfo = data.TokenInfo, txnInfo = data.TranzactionInfo;
    const tokenUpdate = {};
    if (tokenInfo?.Token) {
      const month = String(tokenInfo.CardMonth).padStart(2, "0");
      const year  = String(tokenInfo.CardYear).slice(-2);
      tokenUpdate.paymentToken  = tokenInfo.Token;
      tokenUpdate.paymentExpiry = month + year;
      tokenUpdate.paymentLast4  = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
    }

    const pkgs = await getDB().collection("personal_packages").find({
      _id: { $in: ids.map(id => new ObjectId(id)) }, phone,
    }).toArray();

    let totalCoins = 0; const fulfilled = []; let primaryEntry = null;
    const subPkg = pkgs.find(p => p.isSubscription === true);

    for (const pkg of pkgs) {
      if (pkg.purchased) continue;
      const coins = pkg.coins ?? 0;
      totalCoins += coins;
      const entry = {
        key: `personal_${pkg._id}`, name: pkg.name, purchasedAt: now.toISOString(),
        items: pkg.items ?? {}, coins, status: "waiting_brief",
      };
      if (!primaryEntry || pkg.isSubscription) primaryEntry = entry;

      await getDB().collection(USERS_COL).updateOne(
        { phone },
        { $push: { purchasedPackages: entry }, $inc: { coins } },
        { upsert: false },
      );
      await getDB().collection("personal_packages").updateOne(
        { _id: pkg._id }, { $set: { purchased: true, purchasedAt: now } },
      );
      fulfilled.push(pkg.name);

      Promise.resolve().then(() => sendPurchaseWebhook({
        event: "purchase_success", source: "webinar_bundle", timestamp: new Date().toISOString(),
        client: { phone },
        package: { name: pkg.name, kind: "personal", amount: pkg.finalPrice, coinsGranted: coins, items: pkg.items || {} },
        payment: { lowProfileId, last4: tokenUpdate.paymentLast4 || null },
      })).catch(() => {});
    }

    const userSet = { ...tokenUpdate };
    if (primaryEntry) userSet.activePackage = primaryEntry;
    if (Object.keys(userSet).length) {
      await getDB().collection(USERS_COL).updateOne({ phone }, { $set: userSet }, { upsert: false });
    }

    if (subPkg && tokenUpdate.paymentToken) {
      try {
        await require("../services/webinar-subscription.service").recordSubscription({
          phone, personalPackageId: String(subPkg._id), pkg: subPkg,
          token: tokenUpdate.paymentToken, cardExpiry: tokenUpdate.paymentExpiry, last4: tokenUpdate.paymentLast4,
        });
      } catch (e) { console.warn("[webinar-bundle] recordSubscription failed:", e.message); }
    }

    await getDB().collection(TRANS_COL).insertOne({
      lowProfileId, phone,
      packageName: pending?.packageName || fulfilled.join(" + "),
      amount: pending?.totalAmount ?? null, coinsGranted: totalCoins,
      bundle: ids, source: "webinar_bundle", createdAt: now,
    });
    await getDB().collection("cpanel_pending_purchases").updateOne({ lowProfileId }, { $set: { completedAt: now } });

    console.log(`[webinar-bundle] ✅ fulfilled lp=${lowProfileId} phone=${phone} pkgs=[${fulfilled.join(", ")}] coins=${totalCoins}`);
    res.json({ success: true, packages: fulfilled, coinsGranted: totalCoins });
  } catch (err) {
    console.error("[Packages] webinarBundleConfirm:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/verify-personal-payment ────────────────────── */
exports.verifyPersonalPayment = async (req, res) => {
  try {
    const { lowProfileId, phone, personalPackageId } = req.body;
    if (!lowProfileId || !phone || !personalPackageId) {
      return res.status(400).json({ error: "חסרים lowProfileId, phone ו-personalPackageId" });
    }

    const existing = await getDB().collection(TRANS_COL).findOne({ lowProfileId });
    if (existing) {
      return res.json({ success: true, alreadyProcessed: true, packageName: existing.packageName });
    }

    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName:        cardcomConfig.apiName,
        ApiPassword:    cardcomConfig.apiPassword,
        LowProfileId:   lowProfileId,
      },
    );

    const data = verifyRes.data;
    if (!data || data.ResponseCode !== 0) {
      return res.json({ success: false, message: data?.Description || "התשלום לא אושר" });
    }

    const { ObjectId } = require("mongodb");
    const pkg = await getDB().collection("personal_packages").findOne({
      _id: new ObjectId(personalPackageId), phone,
    });
    if (!pkg) return res.status(404).json({ error: "חבילה אישית לא נמצאה" });

    const now         = new Date();
    const pkgKey      = `personal_${personalPackageId}`;
    const pendingCoin = pkg.pendingContractCoin || null;
    const coinsToCredit = (pkg.coins ?? 0) + (pendingCoin?.coins || 0);

    const packageEntry = {
      key:         pkgKey,
      name:        pkg.name,
      purchasedAt: now.toISOString(),
      items:       pkg.items ?? {},
      coins:       coinsToCredit,
      status:      "waiting_brief",
    };

    const tokenInfo  = data.TokenInfo;
    const txnInfo    = data.TranzactionInfo;
    const tokenUpdate = {};
    if (tokenInfo?.Token) {
      const month = String(tokenInfo.CardMonth).padStart(2, "0");
      const year  = String(tokenInfo.CardYear).slice(-2);
      tokenUpdate.paymentToken  = tokenInfo.Token;
      tokenUpdate.paymentExpiry = month + year;
      tokenUpdate.paymentLast4  = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
    }

    await getDB().collection(USERS_COL).updateOne(
      { phone },
      {
        $set:  { activePackage: packageEntry, ...tokenUpdate },
        $push: { purchasedPackages: packageEntry },
        $inc:  { coins: coinsToCredit },
      },
      { upsert: false },
    );

    const pkgUpdate = { purchased: true, purchasedAt: now };
    if (pendingCoin) {
      pkgUpdate.contractCoinPackage = { ...pendingCoin, purchasedAt: now };
      pkgUpdate.pendingContractCoin = null;
    }
    await getDB().collection("personal_packages").updateOne(
      { _id: new ObjectId(personalPackageId) },
      { $set: pkgUpdate },
    );

    /* Subscription package → record the recurring subscription so the monthly
       renewal job can charge the tokenized card. Best-effort. */
    if (pkg.isSubscription && tokenUpdate.paymentToken) {
      try {
        await require("../services/webinar-subscription.service").recordSubscription({
          phone, personalPackageId, pkg,
          token: tokenUpdate.paymentToken,
          cardExpiry: tokenUpdate.paymentExpiry,
          last4: tokenUpdate.paymentLast4,
        });
      } catch (subErr) {
        console.warn("[Packages] recordSubscription failed:", subErr.message);
      }
    }

    const totalAmount = (pkg.finalPrice || 0) + (pendingCoin?.price || 0);
    await getDB().collection(TRANS_COL).insertOne({
      lowProfileId, phone, personalPackageId,
      packageName: pkg.name, amount: totalAmount,
      coinsGranted: coinsToCredit,
      coinPackageId: pendingCoin?.key || null,
      source: "mobile_personal", createdAt: now,
    });

    try {
      const items = pkg.items || {};
      await getDB().collection("cpanel_pending_purchases").insertOne({
        phone, lowProfileId,
        kind:              "package",
        packageKey:        pkgKey,
        description:       pkg.name,
        name:              pkg.name,
        adsCount:             Number(items.paidAds    ?? items.ad         ?? 0) || 0,
        socialAdsCount:       Number(items.organicAds ?? items.social_ad  ?? 0) || 0,
        videosCount:          Number(items.videos     ?? items.video      ?? 0) || 0,
        landingPagesCount:    Number(items.lps        ?? items.lp         ?? 0) || 0,
        logosCount:           Number(items.logos      ?? items.logo       ?? 0) || 0,
        campaignTrafficCount: Number(items.campaign_traffic ?? items.campaignTraffic ?? 0) || 0,
        campaignLeadsCount:   Number(items.campaign_leads   ?? items.campaignLeads   ?? 0) || 0,
        coinsOverride:     coinsToCredit,
        totalAmount:       pkg.finalPrice,
        source:            "mobile_personal",
        createdAt:         now,
        completedAt:       now,
      });
    } catch (e) {
      console.warn("[Packages] cpanel_pending_purchases insert failed (personal):", e.message);
    }

    console.log(`[Packages] ✅ Personal package activated: ${phone} → ${pkg.name} (+${coinsToCredit} coins)`);
    createReceipt({ phone, type: "package", description: pkg.name, amount: pkg.finalPrice, coinsGranted: coinsToCredit, source: "mobile_personal", lowProfileId }).catch(() => {});

    require("../services/wow-manager-notify.service")
      .notifyManagerOfPurchase({
        clientPhone: phone, businessName: null,
        packageName: pkg.name, amount: pkg.finalPrice, coinsGranted: coinsToCredit,
      })
      .catch(e => console.warn("[Packages] notifyManager (personal) failed:", e.message));

    // Fire purchase webhook — fire-and-forget
    Promise.resolve().then(async () => {
      const clientMapping = await getDB().collection("cpanel_clients").findOne(
        { phone },
        { projection: { agentId: 1 } },
      );
      const agentDoc = clientMapping?.agentId
        ? await getDB().collection("agents").findOne(
            { _id: clientMapping.agentId },
            { projection: { name: 1, nickname: 1, email: 1, phone: 1 } },
          )
        : null;
      return sendPurchaseWebhook({
        event:     "purchase_success",
        source:    "mobile_personal",
        timestamp: new Date().toISOString(),
        client: { phone, name: null, businessName: null },
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
        payment: {
          lowProfileId,
          last4: txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "") || null,
          expDate: tokenInfo ? (String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2)) : null,
        },
      });
    }).catch(err => console.warn("[Packages] purchase webhook (personal) failed:", err.message));

    res.json({ success: true, packageName: pkg.name, coinsGranted: coinsToCredit });
  } catch (err) {
    console.error("[Packages] verifyPersonalPayment:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/contract-debug?phone=XXX&pkgId=YYY ──────────────── */
// Diagnostic endpoint — shows exactly what items the package has and which rules fire.
exports.contractDebug = async (req, res) => {
  try {
    const { phone, pkgId } = req.query;
    if (!phone || !pkgId) return res.status(400).json({ error: "phone and pkgId required" });
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(pkgId)) return res.status(400).json({ error: "invalid pkgId" });

    const pkg = await getDB().collection("personal_packages").findOne({ _id: new ObjectId(pkgId), phone });
    if (!pkg) return res.status(404).json({ error: "package not found" });

    const contractRules = await fetchContractRules();

    // Run the same normalization as the contract
    const { normalizeItems: _ni, applyRules: _ar } = (() => {
      // inline mini versions matching pdf-contract.service.js
      function normalizeItems(items) {
        const out = { ...items };
        const setIfMissing = (target, sources) => {
          if (Number(out[target] ?? 0) > 0) return;
          for (const s of sources) { const v = Number(out[s] ?? 0); if (v > 0) { out[target] = v; return; } }
        };
        setIfMissing("ad",         ["paidAds"]);
        setIfMissing("lp",         ["lps"]);
        setIfMissing("social_ad",  ["organicAds", "socialAd"]);
        setIfMissing("ad_lead_10", ["campaignLeads", "campaign_leads"]);
        setIfMissing("ad_10",      ["campaignTraffic", "campaign_traffic"]);
        return out;
      }
      function applyRules(rawItems, rules, alreadyAdded = new Set()) {
        const items = normalizeItems(rawItems);
        const has = k => Number(items[k] ?? 0) > 0;
        const matching = (rules || []).filter(r => (r.conditions || []).length > 0 && r.conditions.every(k => has(k)));
        const condSets = matching.map(r => new Set(r.conditions));
        const seen = new Set([...alreadyAdded]);
        const pages = [];
        for (let i = 0; i < matching.length; i++) {
          const mySet = condSets[i];
          const superseded = condSets.some((o, j) => j !== i && o.size > mySet.size && [...mySet].every(k => o.has(k)));
          if (superseded) continue;
          for (const p of (matching[i].pages || [])) { if (!seen.has(p)) { seen.add(p); pages.push(p); } }
        }
        return pages;
      }
      return { normalizeItems, applyRules };
    })();

    const rawItems = pkg.items || {};
    const normalizedItems = _ni(rawItems);
    const EARLY_KEYS = new Set(["ad_10","ad_lead_10","social_ad_10","web_cmp","lead_cmp","social_cmp","ad","social_ad","organicAds"]);
    const earlyRules = contractRules.filter(r => r.conditions && r.conditions.every(k => EARLY_KEYS.has(k)));
    const lateRules  = contractRules.filter(r => r.conditions && !r.conditions.every(k => EARLY_KEYS.has(k)));
    const hardcodedAdded = new Set();
    if (Number(normalizedItems.ad ?? 0) > 0) hardcodedAdded.add("11b_variable_ad.png");
    const earlyPages = _ar(rawItems, earlyRules, hardcodedAdded);
    const latePages  = _ar(rawItems, lateRules, new Set([...hardcodedAdded, ...earlyPages]));

    res.json({
      packageName: pkg.name,
      rawItems,
      normalizedItems,
      contractRulesCount: contractRules.length,
      earlyRulesCount: earlyRules.length,
      lateRulesCount: lateRules.length,
      earlyPagesWouldAppear: earlyPages,
      latePagesWouldAppear: latePages,
      totalPagesInContract: ["01_cover.png", "after_cover.png", ...(Number(normalizedItems.ad ?? 0) > 0 ? ["11b_variable_ad.png"] : []), ...earlyPages, ...latePages, "PRICING_TABLE", "17_signature.png", "end_1.png", "end_2.png", "end_3.png", "end_4.png", "end_5.png"],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/contract-html ──────────────────────────────────── */
// Returns the contract HTML for WebView preview (unsigned or signed).
exports.contractHtml = async (req, res) => {
  try {
    const { phone, personalPackageId, signerName, signatureBase64, pageName: pageNameOverride,
            clientEmail: bodyEmail, clientVatId: bodyVatId, selectedCoinPackageId } = req.body;
    if (!phone || !personalPackageId) return res.status(400).json({ error: "חסרים phone / personalPackageId" });

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) return res.status(400).json({ error: "personalPackageId לא תקין" });

    const [pkg, user, fbCustomer] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(personalPackageId), phone }),
      getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1, businessName: 1 } }),
      getCustomerByPhone(phone).catch(e => { console.warn("[Contract] getCustomerByPhone failed:", e.message); return null; }),
    ]);
    if (!pkg) return res.status(404).json({ error: "חבילה לא נמצאה" });

    const pageName     = pageNameOverride || pkg.clientName || fbCustomer?.invoiceName || user?.businessName || user?.name || phone;
    const clientEmail  = bodyEmail?.trim() || pkg.clientEmail  || fbCustomer?.email || "";
    const clientVatId  = bodyVatId?.trim() || pkg.clientVatId  || fbCustomer?.vatId || "";

    console.log("[Contract] Fireberry raw:", JSON.stringify({
      accountid:   fbCustomer?.accountid,
      accountname: fbCustomer?.accountname,
      invoiceName: fbCustomer?.invoiceName,
      vatId:       fbCustomer?.vatId,
      email:       fbCustomer?.email,
    }));
    console.log("[Contract] Resolved → pageName:", pageName, "| email:", clientEmail, "| vatId:", clientVatId);

    const [catalogItems, manualCoinPkg, contractRules, allProducts, docNames, alwaysPages] = await Promise.all([
      listAll().then(all => all.items || []).catch(() => []),
      selectedCoinPackageId
        ? getDB().collection("coin_packages").findOne({ packageId: selectedCoinPackageId }).catch(() => null)
        : Promise.resolve(null),
      fetchContractRules(),
      // Only fetch coin catalog when pkg.coins===0 and no manual selection
      (!selectedCoinPackageId && (pkg.coins || 0) === 0)
        ? listAll().then(all => all.coins || []).catch(() => [])
        : Promise.resolve([]),
      // Read doc names from Atlas — it always has the latest storageUrls from both servers
      (DB._fallbackDb || getDB()).collection("contract_doc_names").find({}, { projection: { fileName: 1, storageUrl: 1 } }).toArray().catch(() => []),
      fetchAlwaysPages(),
    ]);

    // Map of fileName → Backblaze URL for files stored outside local disk
    const storageUrlMap = new Map(docNames.filter(d => d.storageUrl).map(d => [d.fileName, d.storageUrl]));

    // Determine which coin package data to use for the pricing table row:
    // 1. Manager explicitly picked one (selectedCoinPackageId)
    // 2. Client already purchased one via the contract (contractCoinPackage)
    // 3. Neither — show the inline selector (selectorCoinPackages)
    // pendingContractCoin = client selected but not yet paid — pass as pre-selection hint, not as coinPackageData
    const contractCoinPkg   = (!selectedCoinPackageId && (pkg.coins || 0) === 0) ? (pkg.contractCoinPackage ?? null) : null;
    const coinPackageData   = manualCoinPkg || contractCoinPkg || null;
    const selectorCoinPackages = (!coinPackageData && (pkg.coins || 0) === 0 && !pkg.purchased)
      ? allProducts.filter(p => p.active !== false)
      : [];

    // Always derive from request host — BASE_URL/SERVER_BASE_URL are for payment callbacks only
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${proto}://${req.get("host")}`;
    const html = buildContractViewHtml(
      pkg, baseUrl, catalogItems,
      signerName || null, signatureBase64 || null, pageName, phone, clientEmail, clientVatId, coinPackageData, contractRules, selectorCoinPackages,
      storageUrlMap, alwaysPages,
    );

    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error("[Packages] contractHtml:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/contract-view ───────────────────────────────────── */
/* Public, unauthenticated GET version of contractHtml — accepts phone +
   personalPackageId via query string and returns the contract HTML.
   Used as the destination of SMS links sent to clients ("שלח לחתימה
   ב-SMS"); the client opens the URL on their phone and can sign without
   any login flow. Implementation: shim req.body from req.query and
   delegate to the existing contractHtml handler so we never drift from
   the canonical rendering logic. */
exports.contractView = (req, res) => {
  req.body = {
    phone:             req.query.phone,
    personalPackageId: req.query.pkgId || req.query.personalPackageId,
  };
  return exports.contractHtml(req, res);
};

/* ── POST /api/packages/contract-save-coin ──────────────────────────────── */
// Saves the client's coin selection to the personal package without charging.
// The selection is then picked up by purchasePersonalIframe when the app processes payment.
exports.contractSaveCoin = async (req, res) => {
  try {
    const { phone, personalPackageId, coinPackageId } = req.body || {};
    if (!phone || !personalPackageId || !coinPackageId) {
      return res.status(400).json({ error: "חסרים phone, personalPackageId ו-coinPackageId" });
    }

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ error: "personalPackageId לא תקין" });
    }

    const [pkg, coinPkg] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(personalPackageId), phone, active: true }),
      getDB().collection("cpanel_products").findOne({ key: coinPackageId, kind: "coins", active: { $ne: false } }),
    ]);

    if (!pkg)    return res.status(404).json({ error: "חבילה אישית לא נמצאה" });
    if (!coinPkg) return res.status(404).json({ error: "חבילת מטבעות לא נמצאה" });

    await getDB().collection("personal_packages").updateOne(
      { _id: new ObjectId(personalPackageId) },
      {
        $set: {
          pendingContractCoin: {
            key:   coinPkg.key,
            name:  coinPkg.name,
            price: coinPkg.price,
            coins: coinPkg.coins,
          },
        },
      },
      { upsert: false },
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[Packages] contractSaveCoin:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── POST /api/packages/contract-pay ────────────────────────────────────── */
// One combined Cardcom session for the personal package + optional coin add-on.
// No agent auth — validated by phone + personalPackageId ownership.
exports.contractPay = async (req, res) => {
  try {
    const { phone, personalPackageId, coinPackageId } = req.body || {};
    if (!phone || !personalPackageId) {
      return res.status(400).json({ error: "חסרים phone ו-personalPackageId" });
    }

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ error: "personalPackageId לא תקין" });
    }

    const [pkg, coinPkg, user] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(personalPackageId), phone, active: true }),
      coinPackageId
        ? getDB().collection("cpanel_products").findOne({ key: coinPackageId, kind: "coins", active: { $ne: false } })
        : Promise.resolve(null),
      getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } }),
    ]);

    if (!pkg) return res.status(404).json({ error: "חבילה אישית לא נמצאה" });
    if (pkg.purchased) return res.status(400).json({ error: "החבילה כבר שולמה" });
    if (coinPackageId && !coinPkg) return res.status(404).json({ error: "חבילת מטבעות לא נמצאה" });

    const baseUrl    = requiredEnv("SERVER_BASE_URL");
    const clientName = user?.name || phone;
    const combined   = (pkg.finalPrice || 0) + (coinPkg?.price || 0);
    /* subscriptions bill the exact price; priceIncludesVat packages add VAT
       only on the coin add-on (their own price is final) */
    const amountWithVat = pkg.isSubscription === true
      ? combined
      : pkg.priceIncludesVat === true
        ? (pkg.finalPrice || 0) + withVAT(coinPkg?.price || 0)
        : withVAT(combined);

    const successUrl = `${baseUrl}/api/packages/contract-pay-success?phone=${encodeURIComponent(phone)}&pkgId=${personalPackageId}${coinPackageId ? `&coinKey=${encodeURIComponent(coinPackageId)}` : ""}`;

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         amountWithVat,
      /* charge in the package currency (2=USD, 1=ILS) — a USD one-time offer
         must not be billed in shekels */
      ISOCoinId:      pkg.currencyCode ?? 1,
      ProductName:    pkg.name,
      SuccessRedirectUrl: successUrl,
      ErrorRedirectUrl:   `${baseUrl}/api/packages/contract-pay-success?phone=${encodeURIComponent(phone)}&pkgId=${personalPackageId}&failed=1`,
      NotifyURL: `${baseUrl}/api/packages/payment-notify?phone=${encodeURIComponent(phone)}&personalPackageId=${personalPackageId}`,
      ReturnValue: `${phone}|contract_pay|${personalPackageId}${coinPackageId ? `|${coinPackageId}` : ""}`,
      CreateInvoice: false, IsCreateToken: false, Operation: 1,
      /* Bit only supports ILS */
      IsApplePay: true, IsBit: (pkg.currencyCode ?? 1) === 1, IsGooglePay: true,
      CustomerName: clientName, PhoneNumber: phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl   = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await getDB().collection(PENDING_COL).insertOne({
        lowProfileId, phone, personalPackageId,
        coinPackageId:   coinPkg?.key || null,
        coinPackageName: coinPkg?.name || null,
        coinPackageCoins: coinPkg?.coins || 0,
        packageName:     pkg.name,
        amount:          combined,
        amountWithVat,
        coins:           pkg.coins ?? 0,
        source:          "contract_pay",
        createdAt:       new Date(),
      });
    }

    res.json({ success: true, iframeUrl: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Packages] contractPay:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/contract-pay-success ─────────────────────────────── */
// Cardcom redirect after combined contract payment.
exports.contractPaySuccess = async (req, res) => {
  const { phone, pkgId, coinKey, lowProfileId, failed } = req.query;

  const failHtml = (msg = "התשלום נכשל, אנא נסה שוב.") => `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff8f8;color:#b91c1c;font-size:18px;text-align:center;padding:20px}</style>
</head><body><p>${msg}</p></body></html>`;

  if (failed === "1" || !phone || !pkgId) {
    return res.set("Content-Type", "text/html; charset=utf-8").send(failHtml());
  }

  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(pkgId)) return res.set("Content-Type", "text/html").send(failHtml("מזהה חבילה לא תקין"));

    // Idempotency check — a "crediting" row is an interrupted attempt to resume, not a finished one
    const existingTx = await getDB().collection(TRANS_COL).findOne({ phone, personalPackageId: pkgId, source: "contract_pay", status: { $ne: "crediting" } });
    if (existingTx) return res.set("Content-Type", "text/html; charset=utf-8").send(contractPaySuccessHtml());

    /* Everything below comes from the pending row this server wrote when it
       created the Cardcom page — never from the public query string, which a
       client could edit to add a coin pack or point at another payment. */
    const pending = await getDB().collection(PENDING_COL).findOne(
      { phone, personalPackageId: pkgId, source: "contract_pay", ...(lowProfileId ? { lowProfileId: String(lowProfileId) } : {}) },
      { sort: { createdAt: -1 } },
    );
    const lpId = pending?.lowProfileId;
    if (!lpId) return res.set("Content-Type", "text/html").send(failHtml("לא נמצא מזהה תשלום"));
    const paidCoinKey = pending.coinPackageId || null;

    if (await purchaseSync.paymentState(getDB(), lpId) === "done") {
      return res.set("Content-Type", "text/html; charset=utf-8").send(contractPaySuccessHtml());
    }

    // Verify with Cardcom
    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName:        cardcomConfig.apiName,
        ApiPassword:    cardcomConfig.apiPassword,
        LowProfileId:   lpId,
      },
    );
    const data = verifyRes.data;
    if (!data || data.ResponseCode !== 0) {
      return res.set("Content-Type", "text/html").send(failHtml(data?.Description || "התשלום לא אושר"));
    }

    // the page Cardcom confirmed must be the one issued for this package (+ coin pack)
    const expectedReturn = `${phone}|contract_pay|${pkgId}${paidCoinKey ? `|${paidCoinKey}` : ""}`;
    if (data.ReturnValue && data.ReturnValue !== expectedReturn) {
      console.warn(`[Packages] contractPaySuccess: ReturnValue mismatch for ${lpId}`);
      return res.set("Content-Type", "text/html").send(failHtml("פרטי התשלום אינם תואמים"));
    }

    const [pkg, coinPkg] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(pkgId), phone }),
      paidCoinKey
        ? getDB().collection("cpanel_products").findOne({ key: paidCoinKey, kind: "coins" })
        : Promise.resolve(null),
    ]);
    if (!pkg) return res.set("Content-Type", "text/html").send(failHtml("חבילה לא נמצאה"));

    const now = new Date();
    const pkgKey       = `personal_${pkgId}`;
    const pkgCoins     = pkg.coins ?? 0;
    const coinPkgCoins = coinPkg?.coins ?? 0;
    const totalCoins   = pkgCoins + coinPkgCoins;

    const packageEntry = {
      key: pkgKey, name: pkg.name,
      purchasedAt: now.toISOString(),
      items: pkg.items ?? {}, coins: pkgCoins, status: "waiting_brief",
      lowProfileId: lpId,
    };

    const tokenInfo = data.TokenInfo;
    const txnInfo   = data.TranzactionInfo;
    const tokenUpdate = {};
    if (tokenInfo?.Token) {
      tokenUpdate.paymentToken  = tokenInfo.Token;
      tokenUpdate.paymentExpiry = String(tokenInfo.CardMonth).padStart(2, "0") + String(tokenInfo.CardYear).slice(-2);
      tokenUpdate.paymentLast4  = txnInfo?.Last4CardDigitsString || String(txnInfo?.Last4CardDigits || "");
    }

    const combinedAmount = (pkg.finalPrice || 0) + (coinPkg?.price || 0);
    // lock before crediting — crash-safe order in services/purchase-sync.service.js
    const lock = await purchaseSync.lockPayment(getDB(), lpId, {
      phone, personalPackageId: pkgId,
      packageName: pkg.name, amount: combinedAmount,
      coinsGranted: totalCoins,
      coinPackageId: coinPkg?.key || null,
      source: "contract_pay",
    });
    if (lock === "done") return res.set("Content-Type", "text/html; charset=utf-8").send(contractPaySuccessHtml());

    // lead-born clients have no users doc — creditUserOnce creates it
    await purchaseSync.creditUserOnce(getDB(), phone, lpId, {
      $set:  { activePackage: packageEntry, ...tokenUpdate },
      $push: { purchasedPackages: packageEntry },
      $inc:  { coins: totalCoins },
    });

    const pkgUpdate = { purchased: true, purchasedAt: now };
    if (coinPkg) {
      pkgUpdate.contractCoinPackage = {
        packageId:   coinPkg.key,
        name:        coinPkg.name,
        coins:       coinPkgCoins,
        price:       coinPkg.price,
        purchasedAt: now,
      };
    }
    await getDB().collection("personal_packages").updateOne(
      { _id: new ObjectId(pkgId) },
      { $set: pkgUpdate },
    );

    // the panel revenue ledger (dashboard, "הוצאה"/"עסקאות", טופ מנהלים) and the lead board
    await purchaseSync.recordRevenue(getDB(), {
      lowProfileId: lpId, phone,
      fields: {
        kind: "package", source: "contract_pay", personalPackageId: pkgId, packageKey: pkgKey,
        packageName: pkg.name, description: pkg.name, name: pkg.name, totalAmount: combinedAmount,
      },
    });
    await purchaseSync.markLeadsActive(getDB(), phone);

    if (await purchaseSync.markPaymentDone(getDB(), lpId)) {
      createReceipt({ phone, type: "package", description: pkg.name, amount: combinedAmount, coinsGranted: totalCoins, source: "contract_pay", lowProfileId: lpId }).catch(() => {});

      require("../services/wow-manager-notify.service")
        .notifyManagerOfPurchase({ clientPhone: phone, businessName: null, packageName: pkg.name, amount: combinedAmount, coinsGranted: totalCoins })
        .catch(e => console.warn("[Packages] notifyManager (contract_pay) failed:", e.message));

      console.log(`[Packages] ✅ Contract paid: ${phone} → ${pkg.name} (+${totalCoins} coins)`);
    }
    return res.set("Content-Type", "text/html; charset=utf-8").send(contractPaySuccessHtml());
  } catch (err) {
    console.error("[Packages] contractPaySuccess:", err.message);
    return res.set("Content-Type", "text/html").send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"></head><body style="font-family:Arial;text-align:center;padding:40px;color:#b91c1c"><p>שגיאת שרת, נסה שוב מאוחר יותר</p></body></html>`);
  }
};

function contractPaySuccessHtml() {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;color:#166534;font-size:18px;text-align:center;gap:12px;padding:20px}</style>
</head><body>
<div style="font-size:48px">✅</div>
<p style="font-weight:700">התשלום הושלם בהצלחה!</p>
<p style="font-size:14px;color:#4b5563">החבילה שלך פעילה. ניתן לסגור חלון זה</p>
<script>
try { window.parent.postMessage({ type: 'CONTRACT_PAID' }, '*'); } catch(e){}
try { window.opener && window.opener.postMessage({ type: 'CONTRACT_PAID' }, '*'); } catch(e){}
setTimeout(function(){ try { window.close(); } catch(e){} }, 2500);
</script>
</body></html>`;
}

/* ── POST /api/packages/contract-coins-iframe ───────────────────────────── */
// Creates a Cardcom payment session for a coin package selected inside the contract.
// No agent auth — validated by phone + personalPackageId ownership.
exports.contractCoinsIframe = async (req, res) => {
  try {
    const { phone, personalPackageId, coinPackageId } = req.body || {};
    if (!phone || !personalPackageId || !coinPackageId) {
      return res.status(400).json({ error: "חסרים phone, personalPackageId ו-coinPackageId" });
    }

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ error: "personalPackageId לא תקין" });
    }

    const [pkg, coinPkg, user] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(personalPackageId), phone }),
      getDB().collection("cpanel_products").findOne({ key: coinPackageId, kind: "coins", active: { $ne: false } }),
      getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1 } }),
    ]);

    if (!pkg)    return res.status(404).json({ error: "חבילה אישית לא נמצאה" });
    if (!coinPkg) return res.status(404).json({ error: "חבילת מטבעות לא נמצאה" });
    if ((pkg.coins || 0) > 0) return res.status(400).json({ error: "החבילה כבר כוללת מטבעות" });

    const baseUrl      = requiredEnv("SERVER_BASE_URL");
    const clientName   = user?.name || phone;
    const amountWithVat = withVAT(coinPkg.price);

    const successUrl = `${baseUrl}/api/packages/contract-coins-success?phone=${encodeURIComponent(phone)}&pkgId=${personalPackageId}&coinKey=${encodeURIComponent(coinPackageId)}`;

    const cardcomRes = await axios.post(cardcomConfig.apiUrl, {
      TerminalNumber: cardcomConfig.terminal,
      ApiName:        cardcomConfig.apiName,
      ApiPassword:    cardcomConfig.apiPassword,
      Amount:         amountWithVat,
      ISOCoinId:      1,
      ProductName:    coinPkg.name,
      SuccessRedirectUrl: successUrl,
      ErrorRedirectUrl:   `${baseUrl}/api/packages/contract-coins-success?phone=${encodeURIComponent(phone)}&pkgId=${personalPackageId}&coinKey=${encodeURIComponent(coinPackageId)}&failed=1`,
      NotifyURL: `${baseUrl}/api/packages/payment-notify?phone=${encodeURIComponent(phone)}&coinPackageId=${encodeURIComponent(coinPackageId)}`,
      ReturnValue:    `${phone}|contract_coins|${personalPackageId}|${coinPackageId}`,
      CreateInvoice:  false,
      IsCreateToken:  false,
      Operation:      1,
      IsApplePay:     true,
      IsBit:          true,
      IsGooglePay:    true,
      CustomerName:   clientName,
      PhoneNumber:    phone,
    });

    if (cardcomRes.data.ResponseCode !== 0) {
      throw new Error(cardcomRes.data.Description || "שגיאה ביצירת דף תשלום");
    }

    const paymentUrl   = cardcomRes.data.Url;
    const lowProfileId = cardcomRes.data.LowProfileId || cardcomRes.data.lowProfileId;

    if (lowProfileId) {
      await getDB().collection(PENDING_COL).insertOne({
        lowProfileId,
        phone,
        personalPackageId,
        coinPackageId,
        coinPackageName: coinPkg.name,
        coinPackageCoins: coinPkg.coins,
        amount:      coinPkg.price,
        amountWithVat,
        source:      "contract_coins",
        createdAt:   new Date(),
      });
    }

    res.json({ success: true, iframeUrl: paymentUrl, lowProfileId });
  } catch (err) {
    console.error("[Packages] contractCoinsIframe:", err.message);
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /api/packages/contract-coins-success ───────────────────────────── */
// Cardcom redirect target after coin purchase from within the contract.
// Returns small HTML that sends postMessage to parent and shows success/failure.
exports.contractCoinsSuccess = async (req, res) => {
  const { phone, pkgId, coinKey, lowProfileId, failed } = req.query;

  const failHtml = (msg = "התשלום נכשל, אנא נסה שוב.") => `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff8f8;color:#b91c1c;font-size:18px;text-align:center;padding:20px}</style>
</head><body><p>${msg}</p></body></html>`;

  if (failed === "1" || !phone || !pkgId || !coinKey) {
    return res.set("Content-Type", "text/html; charset=utf-8").send(failHtml());
  }

  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(pkgId)) return res.set("Content-Type", "text/html").send(failHtml("מזהה חבילה לא תקין"));

    const existingTx = await getDB().collection(TRANS_COL).findOne({ lowProfileId: lowProfileId || "", source: "contract_coins", status: { $ne: "crediting" } });
    if (existingTx) {
      return res.set("Content-Type", "text/html; charset=utf-8").send(successHtml());
    }

    // Verify with Cardcom using the pending record (lowProfileId may come from query or pending lookup)
    // server-written pending row only — the query string is public and editable
    const pendingRecord = await getDB().collection(PENDING_COL).findOne({
      phone, personalPackageId: pkgId, source: "contract_coins",
      ...(lowProfileId ? { lowProfileId: String(lowProfileId) } : { coinPackageId: coinKey }),
    }, { sort: { createdAt: -1 } });

    const lpId = pendingRecord?.lowProfileId;
    if (!lpId) return res.set("Content-Type", "text/html").send(failHtml("לא נמצא מזהה תשלום"));
    const paidCoinKey = pendingRecord.coinPackageId;

    if (await purchaseSync.paymentState(getDB(), lpId) === "done") {
      return res.set("Content-Type", "text/html; charset=utf-8").send(successHtml());
    }

    const verifyRes = await axios.post(
      "https://secure.cardcom.solutions/api/v11/LowProfile/GetLpResult",
      {
        TerminalNumber: cardcomConfig.terminal,
        ApiName:        cardcomConfig.apiName,
        ApiPassword:    cardcomConfig.apiPassword,
        LowProfileId:   lpId,
      },
    );

    const data = verifyRes.data;
    if (!data || data.ResponseCode !== 0) {
      return res.set("Content-Type", "text/html").send(failHtml(data?.Description || "התשלום לא אושר"));
    }

    if (data.ReturnValue && data.ReturnValue !== `${phone}|contract_coins|${pkgId}|${paidCoinKey}`) {
      console.warn(`[Packages] contractCoinsSuccess: ReturnValue mismatch for ${lpId}`);
      return res.set("Content-Type", "text/html").send(failHtml("פרטי התשלום אינם תואמים"));
    }

    const coinPkg = await getDB().collection("cpanel_products").findOne({ key: paidCoinKey, kind: "coins" });
    if (!coinPkg) return res.set("Content-Type", "text/html").send(failHtml("חבילת מטבעות לא נמצאה"));

    const now = new Date();
    const coinsToGrant = coinPkg.coins || 0;

    const lock = await purchaseSync.lockPayment(getDB(), lpId, {
      phone, personalPackageId: pkgId, coinPackageId: paidCoinKey,
      coinPackageName: coinPkg.name, coinsGranted: coinsToGrant,
      amount: coinPkg.price, source: "contract_coins",
    });
    if (lock === "done") return res.set("Content-Type", "text/html; charset=utf-8").send(successHtml());

    await purchaseSync.creditUserOnce(getDB(), phone, lpId, { $inc: { coins: coinsToGrant } });
    await getDB().collection("personal_packages").updateOne(
      { _id: new ObjectId(pkgId) },
      {
        $set: {
          contractCoinPackage: {
            packageId:   coinPkg.key,
            name:        coinPkg.name,
            coins:       coinsToGrant,
            price:       coinPkg.price,
            purchasedAt: now,
          },
        },
      },
    );
    // a coin add-on is revenue too — dashboard + "הוצאה"/"עסקאות"
    await purchaseSync.recordRevenue(getDB(), {
      lowProfileId: lpId, phone,
      fields: {
        kind: "coins", source: "contract_coins", personalPackageId: pkgId, coinPackageId: paidCoinKey,
        packageName: coinPkg.name, description: coinPkg.name, name: coinPkg.name, totalAmount: coinPkg.price,
      },
    });

    if (await purchaseSync.markPaymentDone(getDB(), lpId)) {
      createReceipt({ phone, type: "coins", description: coinPkg.name, amount: coinPkg.price, coinsGranted: coinsToGrant, source: "contract_coins", lowProfileId: lpId }).catch(() => {});
      console.log(`[Packages] ✅ Contract coins purchased: ${phone} → ${coinPkg.name} (+${coinsToGrant} coins)`);
    }
    return res.set("Content-Type", "text/html; charset=utf-8").send(successHtml());
  } catch (err) {
    console.error("[Packages] contractCoinsSuccess:", err.message);
    return res.set("Content-Type", "text/html").send(failHtml("שגיאת שרת, נסה שוב מאוחר יותר"));
  }
};

function successHtml() {
  return `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0fdf4;color:#166534;font-size:18px;text-align:center;gap:12px;padding:20px}</style>
</head><body>
<div style="font-size:48px">✅</div>
<p style="font-weight:700">הרכישה הושלמה בהצלחה!</p>
<p style="font-size:14px;color:#4b5563">ניתן לסגור חלון זה</p>
<script>
try { window.parent.postMessage({ type: 'COINS_PURCHASED' }, '*'); } catch(e){}
try { window.opener && window.opener.postMessage({ type: 'COINS_PURCHASED' }, '*'); } catch(e){}
setTimeout(function(){ try { window.close(); } catch(e){} }, 2000);
</script>
</body></html>`;
}

/* ── POST /api/packages/submit-contract-signature ───────────────────────── */
exports.submitContractSignature = async (req, res) => {
  try {
    const { phone, personalPackageId, signerName, signatureBase64,
            clientEmail: bodyEmail, clientVatId: bodyVatId, selectedCoinPackageId } = req.body;
    if (!phone || !personalPackageId || !signatureBase64) {
      return res.status(400).json({ success: false, message: "שדות חסרים" });
    }

    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(personalPackageId)) {
      return res.status(400).json({ success: false, message: "מזהה חבילה לא תקין" });
    }

    // Fetch package + user + Fireberry in parallel
    const [pkg, user, fbCustomer] = await Promise.all([
      getDB().collection("personal_packages").findOne({ _id: new ObjectId(personalPackageId), phone }),
      getDB().collection(USERS_COL).findOne({ phone }, { projection: { name: 1, businessName: 1 } }),
      getCustomerByPhone(phone).catch(e => { console.warn("[Contract] getCustomerByPhone failed:", e.message); return null; }),
    ]);
    if (!pkg) return res.status(404).json({ success: false, message: "חבילה לא נמצאה" });

    const pageName    = pkg.clientName  || fbCustomer?.invoiceName || user?.businessName || user?.name || phone;
    const clientEmail = bodyEmail?.trim() || pkg.clientEmail || fbCustomer?.email || "";
    const clientVatId = bodyVatId?.trim() || pkg.clientVatId || fbCustomer?.vatId || "";

    // Fetch catalog items + optional coin package upsell in parallel
    const [catalogItems, coinPackageData, contractRules, pdfDocNames, pdfAlwaysPages] = await Promise.all([
      listAll().then(all => all.items || []).catch(() => []),
      selectedCoinPackageId
        ? getDB().collection("coin_packages").findOne({ packageId: selectedCoinPackageId }).catch(() => null)
        : Promise.resolve(null),
      fetchContractRules(),
      // Read doc names from Atlas — it always has the latest storageUrls from both servers
      (DB._fallbackDb || getDB()).collection("contract_doc_names").find({}, { projection: { fileName: 1, storageUrl: 1 } }).toArray().catch(() => []),
      fetchAlwaysPages(),
    ]);

    const pdfStorageUrlMap = new Map(pdfDocNames.filter(d => d.storageUrl).map(d => [d.fileName, d.storageUrl]));

    // Generate PDF
    const pdfBuffer = await generateContractPdf(
      pkg, signerName, signatureBase64, pageName, phone, catalogItems, clientEmail, clientVatId, coinPackageData, contractRules, pdfStorageUrlMap, pdfAlwaysPages,
    );

    // Upload to Backblaze
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const b2Path = `contracts/${phone}/${dd}${mm}${yyyy}kliq.pdf`;
    await uploadImage(b2Path, pdfBuffer, "application/pdf");
    const serverBase = requiredEnv("SERVER_BASE_URL");
    const pdfUrl = `${serverBase}/api/file?url=${encodeURIComponent(b2Path)}`;

    // Save contract record in DB
    const contractId = new ObjectId();
    await getDB().collection("signed_contracts").insertOne({
      _id:               contractId,
      phone,
      personalPackageId,
      signerName,
      packageName:       pkg.name,
      pdfUrl,
      signedAt:          now,
      createdAt:         now,
      ...(coinPackageData ? { coinPackageId: coinPackageData.packageId, coinPackageName: coinPackageData.name, coinPackagePrice: coinPackageData.price } : {}),
    });

    // Save contract URL on package — touch ONLY contractSigned fields, never active/purchased
    await getDB().collection("personal_packages").updateOne(
      { _id: new ObjectId(personalPackageId) },
      { $set: { contractSigned: true, contractSignedAt: now, contractUrl: pdfUrl } },
      { upsert: false },
    );

    // Fireberry — fire-and-forget: create Contract record (objecttype 28) + upload PDF
    (async () => {
      try {
        const FIREBERRY_BASE = "https://api.powerlink.co.il/api";
        const token = process.env.FIREBERRY_TOKEN;
        const orgId = process.env.FIREBERRY_Orgnization_ID;
        if (!token) { console.warn("[Fireberry] No FIREBERRY_TOKEN — skipping"); return; }
        const fbHeaders = { tokenid: token, ...(orgId ? { organizationid: orgId } : {}) };
        console.log("[Fireberry] Starting upload flow for phone:", phone, "| orgId:", orgId ?? "none");

        // 1. Find client by phone
        console.log("[Fireberry] Searching client by phone:", phone);
        const customer = await getCustomerByPhone(phone).catch(e => { console.warn("[Fireberry] Search error:", e.message); return null; });
        const accountId = customer?.accountid;
        if (!accountId) {
          console.warn("[Fireberry] Client not found for phone:", phone);
          return;
        }
        console.log("[Fireberry] Found accountId:", accountId);

        // 2. Create Contract record (objecttype 28) with proxy URL in pcfsystemfield100
        console.log("[Fireberry] Creating contract record for accountId:", accountId);
        const contractRes = await axios.post(
          `${FIREBERRY_BASE}/record/28`,
          { accountid: accountId, contractname: `הסכם אפליציה — ${pkg.name}`, pcfsystemfield100: pdfUrl },
          { headers: { ...fbHeaders, "Content-Type": "application/json" } },
        ).catch(e => { console.warn("[Fireberry] Create contract error:", e.message, e.response?.data); return null; });
        console.log("[Fireberry] Create contract response:", JSON.stringify(contractRes?.data));
        const fbContractId = contractRes?.data?.data?.Record?.contractid ?? contractRes?.data?.data?.contractid;
        if (!fbContractId) {
          console.warn("[Fireberry] Contract record creation returned no ID");
          return;
        }
        console.log("[Fireberry] Done — contractId:", fbContractId, "| url:", pdfUrl);
      } catch (e) {
        console.warn("[Packages] Fireberry upload failed:", e.message, e.response?.data);
      }
    })();

    res.json({ success: true, contractId: contractId.toString(), pdfUrl });
  } catch (err) {
    console.error("[Packages] submitContractSignature:", err.message);
    res.status(500).json({ success: false, message: "שגיאה ביצירת ההסכם" });
  }
};
