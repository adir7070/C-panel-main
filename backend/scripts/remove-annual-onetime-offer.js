#!/usr/bin/env node
/**
 * remove-annual-onetime-offer.js
 *
 * ניקוי חד-פעמי: מסיר את הצעת "חבילת וובינר מלאה — תשלום חד-פעמי"
 * (key: webinar_annual_onetime, $2,880) שכבר נוצרה ב-personal_packages.
 * ה-offer כבר הוסר ממערך OFFERS בקוד, כך שלא ייווצר מחדש — הסקריפט הזה
 * מנקה את המסמכים הקיימים כדי שהכרטיס ייעלם מהאפליקציה ומה-cpanel.
 *
 * בטיחות: נוגע רק בהצעות שלא נרכשו (purchased: false). הצעות שנרכשו
 * (אם קיימות) נשארות כרשומת עסקה — לא נמחקות.
 *
 * שימוש:
 *   node scripts/remove-annual-onetime-offer.js            (DRY RUN — רק מציג)
 *   node scripts/remove-annual-onetime-offer.js --apply    (מוחק בפועל)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const FILTER = { source: "webinar", key: "webinar_annual_onetime", purchased: false };

async function run() {
  console.log(APPLY ? "🗑️  APPLY — מוחק בפועל\n" : "🔍 DRY RUN — לא מבוצעים שינויים (הוסף --apply למחיקה)\n");

  const { connectDB, getDB, closeDB } = require("../config/db");
  await connectDB();
  const db = getDB();

  const docs = await db.collection("personal_packages")
    .find(FILTER, { projection: { phone: 1, finalPrice: 1, purchased: 1 } })
    .toArray();

  const purchasedCount = await db.collection("personal_packages")
    .countDocuments({ source: "webinar", key: "webinar_annual_onetime", purchased: true });

  console.log(`🔎 נמצאו ${docs.length} הצעות לא-נרכשו למחיקה` +
    (purchasedCount ? ` · ${purchasedCount} נרכשו — יישארו ולא ייגעו` : "") + "\n");
  for (const d of docs) console.log(`  • ${d.phone} — $${d.finalPrice}`);

  if (!APPLY) {
    console.log("\nℹ️  DRY RUN בלבד. הרץ שוב עם --apply כדי למחוק.");
    await closeDB();
    return;
  }

  const res = await db.collection("personal_packages").deleteMany(FILTER);
  console.log(`\n✅ נמחקו ${res.deletedCount} הצעות.`);
  await closeDB();
}

run().catch(e => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
