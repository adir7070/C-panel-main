/**
 * Thin wrapper around the Expo Push API. Used by product-status flows
 * to notify the client when a manager pushes a product for approval.
 *
 * NEVER throws — failures are logged and swallowed. Push notifications
 * are a best-effort channel, not a critical path.
 */

const PRODUCT_LABELS = {
  ads:     "המודעות הממומנות שלך מוכנות לאישור",
  organic: "הפוסטים האורגניים שלך מוכנים לאישור",
  lp:      "דף הנחיתה שלך מוכן לאישור",
};

async function sendProductReadyPush(expoToken, productType) {
  if (!expoToken || typeof expoToken !== "string") return { ok: false, reason: "no_token" };
  if (!expoToken.startsWith("ExponentPushToken[")) return { ok: false, reason: "bad_token_format" };

  const body = PRODUCT_LABELS[productType] || "יש לך מוצר חדש לאישור";

  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "Accept":            "application/json",
        "Accept-encoding":   "gzip, deflate",
      },
      body: JSON.stringify({
        to:    expoToken,
        title: "יש לך מוצר חדש לאישור! 🎉",
        body,
        data:  { screen: "products", type: productType },
        sound: "default",
        priority: "high",
      }),
    });
    if (!res.ok) {
      console.warn(`[expo-push] HTTP ${res.status} for token ${expoToken.slice(0, 30)}…`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[expo-push] send failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendProductReadyPush };
