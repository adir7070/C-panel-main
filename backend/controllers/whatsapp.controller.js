const greenAPIService = require("../services/greenapi.service");
const sms4freeService = require("../services/sms4free.service");
const { DB } = require("../config/db");

const LOW_BALANCE_THRESHOLD = 200;
const BALANCE_CHECK_EVERY = 10;     // Sync real balance from sms4free every N sends
const ALERT_COOLDOWN_HOURS = 24;    // Don't re-alert within this window

/**
 * Atomically decrement last_known_balance by 1 (if known) and increment sent_count.
 * Every BALANCE_CHECK_EVERY sends, sync the real balance from sms4free.
 * Alert admin when balance drops below threshold.
 */
async function trackSmsUsage() {
  try {
    // Single atomic pipeline update: always inc sent_count, decrement balance only if it's a number
    const counter = await DB.collection("sms_counter").findOneAndUpdate(
      { _id: "main" },
      [{
        $set: {
          sent_count: { $add: [{ $ifNull: ["$sent_count", 0] }, 1] },
          last_known_balance: {
            $cond: {
              if: { $isNumber: "$last_known_balance" },
              then: { $subtract: ["$last_known_balance", 1] },
              else: "$last_known_balance",
            },
          },
        },
      }],
      { upsert: true, returnDocument: "after" }
    );

    const { sent_count, last_known_balance, last_alert_sent_at } = counter;

    let balance = last_known_balance ?? null;

    // Sync real balance if: unknown/null OR every BALANCE_CHECK_EVERY sends
    const needsBalanceSync = balance == null || sent_count % BALANCE_CHECK_EVERY === 0;
    if (needsBalanceSync) {
      try {
        balance = await sms4freeService.getBalance();
        await DB.collection("sms_counter").updateOne(
          { _id: "main" },
          { $set: { last_known_balance: balance, last_balance_check: new Date() } }
        );
      } catch (e) {
        console.error("SMS4Free balance check failed:", e.message);
      }
    }

    // Alert admin if balance is low and cooldown has passed
    if (balance !== null && balance < LOW_BALANCE_THRESHOLD) {
      const now = new Date();
      const cooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
      const shouldAlert =
        !last_alert_sent_at ||
        now - new Date(last_alert_sent_at) > cooldownMs;

      if (shouldAlert) {
        const adminPhone = process.env.ADMIN_PHONE;
        if (adminPhone) {
          const alertMsg = `ICONIQ מערכת: שים לב — יתרת ה-SMS עומדת על ${balance} הודעות בלבד. אנא הוסף קרדיט בהקדם כדי להמשיך לקבל קודי אימות.`;
          await sms4freeService.sendSMS(adminPhone.replace(/\D/g, ""), alertMsg);
          await DB.collection("sms_counter").updateOne(
            { _id: "main" },
            { $set: { last_alert_sent_at: now } }
          );
          console.warn(`Low SMS balance alert sent to admin. Balance: ${balance}`);
        }
      }
    }
  } catch (e) {
    // Never fail the main send flow due to counter errors
    console.error("trackSmsUsage error:", e.message);
  }
}

/**
 * @desc    Send WhatsApp message to a phone number
 * @route   POST /api/whatsapp/send
 * @access  Public
 */
exports.sendMessage = async (req, res) => {
  const { phone, message } = req.body;

  // Validate existence
  if (!phone) {
    return res.status(400).json({
      success: false,
      message: "Phone number is required",
    });
  }

  if (!message) {
    return res.status(400).json({
      success: false,
      message: "Message is required",
    });
  }

  // 1. Clean the phone number (remove +, -, spaces, etc.)
  // This turns "+972-50-1234567" into "972501234567"
  const phoneDigits = phone.toString().replace(/\D/g, "");

  // 2. Regex for Israeli Mobile Phones
  // ^          : Start of string
  // (?:972|0)  : Non-capturing group -> Matches either "972" OR "0" at the start
  // (5\d{8})   : Capturing group (Group 1) -> Matches "5" followed by 8 digits (total 9 digits)
  // $          : End of string
  const israelPhoneRegex = /^(?:972|0)(5\d{8})$/;

  const match = phoneDigits.match(israelPhoneRegex);

  if (!match) {
    return res.status(400).json({
      success: false,
      message:
        "Invalid Israeli phone number. Formats allowed: 0501234567, 972501234567, or +972...",
    });
  }

  // 3. Construct the final format: 972 + the captured number (5xxxxxxxx)
  const formattedPhone = `972${match[1]}`;

  // Use default message if not provided (fallback logic, though we checked message above)
  let messageText = message || "Hello from ICONIQ!";

  // New-format messages (iOS + Android autofill) already start with "<#>" — pass through untouched.
  // Only reformat legacy OTP messages that use the old Hebrew pattern.
  if (!messageText.startsWith('<#>')) {
    const otpMatch = messageText.match(/הקוד שלך להתחברות לאפליקציה הוא\s*:\s*(\d+)/);
    if (otpMatch) {
      const code = otpMatch[1];
      messageText = `ICONIQ: קוד האימות שלך הוא ${code}. הקוד תקף ל-10 דקות. אם לא ביקשת קוד, אפשר להתעלם מההודעה.`;
    }
  }

  try {
    let result;
    let provider = "sms4free";

    try {
      result = await sms4freeService.sendSMS(formattedPhone, messageText);
    } catch (smsError) {
      console.warn(`[SMS] SMS4Free failed (${smsError.message}), falling back to Green API`);

      // Strip SMS-specific headers (<#> prefix, @domain line, Android hash) for WhatsApp
      const whatsappText = messageText
        .replace(/^<#>\s*/, "")
        .replace(/\n@.*/s, "")
        .trim();

      result = await greenAPIService.sendMessage(formattedPhone, whatsappText);
      provider = "greenapi";
    }

    await DB.collection("sms_logs").insertOne({
      phone: formattedPhone,
      message: messageText,
      success: true,
      provider,
      response: result,
      created_at: new Date(),
    });

    if (provider === "sms4free") {
      await trackSmsUsage();
    }

    res.status(200).json({
      success: true,
      message: "SMS sent successfully",
      data: result,
      sentTo: formattedPhone,
      provider,
    });
  } catch (error) {
    console.error("Error sending message via all providers:", error);

    await DB.collection("sms_logs").insertOne({
      phone: formattedPhone,
      message: messageText,
      success: false,
      error: error.message,
      created_at: new Date(),
    }).catch(() => {});

    res.status(500).json({
      success: false,
      message: error.message || "Failed to send message",
    });
  }
};

/**
 * @desc    Get all SMS logs
 * @route   GET /api/whatsapp/sms-logs
 * @access  Public
 */
exports.getSmsLogs = async (req, res) => {
  try {
    const { phone, success, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (phone) filter.phone = { $regex: phone.replace(/\D/g, "") };
    if (success !== undefined) filter.success = success === "true";

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [data, total, successTotal, failedTotal] = await Promise.all([
      DB.collection("sms_logs")
        .find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray(),
      DB.collection("sms_logs").countDocuments(filter),
      DB.collection("sms_logs").countDocuments({ success: true }),
      DB.collection("sms_logs").countDocuments({ success: false }),
    ]);

    res.status(200).json({
      success: true,
      total,
      successTotal,
      failedTotal,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data,
    });
  } catch (error) {
    console.error("Error fetching SMS logs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch SMS logs",
    });
  }
};

/**
 * @desc    Get SMS counter stats (sent count + last known balance)
 * @route   GET /api/whatsapp/sms-counter
 * @access  Public
 */
exports.getSmsCounter = async (req, res) => {
  try {
    let counter = await DB.collection("sms_counter").findOne({ _id: "main" });
    let balanceFetchError = null;
    if (!counter || counter.last_known_balance == null) {
      try {
        const balance = await sms4freeService.getBalance();
        await DB.collection("sms_counter").updateOne(
          { _id: "main" },
          { $set: { last_known_balance: balance, last_balance_check: new Date() } },
          { upsert: true }
        );
        counter = await DB.collection("sms_counter").findOne({ _id: "main" });
      } catch (e) {
        balanceFetchError = e.message;
        console.error("getSmsCounter: balance fetch failed:", e.message);
      }
    }
    res.status(200).json({ success: true, data: counter || {}, balanceFetchError });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch counter" });
  }
};

/**
 * @desc    Get Green API account status
 * @route   GET /api/whatsapp/status
 * @access  Public
 */
exports.getStatus = async (req, res) => {
  try {
    const status = await greenAPIService.getAccountState();

    res.status(200).json({
      success: true,
      status: status,
    });
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get account status",
    });
  }
};
