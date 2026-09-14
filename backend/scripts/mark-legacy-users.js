#!/usr/bin/env node
/**
 * mark-legacy-users.js
 * מסמן משתמשים ישנים עם isLegacy: true
 *
 * לוגיקה: כל מי שקיים ב-users collection ולא מופיע ב-cpanel_clients
 * נחשב לקוח ישן שלא צריך לבחור מנהל תיק.
 *
 * שימוש:
 *   node scripts/mark-legacy-users.js
 *   node scripts/mark-legacy-users.js --dry-run
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const DRY_RUN = process.argv.includes("--dry-run");

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
  if (DRY_RUN) console.log("🔍 DRY RUN — לא מבוצעים שינויים בפועל\n");

  const client = await connectBestAvailable();
  const db = client.db();

  // כל הטלפונים שכבר משויכים למנהל תיק
  const managedPhones = await db.collection("cpanel_clients").distinct("phone");
  const managedSet = new Set(managedPhones);
  console.log(`📋 ${managedSet.size} לקוחות מנוהלים ב-cpanel_clients`);

  // כל המשתמשים ב-users שעדיין לא מסומנים
  const users = await db
    .collection("users")
    .find({ isLegacy: { $ne: true } }, { projection: { phone: 1 } })
    .toArray();
  console.log(`👥 ${users.length} משתמשים ב-users ללא סימון isLegacy\n`);

  const legacyPhones = users
    .map((u) => u.phone)
    .filter((p) => p && !managedSet.has(p));

  console.log(`🏷️  ${legacyPhones.length} ישנים לסימון (${users.length - legacyPhones.length} מנוהלים — מדולגים)\n`);

  if (legacyPhones.length === 0) {
    console.log("אין מה לסמן — יוצא");
    await client.close();
    return;
  }

  if (!DRY_RUN) {
    const result = await db
      .collection("users")
      .updateMany({ phone: { $in: legacyPhones } }, { $set: { isLegacy: true } });
    console.log(`✅ עודכנו ${result.modifiedCount} רשומות עם isLegacy: true`);
  } else {
    console.log("DRY RUN — הלקוחות שהיו מסומנים:");
    legacyPhones.slice(0, 20).forEach((p) => console.log("  ", p));
    if (legacyPhones.length > 20) console.log(`  ... ועוד ${legacyPhones.length - 20}`);
  }

  await client.close();
}

run().catch((e) => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
