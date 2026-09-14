/**
 * seed-subscription-tiers.js
 *
 * Seeds the three app subscription tiers into `subscription_plans` (the operator
 * catalog + the source of truth the subscription engine reads):
 *
 *   REGULAR  ₪149/mo  → 2,000 coins
 *   PRO      ₪249/mo  → 4,000 coins
 *   VIP      ₪549/mo  → 6,000 coins
 *
 * Idempotent — upserts by `tier`, so re-running just refreshes prices/coins.
 * Does NOT touch users or existing subscriptions (that's the migration script).
 *
 * Run:
 *   node scripts/seed-subscription-tiers.js
 */
require("dns").setServers(["1.1.1.1", "8.8.8.8", "1.0.0.1"]);

const fs = require("fs");
const path = require("path");
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const { MongoClient } = require("mongodb");
const { TIER_DEFS } = require("../services/tier-subscription.service");

const TIERS = [
  { ...TIER_DEFS.REGULAR, description: "גישה מלאה לאפליקציה — יצירת קמפיינים, תמונות ופרסום" },
  { ...TIER_DEFS.PRO,     description: "גישה מלאה + מכסת יצירה מוגדלת" },
  { ...TIER_DEFS.VIP,     description: "גישה מלאה + מכסת היצירה הגבוהה ביותר" },
];

(async () => {
  const uri = process.env.MONGO_URI || process.env.AWS_MONGO_URI;
  if (!uri) { console.error("[ERROR] No MONGO_URI in .env"); process.exit(1); }
  const mongo = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await mongo.connect();
  const db = mongo.db();
  const col = db.collection("subscription_plans");
  console.log(`[Mongo] Connected · db=${db.databaseName}`);

  for (const t of TIERS) {
    await col.updateOne(
      { tier: t.tier },
      {
        $set: {
          tier: t.tier,
          name: t.name,
          description: t.description,
          monthlyPrice: t.monthlyPrice,
          yearlyPrice: 0,
          coinsIncluded: t.coins,
          isActive: true,
          sortOrder: t.sortOrder,
          color: t.color,
          // First-month intro promo (PRO: ₪49 first month, then ₪249/mo)
          introEnabled: !!t.introEnabled,
          introPrice: t.introPrice || 0,
          introMonths: t.introMonths || 1,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
    console.log(`  ✔ ${t.tier.padEnd(8)} ₪${t.monthlyPrice}/mo → ${t.coins} coins`);
  }

  const all = await col.find({}).sort({ sortOrder: 1 }).toArray();
  console.log(`\n[Result] subscription_plans now has ${all.length} plan(s):`);
  all.forEach((p) => console.log(`  ${p.tier || "?"} · ${p.name} · ₪${p.monthlyPrice}/mo · ${p.coinsIncluded} coins · active=${p.isActive}`));
  await mongo.close();
})().catch((e) => { console.error("[FATAL]", e.message || e); process.exit(1); });
