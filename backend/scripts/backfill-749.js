/**
 * One-shot backfill: customer paid 749₪ for חבילת בייסיק before paymentNotify
 * was patched to write activePackage. This finds the most recent 749 pending
 * and backfills the user record.
 *
 * Run:  DRY=1 node scripts/backfill-749.js   (prints, no write)
 * Run:  node scripts/backfill-749.js          (writes)
 */
const fs   = require("fs");
const path = require("path");

/* tiny inline .env parser so we don't need the dotenv module */
(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const { MongoClient } = require("mongodb");

const DRY = !!process.env.DRY;

(async () => {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db();

  /* most recent 749 purchase */
  let pending = await db.collection("cpanel_pending_purchases")
    .find({ totalAmount: 749 })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  pending = pending[0];

  if (!pending) {
    console.log("No 749 pending purchase found.");
    await client.close();
    return;
  }

  console.log("=== Pending purchase found ===");
  console.log("phone:        ", pending.phone);
  console.log("kind:         ", pending.kind);
  console.log("description:  ", pending.description);
  console.log("name:         ", pending.name);
  console.log("totalAmount:  ", pending.totalAmount);
  console.log("createdAt:    ", pending.createdAt);
  console.log("completedAt:  ", pending.completedAt);
  console.log("adsCount:     ", pending.adsCount);
  console.log("socialAdsCount:", pending.socialAdsCount);
  console.log("organicPosts: ", pending.organicPosts);
  console.log("videosCount:  ", pending.videosCount);
  console.log("logosCount:   ", pending.logosCount);
  console.log("landingPagesCount:", pending.landingPagesCount);
  console.log("coinsOverride:", pending.coinsOverride);

  const coins = Number.isFinite(pending.coinsOverride) && pending.coinsOverride > 0
    ? pending.coinsOverride
    : (pending.kind === "coins" ? 0 : 700);

  const activePackage = {
    id:          pending.kind || "custom",
    name:        pending.description || pending.name || "חבילה",
    purchasedAt: pending.completedAt
      ? new Date(pending.completedAt).toISOString()
      : new Date().toISOString(),
    items: {
      paidAds:    pending.adsCount          || 0,
      organicAds: (pending.socialAdsCount   || 0) + (pending.organicPosts || 0),
      videos:     pending.videosCount       || 0,
      lps:        pending.landingPagesCount || 0,
      logos:      pending.logosCount        || 0,
    },
    coins,
  };

  console.log("\n=== activePackage to write ===");
  console.log(JSON.stringify(activePackage, null, 2));

  /* check existing user */
  const user = await db.collection("users").findOne({ phone: pending.phone });
  if (!user) {
    console.log(`\n!! No user with phone "${pending.phone}" — will upsert.`);
  } else {
    console.log("\n=== Current user state ===");
    console.log("user._id:         ", user._id);
    console.log("user.coins:       ", user.coins);
    console.log("user.activePackage:", JSON.stringify(user.activePackage || null, null, 2));
  }

  if (DRY) {
    console.log("\n[DRY RUN] not writing.");
    await client.close();
    return;
  }

  /* write */
  const update = { $set: { activePackage } };
  /* only credit coins if user does NOT already have credit from a partial run */
  const alreadyHasPackage = user && user.activePackage && user.activePackage.id === activePackage.id;
  if (coins > 0 && !alreadyHasPackage) {
    update.$inc = { coins };
  }

  const result = await db.collection("users").updateOne(
    { phone: pending.phone },
    update,
    { upsert: true }
  );

  console.log("\n=== Result ===");
  console.log("matched:    ", result.matchedCount);
  console.log("modified:   ", result.modifiedCount);
  console.log("upsertedId: ", result.upsertedId);
  console.log(alreadyHasPackage ? "(coins NOT incremented — package already present)" : `(+${coins} coins)`);

  await client.close();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
