const axios = require("axios");

const SMS4FREE_API_URL = "https://api.sms4free.co.il/ApiSMS/v2/SendSMS";
const SMS4FREE_BALANCE_URL = "https://api.sms4free.co.il/ApiSMS/AvailableSMS";

/**
 * Send SMS via SMS4Free REST API
 * @param {string} recipient - Phone number (e.g. "972501234567")
 * @param {string} message - Message text
 * @returns {Promise<object>} API response { status, message }
 */
exports.sendSMS = async (recipient, message) => {
  const payload = {
    key: process.env.SMS4FREE_API_KEY,
    user: process.env.SMS4FREE_USER,
    pass: process.env.SMS4FREE_PASS,
    sender: "ICONIQ",
    recipient,
    msg: message,
  };

  let response;
  try {
    response = await axios.post(SMS4FREE_API_URL, payload, {
      headers: { "Content-Type": "application/json" },
      validateStatus: null, // don't throw on 4xx/5xx — read the body first
    });
  } catch (err) {
    throw new Error(`SMS4Free network error: ${err.message}`);
  }

  const data = response.data;

  // status > 0 means number of recipients message was sent to
  if (!data || data.status <= 0) {
    const errorMessages = {
      0: "General error",
      "-1": "Invalid credentials",
      "-2": "Invalid sender name/number",
      "-3": "No recipients found",
      "-4": "Insufficient message balance — add credits at sms4free.co.il",
      "-5": "Invalid message content",
      "-6": "Sender verification required",
    };
    const status = data?.status ?? "unknown";
    const desc = errorMessages[String(status)] || `Error code ${status}`;
    // Log full payload context (recipient + first 60 chars of msg) so we can
    // diagnose rejections without exposing full message bodies in logs.
    console.error(
      `[SMS4Free] Reject status=${status} (${desc}) ` +
        `recipient=${recipient} msgPreview="${(message || "").slice(0, 60)}" ` +
        `apiMessage="${data?.message || ""}"`,
    );
    throw new Error(`SMS4Free error: ${desc} — ${data?.message || ""}`);
  }

  return data;
};

/**
 * Get remaining SMS balance from SMS4Free
 * @returns {Promise<number>} Remaining message count
 */
exports.getBalance = async () => {
  const payload = {
    key: process.env.SMS4FREE_API_KEY,
    user: process.env.SMS4FREE_USER,
    pass: process.env.SMS4FREE_PASS,
  };

  const response = await axios.post(SMS4FREE_BALANCE_URL, payload, {
    headers: { "Content-Type": "application/json" },
    validateStatus: null,
  });

  const data = response.data;

  // API returns a plain number (e.g. 8446) or an object with { status, message }
  if (typeof data === "number") {
    if (data <= 0) throw new Error(`SMS4Free balance error: ${data}`);
    return data;
  }

  if (data.status <= 0) {
    throw new Error(`SMS4Free balance error: ${data.message || data.status}`);
  }

  return data.status;
};
