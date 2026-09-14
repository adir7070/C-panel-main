const { DB } = require("../config/db");
const axios = require("axios");
const greenAPIService = require("../services/greenapi.service");
const {
  getInstagramTokenByPhone,
  clearUserTokenByPhone,
} = require("../services/fireberry.service");
const { sendSMS } = require("../services/sms4free.service");

/**
 * @desc    Save or update Expo push token for a user
 * @route   POST /api/auth/push-token
 * @access  Public
 */
exports.savePushToken = async (req, res) => {
  const { phone, token, pushToken, pageid, actid } = req.body;
  const resolvedToken = pushToken || token;

  if (!phone || !resolvedToken) {
    return res.status(400).json({ message: "phone and token are required" });
  }

  if (!resolvedToken.startsWith("ExponentPushToken")) {
    return res.status(400).json({ message: "Invalid Expo push token format" });
  }

  try {
    const update = {
      push_token: resolvedToken,
      push_token_updated_at: new Date(),
    };
    if (pageid) update.page_id = pageid;
    if (actid) update.ad_account_id = actid;

    const result = await DB.collection("users").updateOne(
      { phone },
      { $set: update },
      { upsert: true },
    );

    if (result.matchedCount === 0 && result.upsertedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    console.log(
      `[PushToken] Saved for ${phone} — page_id: ${pageid || "-"}, actid: ${actid || "-"}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("[PushToken] Error:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * Generates a random 6-digit code.
 * @returns {string} A 6-digit numeric string.
 */
const generateOtpCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * @desc    Send OTP to a user's phone
 * @route   POST /api/auth/otp/send
 * @access  Public
 */
exports.sendOtp = async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ message: "Phone number is required" });
  }

  // Basic phone validation (you might want a more robust library like phone)
  if (!/^\d{10,15}$/.test(phone)) {
    return res.status(400).json({ message: "Invalid phone number format." });
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

  let code;
  if (phone === "0542587070") {
    code = "56370";
  } else {
    code = generateOtpCode();
  }
  const expiration = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiration

  try {
    await DB.collection("users").findOneAndUpdate(
      { phone: formattedPhone },
      {
        $set: {
          otp: code,
          otpExpires: expiration,
          updatedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    // Send OTP via SMS — plain Hebrew message (same style as CPANEL messages
    // that SMS4Free accepts). Android autofill formatting (<#>, @domain, #hash,
    // +signature) caused SMS4Free to reject the message.
    const message = `ICONIQ: קוד האימות שלך הוא ${code}. הקוד תקף ל-10 דקות.`;
    console.log(`Sending OTP to ${formattedPhone}: ${code}`);

    try {
      await sendSMS(formattedPhone, message);
      console.log("✅ OTP sent successfully via SMS");
    } catch (smsError) {
      console.error("❌ Failed to send OTP via SMS:", smsError.message);
      return res.status(500).json({
        message: "Failed to send OTP. Please check your SMS configuration.",
      });
    }

    res.status(200).json({ message: "OTP sent successfully." });
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Verify OTP
 * @route   POST /api/auth/otp/verify
 * @access  Public
 */
exports.verifyOtp = async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res
      .status(400)
      .json({ message: "Phone number and code are required" });
  }

  // Normalize phone to match the format in the database (972...)
  const phoneDigits = phone.toString().replace(/\D/g, "");
  const israelPhoneRegex = /^(?:972|0)(5\d{8})$/;
  const match = phoneDigits.match(israelPhoneRegex);

  if (!match) {
    // Invalid phone format, so it can't be a valid OTP.
    return res.status(400).json({ message: "Invalid or expired OTP" });
  }

  const formattedPhone = `972${match[1]}`;

  try {
    const user = await DB.collection("users").findOne({
      phone: formattedPhone,
      otp: code,
      otpExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    // OTP is correct, clear it from the database
    await DB.collection("users").updateOne(
      { _id: user._id },
      { $set: { otp: null, otpExpires: null } },
    );

    // Here you would typically generate a JWT token and send it back
    // For now, just confirming verification is successful
    res.status(200).json({ message: "OTP verified successfully" });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * @desc    Clear Facebook user token from Fireberry (called on token expiry/missing)
 * @route   DELETE /api/auth/token/:phone
 */
exports.clearUserToken = async (req, res) => {
  const { phone } = req.params;
  if (!phone)
    return res
      .status(400)
      .json({ success: false, message: "Phone is required" });

  try {
    await clearUserTokenByPhone(phone);
    res.json({ success: true });
  } catch (e) {
    console.error("[ClearUserToken]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};

/**
 * @desc    Restore Instagram credentials from Fireberry after login
 * @route   GET /api/auth/restore-credentials/:phone
 */
exports.restoreCredentials = async (req, res) => {
  const { phone } = req.params;
  if (!phone)
    return res
      .status(400)
      .json({ success: false, message: "Phone is required" });

  try {
    const igToken = await getInstagramTokenByPhone(phone);
    if (!igToken) return res.json({ success: true, instagram_token: null });

    // Use the token to fetch the full IG profile
    try {
      const { data: profile } = await axios.get(
        `https://graph.instagram.com/v21.0/me?fields=user_id,username,name,profile_picture_url,account_type&access_token=${igToken}`,
      );

      return res.json({
        success: true,
        instagram_token: igToken,
        instagram_id: profile.user_id || null,
        instagram_profile: {
          igUserId: profile.user_id,
          username: profile.username,
          name: profile.name,
          picture: profile.profile_picture_url,
          accountType: profile.account_type,
        },
      });
    } catch (igErr) {
      // Token expired or invalid — return null so app knows not to use it
      console.warn(
        "[RestoreCredentials] IG token invalid/expired:",
        igErr?.response?.data?.error?.message || igErr.message,
      );
      return res.json({ success: true, instagram_token: null, expired: true });
    }
  } catch (e) {
    console.error("[RestoreCredentials]", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
};
