#!/usr/bin/env node
/**
 * upgrade-webinar-offers.js
 *
 * מיגרציה חד-פעמית ללקוחות וובינר קיימים אחרי פיצול חבילת הוובינר לשלוש:
 *   • "חבילת וובינר חודשי"  — $300 לחודש (ההצעה הישנה "חבילת וובינר" משתנה שם במקומה)
 *   • "חבילת וובינר שנתי"   — $240×12 בתשלום שנתי אחד, כולל דף נחיתה
 *   • "חבילת דף נחיתה"      — 2,000 ₪ חד-פעמי
 *
 * רץ על כל טלפון שיש לו הצעת וובינר ב-personal_packages או שהוא לקוח של
 * סוכן הוובינר, ומפעיל את אותה לוגיקת upsert של השרת (createWebinarOffers) —
 * אידמפוטנטי, לא נוגע בחבילות שנרכשו.
 *
 * שימוש:
 *   node scripts/upgrade-webinar-offers.js --dry-run   (בדיקה בלי לשנות)
 *   node scripts/upgrade-webinar-offers.js             (הרצה אמיתית)
 *   node scripts/upgrade-webinar-offers.js --agent webinar   (שם סוכן אחר)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const DRY_RUN = process.argv.includes("--dry-run");
const agentIx = process.argv.indexOf("--agent");
const AGENT   = agentIx > -1 ? process.argv[agentIx + 1] : "webinar";

async function run() {
  if (DRY_RUN) console.log("🔍 DRY RUN — לא מבוצעים שינויים\n");

  const { connectDB, getDB, closeDB } = require("../config/db");
  await connectDB();
  const db = getDB();
  const { createWebinarOffers } = require("../services/webinar-subscription.service");

  /* כל הטלפונים הרלוונטיים: בעלי הצעת וובינר קיימת + לקוחות סוכן הוובינר */
  const [offerPhones, clientRows] = await Promise.all([
    db.collection("personal_packages").distinct("phone", { source: "webinar" }),
    db.collection("cpanel_clients")
      .find({ agentName: AGENT }, { projection: { phone: 1, agentId: 1, agentName: 1 } })
      .toArray(),
  ]);
  const agentByPhone = new Map(clientRows.map(r => [r.phone, r]));
  const phones = [...new Set([...offerPhones, ...clientRows.map(r => r.phone)])].filter(Boolean);
  console.log(`👥 ${phones.length} טלפונים (${offerPhones.length} עם הצעה קיימת · ${clientRows.length} לקוחות של "${AGENT}")\n`);

  let updated = 0, failed = 0;
  for (const phone of phones) {
    try {
      if (DRY_RUN) {
        const existing = await db.collection("personal_packages")
          .find({ phone, source: "webinar" }, { projection: { name: 1, purchased: 1, billingCycle: 1, key: 1 } })
          .toArray();
        const desc = existing.map(p => `${p.name}${p.purchased ? " (נרכשה)" : ""}`).join(" · ") || "אין הצעות";
        console.log(`  📱 ${phone} — כיום: ${desc}`);
        updated++;
        continue;
      }

      const mapping = agentByPhone.get(phone);
      const agent = mapping?.agentId
        ? { _id: mapping.agentId, nickname: mapping.agentName || AGENT }
        : { nickname: AGENT };
      const result = await createWebinarOffers(phone, agent);
      console.log(`  ✅ ${phone} — עודכן: [${result.created.join(", ") || "—"}]${result.skipped.length ? ` · דולג (נרכש): [${result.skipped.join(", ")}]` : ""}`);
      updated++;
    } catch (err) {
      console.error(`  ❌ ${phone} — שגיאה: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✅ הסתיים — טופלו: ${updated} · נכשלו: ${failed}${DRY_RUN ? " (DRY RUN)" : ""}`);
  await closeDB();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error("❌ שגיאה:", e.message);
  process.exit(1);
});
