#!/usr/bin/env node
/**
 * grant-webinar-package.js
 * מעניק "חבילת וובינר" (3 מודעות ממומנות, 0 ש"ח) ללקוחות וובינר —
 * משקף 1:1 את מה ש-paymentConfirm של רכישת חבילה אישית עושה ב-DB:
 *   • users.activePackage + $push purchasedPackages
 *   • רשומת cpanel_pending_purchases שהושלמה (להיסטוריית החבילות במסך המוצרים)
 *
 * ברירת מחדל: תאריך הרכישה מוקדם ב-24 שעות, כדי שסשן המודעות שנוצר
 * מטופס הוובינר (לפני ההענקה) ייכנס לחלון הזמן של החבילה במסך המוצרים.
 *
 * לא נוגע בלקוח שכבר יש לו activePackage אמיתי (אלא אם --force).
 *
 * שימוש:
 *   node scripts/grant-webinar-package.js 0534358306                 (טלפון אחד או יותר)
 *   node scripts/grant-webinar-package.js --agent webinar            (כל לקוחות סוכן הוובינר)
 *   node scripts/grant-webinar-package.js --agent webinar --dry-run  (בדיקה בלי לשנות)
 *   node scripts/grant-webinar-package.js 05X... --force             (דריסה גם אם יש חבילה)
 *   node scripts/grant-webinar-package.js 05X... --coins 500         (גם מטבעות מתנה)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE   = process.argv.includes("--force");
const coinsIx = process.argv.indexOf("--coins");
const COINS   = coinsIx > -1 ? parseInt(process.argv[coinsIx + 1], 10) || 0 : 0;
const agentIx = process.argv.indexOf("--agent");
const AGENT   = agentIx > -1 ? process.argv[agentIx + 1] : null;
const PHONES  = process.argv.slice(2).filter(a => /^0\d{8,9}$/.test(a));

const PKG_NAME  = "חבילת וובינר";
const ADS_COUNT = 3;
/* backdated so the wow-ads session created by the webinar form (before this
   grant) falls inside the package's product-matching time window */
const PURCHASED_AT = new Date(Date.now() - 24 * 3600 * 1000);

function packageEntry() {
  return {
    key:         `personal_webinar_${crypto.randomBytes(4).toString("hex")}`,
    name:        PKG_NAME,
    purchasedAt: PURCHASED_AT.toISOString(),
    items: {
      paidAds:    ADS_COUNT,
      /* "ads" is the key the app's getPermissions checks (hasAdsAccess) —
         without it the client sees no ממומן section in the app */
      ads:        ADS_COUNT,
      organicAds: 0,
      videos:     0,
      lps:        0,
      logos:      0,
    },
    coins:  COINS,
    status: "sent_to_creation",
  };
}

async function connectBestAvailable() {
  if (process.env.AWS_MONGO_URI) {
    try {
      const c = new MongoClient(process.env.AWS_MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
      });
      await c.connect();
      console.log("✅ מחובר ל-AWS MongoDB");
      return c;
    } catch (e) {
      console.warn("⚠️  AWS MongoDB נכשל, מנסה Atlas:", e.message);
    }
  }
  const c = new MongoClient(process.env.MONGO_URI);
  await c.connect();
  console.log("✅ מחובר ל-MongoDB Atlas");
  return c;
}

async function run() {
  if (DRY_RUN) console.log("🔍 DRY RUN — לא מבוצעים שינויים\n");

  const client = await connectBestAvailable();
  const db = client.db();
  const usersCol   = db.collection("users");
  const pendingCol = db.collection("cpanel_pending_purchases");

  let phones = [...PHONES];
  if (AGENT) {
    const rows = await db.collection("cpanel_clients")
      .find({ agentName: AGENT }, { projection: { phone: 1 } })
      .toArray();
    phones.push(...rows.map(r => r.phone).filter(Boolean));
    console.log(`👥 נמצאו ${rows.length} לקוחות של הסוכן "${AGENT}"`);
  }
  phones = [...new Set(phones)];
  if (!phones.length) {
    console.error("❌ לא צוינו טלפונים. שימוש: node scripts/grant-webinar-package.js 05XXXXXXXX או --agent webinar");
    process.exit(1);
  }

  let granted = 0, skipped = 0, failed = 0;

  for (const phone of phones) {
    try {
      const user = await usersCol.findOne(
        { phone },
        { projection: { activePackage: 1, coins: 1 } },
      );

      if (user?.activePackage && !FORCE) {
        console.log(`  ⏭️  ${phone} — כבר יש חבילה (${user.activePackage.name || user.activePackage.key}) — מדלג (--force לדריסה)`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  📱 ${phone} — תוענק "${PKG_NAME}" (${ADS_COUNT} מודעות${COINS ? ` + ${COINS} מטבעות` : ""})${user ? "" : "  (משתמש חדש — ייווצר)"}`);
        granted++;
        continue;
      }

      const pkg = packageEntry();
      const accessAt = new Date();

      /* mirror of paymentConfirm: activePackage + purchasedPackages.
         Also grants free "גישה לממומן" — the campaign-access flags the app
         normally sets after a coin purchase (saveCampaignAccessPurchase). */
      const update = {
        $set: {
          activePackage: pkg,
          webCmpAccess:  { purchased: true, purchasedAt: accessAt },
          leadCmpAccess: { purchased: true, purchasedAt: accessAt },
          updatedAt: accessAt,
        },
        $push: { purchasedPackages: pkg },
        $setOnInsert: { phone, coinsUsed: 0, createdAt: new Date() },
      };
      if (COINS > 0) update.$inc = { coins: COINS };
      await usersCol.updateOne({ phone }, update, { upsert: true });

      /* completed pending-purchase row — feeds the packages-history view */
      await pendingCol.insertOne({
        lowProfileId:         `webinar_${crypto.randomBytes(8).toString("hex")}`,
        phone,
        kind:                 "personal",
        packageKey:           pkg.key,
        packageName:          PKG_NAME,
        description:          PKG_NAME,
        name:                 PKG_NAME,
        totalAmount:          0,
        amountWithVat:        0,
        coinsOverride:        COINS,
        campaignTrafficCount: 0,
        campaignLeadsCount:   0,
        adsCount:             ADS_COUNT,
        socialAdsCount:       0,
        videosCount:          0,
        landingPagesCount:    0,
        logosCount:           0,
        saleSiteCount:        0,
        source:               "webinar_grant",
        createdAt:            PURCHASED_AT,
        completedAt:          PURCHASED_AT,
      });

      console.log(`  ✅ ${phone} — "${PKG_NAME}" הוענקה (${ADS_COUNT} מודעות${COINS ? ` + ${COINS} מטבעות` : ""})`);
      granted++;
    } catch (err) {
      console.error(`  ❌ ${phone} — שגיאה: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ הסתיים — הוענקו: ${granted} · דולגו: ${skipped} · נכשלו: ${failed}`);
  await client.close();
}

run().catch(e => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
