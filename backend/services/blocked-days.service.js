const DB = require("../utils/DB");

const COLLECTION = "blocked_days";

/**
 * מחזיר ימים חסומים בטווח תאריכים כ-map.
 * @param {{ from: string, to: string }} range - "YYYY-MM-DD" strings
 * @returns {Promise<{ [date: string]: { reason: string, blockedByName: string } }>}
 */
async function getBlockedDays({ from, to }) {
  const docs = await DB.collection(COLLECTION)
    .find({ date: { $gte: from, $lte: to } })
    .toArray();

  const result = {};
  for (const doc of docs) {
    result[doc.date] = { reason: doc.reason || "", blockedByName: doc.blockedByName || "" };
  }
  return result;
}

/**
 * מחזיר Set של תאריכים חסומים — לשימוש ב-fetchAvailableSlots.
 * @param {{ from: Date, to: Date }} range
 * @returns {Promise<Set<string>>}
 */
async function getBlockedDaySet({ from, to }) {
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  const docs = await DB.collection(COLLECTION)
    .find({ date: { $gte: fromStr, $lte: toStr } }, { projection: { date: 1 } })
    .toArray();
  return new Set(docs.map((d) => d.date));
}

/**
 * חוסם יום — upsert לפי תאריך.
 */
async function blockDay({ date, reason, blockedByName }) {
  await DB.collection(COLLECTION).updateOne(
    { date },
    {
      $set: {
        date,
        reason: reason || "",
        blockedByName: blockedByName || "",
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/**
 * משחרר יום חסום.
 */
async function unblockDay(date) {
  await DB.collection(COLLECTION).deleteOne({ date });
}

module.exports = { getBlockedDays, getBlockedDaySet, blockDay, unblockDay };
