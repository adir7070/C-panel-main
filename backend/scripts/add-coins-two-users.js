#!/usr/bin/env node
/**
 * add-coins-two-users.js
 * מוסיף 2000 טוקנים לשני מספרים ספציפיים ב-users collection
 * ומתעד כל תוספת ב-coin_transactions
 *
 * שימוש:
 *   node scripts/add-coins-two-users.js --dry-run   (בדיקה בלי לשנות כלום)
 *   node scripts/add-coins-two-users.js             (ביצוע בפועל)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const COINS_TO_ADD = 2000;
const REASON = "admin_add";
const PHONES = ["0548760223", "0549843740"];
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
  if (DRY_RUN) console.log("🔍 DRY RUN — לא מבוצעות שינויים בפועל\n");

  const client = await connectBestAvailable();
  const db = client.db();
  const usersCol = db.collection("users");
  const transCol = db.collection("coin_transactions");

  let success = 0;
  let failed = 0;

  for (const phone of PHONES) {
    try {
      const before = await usersCol.findOne(
        { phone },
        { projection: { coins: 1, _id: 0 } }
      );
      const balanceBefore = before?.coins ?? 0;

      if (DRY_RUN) {
        console.log(
          `  📱 ${phone} — לפני: ${balanceBefore} → אחרי: ${balanceBefore + COINS_TO_ADD}` +
            (before ? "" : "  (משתמש חדש — ייווצר)")
        );
        success++;
        continue;
      }

      const updated = await usersCol.findOneAndUpdate(
        { phone },
        {
          $inc: { coins: COINS_TO_ADD },
          $set: { updatedAt: new Date() },
          $setOnInsert: { phone, createdAt: new Date() },
        },
        { returnDocument: "after", upsert: true }
      );

      const balanceAfter = updated?.coins ?? balanceBefore + COINS_TO_ADD;

      await transCol.insertOne({
        phone,
        type: "add",
        amount: COINS_TO_ADD,
        reason: REASON,
        balance_after: balanceAfter,
        created_at: new Date(),
      });

      console.log(`  ✅ ${phone} — לפני: ${balanceBefore} → אחרי: ${balanceAfter}`);
      success++;
    } catch (err) {
      console.error(`  ❌ ${phone} — שגיאה: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ הסתיים`);
  console.log(`   הצליח:  ${success}`);
  console.log(`   נכשל:   ${failed}`);
  if (!DRY_RUN) console.log(`   סה"כ טוקנים שנוספו: ${success * COINS_TO_ADD}`);

  await client.close();
}

run().catch((e) => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
