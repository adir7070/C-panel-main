const axios = require("axios");

// Optional external purchase feed. The old hardcoded Make.com hook belonged to
// Iconiq — when PURCHASE_WEBHOOK_URL is unset nothing is sent.
const WEBHOOK_URL = process.env.PURCHASE_WEBHOOK_URL;

async function sendPurchaseWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await axios.post(WEBHOOK_URL, payload, { timeout: 5000 });
    console.log(`[PurchaseWebhook] Sent: ${payload.event} source=${payload.source}`);
  } catch (err) {
    console.warn("[PurchaseWebhook] Failed to send:", err.message);
  }
}

module.exports = { sendPurchaseWebhook };
