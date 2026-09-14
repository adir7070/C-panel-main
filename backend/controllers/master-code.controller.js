/**
 * master-code.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * מערכת "קוד מאסטר" גלובלי שמתחלף אוטומטית כל 10 דקות.
 *
 * לוגיקת חלון הזמן:
 *   windowIndex = Math.floor(unixSeconds / 600)
 *   הקוד מחושב ע"י HMAC-SHA256 של windowIndex + SECRET_SALT ← דטרמיניסטי אבל לא ניתן לזיוף.
 *   expiresAt = (windowIndex + 1) * 600 שניות ← רגע סיום החלון הנוכחי.
 *
 * Grace Period (60 שניות):
 *   כאשר מאמתים קוד, השרת מקבל גם את הקוד של החלון הקודם (windowIndex - 1).
 *   זה מכסה מצב שבו לקוח מזין קוד שנוצר שנייה לפני החלפה — ועיכוב ברשת גרם
 *   לכך שהשרת כבר עבר לחלון הבא.
 */

const crypto = require("crypto");

// ── Salt סודי — ניתן לשנות דרך משתנה סביבה ─────────────────────────────────
const CODE_SALT = process.env.MASTER_CODE_SALT || "iconiq_master_salt_2026";

// ── משך חלון בשניות ─────────────────────────────────────────────────────────
const WINDOW_SECONDS = 600; // 10 דקות

// ── Grace period בשניות ──────────────────────────────────────────────────────
const GRACE_SECONDS = 60;

// ─── פונקציות עזר ─────────────────────────────────────────────────────────────

/**
 * מחשב את אינדקס חלון הזמן עבור Unix timestamp נתון (בשניות).
 * @param {number} unixSec - זמן ב-Unix seconds
 * @returns {number} אינדקס החלון
 */
function getWindowIndex(unixSec) {
  return Math.floor(unixSec / WINDOW_SECONDS);
}

/**
 * מחשב קוד 6 ספרות דטרמיניסטי עבור windowIndex נתון.
 * משתמש ב-HMAC-SHA256 כדי שלא ניתן לחשב את הקוד בלי ה-salt.
 * @param {number} windowIndex
 * @returns {string} קוד 6 ספרות
 */
function generateCodeForWindow(windowIndex) {
  const hmac = crypto
    .createHmac("sha256", CODE_SALT)
    .update(String(windowIndex))
    .digest("hex");

  // לוקחים את 8 התווים הראשונים (32 ביט), ממירים לint, מחלצים 6 ספרות
  const num = parseInt(hmac.slice(0, 8), 16);
  return String(10000 + (num % 90000)); // תמיד 5 ספרות: 10000–99999
}

/**
 * מחזיר את זמן הסיום (ISO String) של חלון נתון.
 * @param {number} windowIndex
 * @returns {string} ISO date string
 */
function getWindowExpiry(windowIndex) {
  return new Date((windowIndex + 1) * WINDOW_SECONDS * 1000).toISOString();
}

// ─── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/master-code/current
 * מחזיר את הקוד הנוכחי + זמן תפוגה + זמן שרת.
 *
 * Response:
 *   { code: "382910", expiresAt: "2026-04-20T10:10:00.000Z", serverTime: "2026-04-20T10:03:42.000Z" }
 */
exports.getCurrentCode = (req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowIndex = getWindowIndex(nowSec);
  const code = generateCodeForWindow(windowIndex);
  const expiresAt = getWindowExpiry(windowIndex);
  const serverTime = new Date().toISOString();

  return res.json({ success: true, code, expiresAt, serverTime });
};

/**
 * POST /api/master-code/validate
 * מאמת קוד שנשלח מהלקוח.
 * מקבל גם קוד מהחלון הקודם (grace period של 60 שניות).
 *
 * Body: { code: "382910" }
 * Response: { valid: true/false, reason?: string }
 */
exports.validateCode = (req, res) => {
  const { code } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ success: false, error: "code is required" });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = getWindowIndex(nowSec);

  // הקוד הנוכחי
  const currentCode = generateCodeForWindow(currentWindow);

  // קוד החלון הקודם (grace period: אם חלפו פחות מ-60 שניות מתחילת החלון הנוכחי)
  const secondsIntoWindow = nowSec % WINDOW_SECONDS;
  const allowPrevious = secondsIntoWindow < GRACE_SECONDS;
  const previousCode = allowPrevious ? generateCodeForWindow(currentWindow - 1) : null;

  const isValid = code === currentCode || (allowPrevious && code === previousCode);

  console.log(
    `🔐 [MasterCode] validate | code=${code} | current=${currentCode}` +
    ` | prev=${previousCode ?? "n/a"} | valid=${isValid}`,
  );

  return res.json({
    success: true,
    valid: isValid,
    ...(isValid ? {} : { reason: "קוד שגוי או פג תוקף" }),
  });
};
