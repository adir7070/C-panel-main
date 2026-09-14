const axios = require("axios");
const { getDB } = require("../config/db");
const fireberryService = require("./fireberry.service");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const users = () => getDB().collection("users");

/**
 * Build all the phone format variants we might see in users.phone.
 * Israeli mobile numbers can be stored as:
 *   "0542587070"       — local with leading 0
 *   "542587070"        — local without leading 0
 *   "972542587070"     — with country code, no plus
 *   "+972542587070"    — with country code and plus
 */
function phoneVariants(input) {
  if (!input) return [];
  const raw = String(input).trim();
  const variants = new Set([raw]);
  const digits = raw.replace(/\D/g, "");
  if (digits) variants.add(digits);
  // strip leading 0, add 972
  if (digits.startsWith("0")) {
    variants.add("972" + digits.slice(1));
    variants.add("+972" + digits.slice(1));
  }
  // strip leading 972, add 0
  if (digits.startsWith("972")) {
    variants.add("0" + digits.slice(3));
  }
  // strip leading +
  if (raw.startsWith("+")) variants.add(raw.slice(1));
  return [...variants];
}

/**
 * Fetch push token for a user by phone — tries all known phone format
 * variants so we find the user even when the chat _id format and the
 * users.phone format don't line up exactly.
 */
async function getUserPushToken(userId) {
  const candidates = phoneVariants(userId);
  if (candidates.length === 0) return null;
  const user = await users().findOne(
    { phone: { $in: candidates } },
    { projection: { push_token: 1, phone: 1 } },
  );
  if (user?.push_token) {
    console.log(`[Push] matched user.phone=${user.phone} (queried variants: ${candidates.join(", ")})`);
  }
  return user?.push_token || null;
}

/**
 * Send a push notification via Expo Push API
 */
async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken || !pushToken.startsWith("ExponentPushToken")) {
    console.warn("[Push] Invalid or missing Expo push token:", pushToken);
    return null;
  }

  const payload = {
    to: pushToken,
    title,
    body,
    sound: "default",
    data,
  };

  const response = await axios.post(EXPO_PUSH_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });

  const result = response.data?.data;
  if (result?.status === "error") {
    console.error("[Push] Expo error:", result.message);
  } else {
    console.log(`[Push] Sent to ${pushToken} — id: ${result?.id}`);
  }

  return result;
}

/**
 * Extract clean phone number from userId (strips "user_" prefix if present)
 * e.g. "user_0526761205" → "0526761205"
 */
function extractPhone(userId) {
  return userId.startsWith("user_") ? userId.slice(5) : userId;
}

/**
 * Send push notification to a user by userId (phone)
 * Returns false if user has no token
 */
async function notifyUser(userId, title, body, data = {}) {
  try {
    const phone = extractPhone(userId);
    console.log(`[Push] notifyUser → userId: ${userId}, derivedPhone: ${phone}`);

    let token = await getUserPushToken(phone);
    let resolvedPhone = phone;

    // Fallback 1: the chat _id we got isn't phone-like (e.g. agent opened via
    // C-panel which passes chat._id that may differ from the customer's
    // phone). Look up the chat doc to find the actual phone, then retry.
    if (!token) {
      try {
        const chat = await getDB().collection("support_chats").findOne(
          { _id: userId },
          { projection: { phone: 1 } },
        );
        if (chat?.phone && chat.phone !== phone) {
          console.log(`[Push] retrying with chat.phone: ${chat.phone}`);
          token = await getUserPushToken(chat.phone);
          if (token) resolvedPhone = chat.phone;
        }
      } catch (err) {
        console.warn(`[Push] chat lookup failed:`, err.message);
      }
    }

    if (!token) {
      console.log(`[Push] No local token for ${resolvedPhone}, trying Fireberry...`);
      token = await fireberryService.getPushTokenByPhone(resolvedPhone);
      if (token) {
        console.log(`[Push] Got token from Fireberry for ${resolvedPhone}`);
      }
    }
    if (!token) {
      console.warn(`[Push] No push token found for user ${userId} (tried phone: ${resolvedPhone})`);
      return false;
    }
    await sendPushNotification(token, title, body, data);
    return true;
  } catch (err) {
    console.error("[Push] notifyUser error:", err.message);
    return false;
  }
}

/**
 * Save or update push token for a user
 */
async function savePushToken(userId, token) {
  await users().updateOne(
    { phone: userId },
    { $set: { push_token: token, push_token_updated_at: new Date() } },
    { upsert: false },
  );
}

module.exports = {
  notifyUser,
  savePushToken,
  sendPushNotification,
};
