const { getDB } = require("../config/db");

async function createReceipt({ phone, type, description, amount, coinsGranted, source, lowProfileId }) {
  try {
    const db = getDB();
    const col = db.collection("client_receipts");

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000);

    const countToday = await col.countDocuments({
      createdAt: { $gte: startOfDay, $lt: endOfDay },
    });
    const seq = String(countToday + 1).padStart(4, "0");
    const receiptNumber = `IQRCT-${dateStr}-${seq}`;

    const doc = {
      receiptNumber,
      phone: String(phone),
      type: type || "coins",
      description: description || "",
      amount: Number(amount) || 0,
      coinsGranted: Number(coinsGranted) || 0,
      source: source || "mobile_app",
      lowProfileId: lowProfileId || null,
      createdAt: today,
    };

    const result = await col.insertOne(doc);
    return { ...doc, _id: result.insertedId };
  } catch (err) {
    console.warn("[createReceipt] Failed:", err.message);
    return null;
  }
}

module.exports = { createReceipt };
