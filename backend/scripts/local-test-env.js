/**
 * scripts/local-test-env.js
 *
 * Boots an in-memory MongoDB for fully-isolated local testing of the
 * image-generation pipelines, then starts the regular server pointed
 * at that DB. Nothing touches the production Atlas/AWS clusters.
 *
 * Usage:
 *   node scripts/local-test-env.js
 *
 * What it sets up:
 *   - Fresh empty in-memory Mongo at a random local port
 *   - `agents` collection seeded by server's initAdmin() → admin / admin123
 *   - Test client phone 0500000999 with:
 *       • complete business_profiles entry (passes characterization gate)
 *       • activePackage with 10 paidAds / 5 organicAds / 1 lp / 5000 coins
 *       • cpanel_clients mapping to the admin agent (so list/detail works)
 *       • users.coins = 5000
 *
 * Once running, open http://localhost:5174 (Vite must be started separately
 * via `npm run dev` inside the C-panel repo with the .env.local already
 * pointing at http://localhost:3900).
 *
 * Login: admin / admin123 → open client 0500000999 → ProductsTab.
 */

const path = require("path");
const crypto = require("crypto");

(async () => {
  /* Lazy-load mongodb-memory-server so a missing install gives a
     clear error instead of a confusing one elsewhere. */
  let MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = require("mongodb-memory-server"));
  } catch (err) {
    console.error("[local-test-env] mongodb-memory-server not installed.");
    console.error("[local-test-env] Run: npm install --no-save mongodb-memory-server");
    process.exit(1);
  }

  console.log("[local-test-env] Booting in-memory MongoDB…");
  const mongod = await MongoMemoryServer.create({
    instance: { dbName: "iconiq" },
    /* Suppress noisy mongod stdout — we'll print our own status. */
    binary: { systemBinary: process.env.MONGOD_PATH || undefined },
  });
  const uri = mongod.getUri();
  console.log(`[local-test-env] In-memory Mongo at ${uri}`);

  /* config/db.js tries AWS_MONGO_URI first as primary then MONGO_URI
     as fallback, and utils/DB.js dual-writes when BOTH are configured.
     Pointing both at the same in-memory instance fires duplicate-key
     errors on every write. Solution: pre-load .env ourselves, then
     wipe AWS_MONGO_URI to empty string — empty strings are "set" so
     dotenv won't restore them, AND `if (process.env.AWS_MONGO_URI)` in
     config/db.js evaluates falsy, skipping the AWS branch. Result:
     single-DB setup with MONGO_URI = in-memory only. */
  require("dotenv").config();
  process.env.AWS_MONGO_URI = "";
  process.env.MONGO_URI     = uri + "iconiq";

  /* Seed the test data BEFORE booting the server, so when the server
     starts everything's already in place (no race with first requests). */
  const { MongoClient } = require("mongodb");
  const seedClient = new MongoClient(uri + "iconiq");
  await seedClient.connect();
  const db = seedClient.db("iconiq");

  /* Admin agent — same shape that initAdmin() would create, but with a
     known _id we can also reference from cpanel_clients. */
  const hashPass = (p) => crypto.createHash("sha256").update(p + "iconiq2024").digest("hex");
  const adminId = "admin-local-" + crypto.randomBytes(4).toString("hex");
  await db.collection("agents").insertOne({
    _id:        adminId,
    name:       "admin",
    nickname:   "אדמין מקומי",
    password:   hashPass("admin123"),
    role:       "admin",
    active:     true,
    createdAt:  new Date(),
  });
  console.log(`[local-test-env] agent: name=admin password=admin123 (id=${adminId})`);

  /* Test client phone */
  const PHONE = "0500000999";

  /* Business profile — every field assessCompleteness() checks, so the
     ProductsTab characterization gate passes immediately. */
  await db.collection("business_profiles").insertOne({
    phone:          PHONE,
    businessName:   "Iconiq Test בית מרקחת",
    categoryKey:    "retail",
    subCategoryKeys: ["pharmacy"],
    services: [
      { name: "ייעוץ רוקח אישי",   description: "פגישות עם רוקח מוסמך"   },
      { name: "משלוחים עד הבית",  description: "תוך שעה לכל הכרמל"      },
    ],
    targetAudience: ["משפחות באזור חיפה", "גיל 30-60"],
    pageGoal:       "הזמנת תרופות אונליין",
    designStyle:    "modern",
    brandColors:    ["#1E3A8A", "#06B6D4"],
    logoUrl:        null,
    websiteUrl:     "https://example.com",
    createdAt:      new Date(),
  });

  /* User doc with coins + activePackage in BOTH item-name schemas to
     satisfy any reader (we normalize on the way out anyway, but having
     both means the active card chips render no matter which path the
     UI takes). */
  await db.collection("users").insertOne({
    phone:        PHONE,
    coins:        5000,
    coinsUsed:    0,
    activePackage: {
      key:         "test_pack",
      name:        "חבילת בדיקה",
      purchasedAt: new Date().toISOString(),
      items: {
        paidAds:    10,
        organicAds: 5,
        videos:     0,
        lps:        1,
        logos:      0,
      },
      coins:       5000,
      status:      "waiting_brief",
    },
    purchasedPackages: [],
    createdAt:    new Date(),
    updatedAt:    new Date(),
  });

  /* cpanel_clients mapping so admin can find this client via /clients
     listing (admin bypasses the per-row ownership gate, but the listing
     still reads from this collection). */
  await db.collection("cpanel_clients").insertOne({
    agentId:        adminId,
    agentName:      "אדמין מקומי",
    phone:          PHONE,
    customerName:   "לקוח בדיקה",
    firebery1013Id: null,
    customerId:     null,
    createdAt:      new Date(),
  });

  /* Minimal support_chats doc so the client-detail tabs render without
     null guards firing. */
  await db.collection("support_chats").insertOne({
    _id:        PHONE,
    phone:      PHONE,
    name:       "לקוח בדיקה",
    fireberyName: "לקוח בדיקה (Local)",
    status:     "open",
    notes:      "",
    created_at: new Date(),
    updated_at: new Date(),
  });

  /* Also seed a coin top-up package definition so the billing tab has
     something to show if you wander into it. Not strictly needed for
     ad generation but it makes the UI feel less empty. */
  await db.collection("cpanel_products").insertOne({
    key:         "test_pack",
    kind:        "prebuilt",
    name:        "חבילת בדיקה",
    description: "Local test only — never billed",
    price:       1,
    coins:       5000,
    items: {
      paidAds:    10,
      organicAds: 5,
      videos:     0,
      lps:        1,
      logos:      0,
    },
    active:      true,
    createdAt:   new Date(),
  });

  await seedClient.close();
  console.log("[local-test-env] Seed data written:");
  console.log(`[local-test-env]   • test client phone: ${PHONE}`);
  console.log("[local-test-env]   • activePackage: 10 paid ads + 5 organic + 1 LP + 5000 coins");

  /* Now boot the real server. It will read MONGO_URI from process.env
     (we set it above), connectDB() will succeed against the in-memory
     instance, and every request the C-panel sends will land here. */
  console.log("[local-test-env] Booting server.js against in-memory Mongo…");
  require(path.join(__dirname, "..", "server.js"));

  /* Keep the in-memory Mongo alive — it lives in this Node process, so
     when the user Ctrl-C's the server it'll clean up automatically. */
  const shutdown = async () => {
    console.log("\n[local-test-env] Shutting down in-memory Mongo…");
    await mongod.stop();
    process.exit(0);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
})().catch((err) => {
  console.error("[local-test-env] FATAL:", err);
  process.exit(1);
});
