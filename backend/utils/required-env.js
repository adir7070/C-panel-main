/* Public origins handed to third parties (Cardcom redirects and webhooks).
   No fallback host: the old Iconiq servers are gone, and a silent fallback
   would send payment confirmations nowhere. */
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} לא מוגדר בשרת`);
  return v.replace(/\/+$/, "");
}

module.exports = { requiredEnv };
