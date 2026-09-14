/**
 * Normalize an Israeli phone number to local format (05XXXXXXXX).
 * Accepts: 05XXXXXXXX, 9725XXXXXXXX, +9725XXXXXXXX
 * Returns null if the input is invalid.
 */
function normalizePhone(phone) {
  if (!phone) return null;

  // Strip leading + then ensure only digits remain
  const stripped = String(phone).replace(/^\+/, "");
  if (/\D/.test(stripped)) return null;

  const normalized = stripped.replace(/^972/, "0");
  return /^05\d{8}$/.test(normalized) ? normalized : null;
}

module.exports = { normalizePhone };
