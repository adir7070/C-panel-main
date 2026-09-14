/**
 * customer-cache.service.js
 *
 * DB-first customer data layer.
 * Always reads from `fireberry_customers` MongoDB collection.
 * Falls back to Fireberry API only when the record doesn't exist or was never fetched.
 *
 * Logic:
 *  - `fetchedAt` present  → return from DB (even if some fields are null — Fireberry returned nothing)
 *  - `fetchedAt` absent   → fetch from Fireberry, save to DB, return
 *  - forceRefresh = true  → always fetch from Fireberry, overwrite DB
 */

const DB = require("../utils/DB");
const { getCustomerByPhone: fetchFromFireberry } = require("./fireberry-customers.service");

const CACHE_COL = "fireberry_customers";

/**
 * Normalize a phone number to 10-digit Israeli format (05XXXXXXXX).
 * Falls back to digits-only if the format is unrecognised.
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("972") && digits.length === 12) return "0" + digits.slice(3);
  if (digits.startsWith("0") && digits.length === 10) return digits;
  if (digits.length === 9 && digits.startsWith("5")) return "0" + digits;
  return digits; // best-effort
}

/**
 * Get customer data — DB first, Fireberry fallback.
 *
 * @param {string} phone - Any Israeli phone format
 * @param {{ forceRefresh?: boolean }} opts
 * @returns {Promise<object|null>} Customer record (all fields), or null if not found anywhere
 */
async function getCustomer(phone, { forceRefresh = false } = {}) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const col = DB.collection(CACHE_COL);

  // 1. Check DB cache (skip if force-refresh)
  if (!forceRefresh) {
    const cached = await col.findOne({ phone: normalized });
    if (cached?.fetchedAt) {
      if (cached.accountid) return cached; // נמצא בפיירברי — cache לצמיתות
      // לא נמצא בפיירברי — נחזיר null רק אם ה-cache טרי (< שעה), אחרת נחפש מחדש
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
      if (ageMs < 60 * 60 * 1000) return null;
      // cache ישן של "לא נמצא" — נפנה שוב לפיירברי
    }
  }

  // 2. Fetch from Fireberry
  let fbData = null;
  try {
    fbData = await fetchFromFireberry(normalized);
  } catch (err) {
    console.error("[CustomerCache] Fireberry fetch error for", normalized, ":", err.message);
    // If we have stale cache (no fetchedAt), return it rather than nothing
    const stale = await col.findOne({ phone: normalized });
    if (stale) return stale;
    return null;
  }

  // 3. Build record to save (null if not found in Fireberry — still mark as fetched so we don't retry)
  const record = {
    phone: normalized,
    fetchedAt: new Date(),
    ...(fbData || {}),
  };

  // 4. Upsert to DB
  await col.updateOne(
    { phone: normalized },
    { $set: record },
    { upsert: true }
  );

  return fbData ? record : null;
}

/**
 * Force-refresh a customer record from Fireberry.
 */
async function refreshCustomer(phone) {
  return getCustomer(phone, { forceRefresh: true });
}

module.exports = { getCustomer, refreshCustomer, normalizePhone };
