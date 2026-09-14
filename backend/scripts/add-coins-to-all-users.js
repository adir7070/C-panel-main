#!/usr/bin/env node
/**
 * add-coins-to-all-users.js
 * מוסיף 700 זיטונים לכל הלקוחות ב-users collection
 * ומתעד כל תוספת ב-coin_transactions
 *
 * שימוש:
 *   node scripts/add-coins-to-all-users.js
 *   node scripts/add-coins-to-all-users.js --dry-run   (בדיקה בלי לשנות כלום)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const COINS_TO_ADD = 700;
const REASON = "bonus";
const DRY_RUN = process.argv.includes("--dry-run");

async function connectBestAvailable() {
  // נסה AWS קודם (מהיר, מקומי), אחר כך Atlas
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

  // קבל את כל המשתמשים
  const users = await usersCol
    .find({}, { projection: { phone: 1, coins: 1, _id: 0 } })
    .toArray();

  console.log(`👥 נמצאו ${users.length} לקוחות\n`);

  if (users.length === 0) {
    console.log("אין לקוחות — יוצא");
    await client.close();
    return;
  }

  let success = 0;
  let failed = 0;
  const transactions = [];

  for (const user of users) {
    if (!user.phone) {
      console.warn("  ⚠️  לקוח ללא phone — מדלג");
      failed++;
      continue;
    }

    try {
      if (!DRY_RUN) {
        // עדכון אטומי — $inc מחזיר את המסמך אחרי העדכון
        const updated = await usersCol.findOneAndUpdate(
          { phone: user.phone },
          {
            $inc: { coins: COINS_TO_ADD },
            $set: { updatedAt: new Date() },
          },
          { returnDocument: "after" }
        );

        const balanceAfter = updated?.coins ?? (user.coins ?? 0) + COINS_TO_ADD;

        transactions.push({
          phone: user.phone,
          type: "add",
          amount: COINS_TO_ADD,
          reason: REASON,
          balance_after: balanceAfter,
          created_at: new Date(),
        });
      } else {
        const balanceBefore = user.coins ?? 0;
        console.log(
          `  📱 ${user.phone} — לפני: ${balanceBefore} → אחרי: ${balanceBefore + COINS_TO_ADD}`
        );
      }

      success++;
    } catch (err) {
      console.error(`  ❌ ${user.phone} — שגיאה: ${err.message}`);
      failed++;
    }
  }

  // הכנסת כל הטרנזקציות בבת אחת
  if (!DRY_RUN && transactions.length > 0) {
    await transCol.insertMany(transactions);
    console.log(`📒 נרשמו ${transactions.length} טרנזקציות ב-coin_transactions`);
  }

  console.log(`\n✅ הסתיים`);
  console.log(`   הצליח:  ${success}`);
  console.log(`   נכשל:   ${failed}`);
  if (!DRY_RUN) {
    console.log(`   סה"כ זיטונים שנוספו: ${success * COINS_TO_ADD}`);
  }

  await client.close();
}

run().catch((e) => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
