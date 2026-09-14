/**
 * migrate-clients-to-tier.js
 *
 * One-time migration to the subscription model: gives every existing app client
 * a GRANDFATHERED subscription — REGULAR tier, NO monthly charge (amount 0), but
 * the 2,000-coin monthly quota still RESETS each cycle (chargeMode "free"). New
 * clients who sign up later go through the paid purchase flow instead.
 *
 * For each client it:
 *   1. upserts a `subscriptions` doc { source:"tier", tier, chargeMode:"free", status:"active" }
 *   2. RESETS the hidden quota: users.coins = quota, coinsUsed = 0
 *   3. logs a `coin_transactions` "reset" entry (audit trail)
 *
 * Idempotent — skips any phone that already has a tier subscription, so a
 * re-run won't wipe balances that have since been spent.
 *
 * Behaviour is UNCHANGED until the env switches flip (ACCESS_GATES_ENABLED /
 * BILLING_ENABLED) — this only pre-populates data.
 *
 * Run:
 *   node scripts/migrate-clients-to-tier.js            (dry-run — counts only)
 *   node scripts/migrate-clients-to-tier.js --apply    (writes to Mongo)
 *   node scripts/migrate-clients-to-tier.js --apply --tier=PRO
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
// AWS EC2 mongo is dead — go straight to Atlas (skip the 5s AWS timeout).
delete process.env.AWS_MONGO_URI;

const { connectDB, getDB, closeDB } = require("../config/db");
const { TIER_DEFS } = require("../services/tier-subscription.service");

function arg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.slice(name.length + 3) : def;
}
const APPLY = process.argv.includes("--apply");
const TIER = String(arg("tier", "REGULAR")).toUpperCase();

function addMonths(date, n) { const d = new Date(date); d.setMonth(d.getMonth() + n); return d; }

(async () => {
  const def = TIER_DEFS[TIER];
  if (!def) { console.error(`[ERROR] unknown tier: ${TIER}`); process.exit(1); }

  console.log(`[Mode] ${APPLY ? "APPLY (writing to Mongo)" : "DRY-RUN (counts only)"} · tier=${TIER} · ${def.coins} coins/mo · FREE (no charge)`);
  await connectDB();
  const db = getDB();

  const users = await db.collection("users")
    .find({ phone: { $exists: true, $nin: [null, ""] } }, { projection: { phone: 1 } })
    .toArray();
  console.log(`[Mongo] ${users.length} users with a phone`);

  // phones that already have a tier subscription (skip — don't reset a spent balance)
  const existing = new Set(
    (await db.collection("subscriptions").find({ source: "tier" }, { projection: { phone: 1 } }).toArray())
      .map((s) => String(s.phone)),
  );

  const now = new Date();
  const subOps = [], userOps = [], txDocs = [];
  let toMigrate = 0, alreadyHave = 0, badPhone = 0;

  for (const u of users) {
    const phone = String(u.phone || "").trim();
    if (!phone || phone.replace(/\D/g, "").length < 6) { badPhone++; continue; }
    if (existing.has(phone)) { alreadyHave++; continue; }
    toMigrate++;
    if (!APPLY) continue;

    subOps.push({
      updateOne: {
        filter: { phone, source: "tier" },
        update: {
          $set: {
            phone, source: "tier", tier: def.tier, packageName: def.name,
            token: null, cardExpiry: null, last4: null,
            amount: 0, currency: 1, coins: def.coins, coinMode: "reset", chargeMode: "free",
            billingCycle: "monthly", status: "active",
            startedAt: now, lastChargedAt: now, nextChargeAt: addMonths(now, 1),
            failedCharges: 0, grandfathered: true, updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    });
    userOps.push({
      updateOne: {
        filter: { phone },
        update: { $set: { coins: def.coins, coinsUsed: 0, updatedAt: now } },
      },
    });
    txDocs.push({ phone, type: "reset", amount: def.coins, reason: "migration_grandfathered", balance_after: def.coins, created_at: now });
  }

  if (APPLY && subOps.length) {
    // chunked bulk writes
    const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);
    for (const c of chunk(subOps, 200)) await db.collection("subscriptions").bulkWrite(c, { ordered: false });
    for (const c of chunk(userOps, 200)) await db.collection("users").bulkWrite(c, { ordered: false });
    for (const c of chunk(txDocs, 500)) await db.collection("coin_transactions").insertMany(c, { ordered: false });
  }

  console.log(`\n[Result]`);
  console.log(`  Users with a phone            : ${users.length}`);
  console.log(`  Invalid phone (skipped)       : ${badPhone}`);
  console.log(`  Already had a tier sub (skip) : ${alreadyHave}`);
  console.log(`  ${APPLY ? "Migrated to " + TIER : "Would migrate to " + TIER}         : ${toMigrate}`);
  if (APPLY) {
    const active = await db.collection("subscriptions").countDocuments({ source: "tier", status: "active" });
    console.log(`  Active tier subscriptions now : ${active}`);
  } else {
    console.log(`\n[Next] review, then re-run with --apply to write.`);
  }
  await closeDB();
})().catch((e) => { console.error("[FATAL]", e.message || e); process.exit(1); });
