#!/usr/bin/env node
/**
 * add-1000-coins-batch.js
 * מוסיף 1000 מטבעות לרשימת מספרים ב-users ומתעד ב-coin_transactions.
 *
 * כותב ל-Atlas בלבד (MONGO_URI). מדלג על משתמשים שלא קיימים — אין upsert,
 * כדי שמספר שגוי לא ייצור רשומת רפאים.
 *
 * שימוש:
 *   node scripts/add-1000-coins-batch.js --dry-run
 *   node scripts/add-1000-coins-batch.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { MongoClient } = require("mongodb");

const COINS_TO_ADD = 1000;
const REASON = "admin_add";
const DRY_RUN = process.argv.includes("--dry-run");

// 9 ספרות כפי שנמסרו; מנורמל ל-05xxxxxxxx שזה הפורמט בפועל ב-users (421/422)
const RAW = [
  "548792958", "523727061", "543521911", "526421001", "535475426", "502426868",
  "502426868", "525108305", "523490019", "549415136", "505553648", "547464047",
  "542526386", "547717100", "526478787", "526499233", "545958573", "546327099",
  "525151052", "587715392", "506930337", "526688766", "547313410", "538286613",
  "537226856", "542001318", "546696888", "524747243", "509790224", "506599686",
  "508282425", "544399622", "527729866", "546474070", "529567648", "544411614",
  "546234222", "528336760", "523039370", "548076726", "522423029", "509755483",
  "509755483", "509755483", "502009715",
];

const PHONES = [...new Set(RAW)].map((p) => `0${p}`);

async function run() {
  if (DRY_RUN) console.log("🔍 DRY RUN — לא מבוצעים שינויים\n");
  console.log(`${RAW.length} שורות → ${PHONES.length} מספרים ייחודיים\n`);

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  console.log("✅ מחובר ל-MongoDB Atlas\n");

  const db = client.db();
  const usersCol = db.collection("users");
  const transCol = db.collection("coin_transactions");

  const credited = [];
  const skipped = [];
  const failed = [];

  for (const phone of PHONES) {
    try {
      // ללא upsert: אם המשתמש לא קיים, updated יהיה null ולא ניצור כלום
      const updated = await (DRY_RUN
        ? usersCol.findOne({ phone }, { projection: { coins: 1 } })
        : usersCol.findOneAndUpdate(
            { phone },
            { $inc: { coins: COINS_TO_ADD }, $set: { updatedAt: new Date() } },
            { returnDocument: "after" },
          ));

      if (!updated) {
        console.log(`  ⏭️  ${phone} — לא קיים, מדלג`);
        skipped.push(phone);
        continue;
      }

      if (DRY_RUN) {
        const before = updated.coins ?? 0;
        console.log(`  📱 ${phone} — ${before} → ${before + COINS_TO_ADD}`);
        credited.push(phone);
        continue;
      }

      const balanceAfter = updated.coins;

      await transCol.insertOne({
        phone,
        type: "add",
        amount: COINS_TO_ADD,
        reason: REASON,
        balance_after: balanceAfter,
        created_at: new Date(),
      });

      console.log(`  ✅ ${phone} — ${balanceAfter - COINS_TO_ADD} → ${balanceAfter}`);
      credited.push(phone);
    } catch (err) {
      console.error(`  ❌ ${phone} — שגיאה: ${err.message}`);
      failed.push(phone);
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`זוכו:   ${credited.length}`);
  console.log(`דולגו:  ${skipped.length}${skipped.length ? "  → " + skipped.join(", ") : ""}`);
  console.log(`נכשלו:  ${failed.length}${failed.length ? "  → " + failed.join(", ") : ""}`);
  console.log(`סה"כ מטבעות ${DRY_RUN ? "שיתווספו" : "שנוספו"}: ${credited.length * COINS_TO_ADD}`);

  await client.close();
}

run().catch((e) => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
