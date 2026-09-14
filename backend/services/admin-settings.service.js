/**
 * admin-settings.service — system-wide config in `admin_settings` (KV).
 *
 * Spec: docs/ADMIN-PANEL-SPEC.md sec 2.15. Anything the boss should be
 * able to tune without a deploy goes here. Defaults are baked-in below
 * so the rest of the system always has a value, even before the admin
 * touches the UI.
 */

const { getDB } = require("../config/db");

const COL = "admin_settings";
const col = () => getDB().collection(COL);

/* ── Schema (canonical defaults) ───────────────────────────────────────
   The shape of getAll() / patchSettings() is { sections: { ... } }.
   Each section is a flat key→value map. */
const DEFAULTS = {
  coins: {
    /* Per-action AI cost — debited from user.coins on each use. */
    generateAds:        50,
    regenerateAd:        5,
    generateOrganic:    30,
    regenerateOrganic:   3,
    generateLp:        100,
    regenerateLpImage:  10,
    generateLogo:       20,
    generateVideo:     200,
  },

  commissions: {
    /* Manager commission rate per tier (0 - 1). Server reads on accrual. */
    REGULAR: 0.10,
    SILVER:  0.12,
    PLUS:    0.13,
    PRO:     0.15,
    GOLD:    0.18,
    VIP:     0.20,
  },

  sla: {
    /* Hours after which a task escalates urgency on the tasks page.
       Mirrors the cpanel computeUrgency thresholds. */
    yellowAfterHours: 24,
    orangeAfterHours: 48,
    redAfterHours:    72,
    blinkAfterHours:  120,
  },

  ui: {
    defaultLanguage: "he",
    defaultTimezone: "Asia/Jerusalem",
  },

  flags: {
    /* Feature flags — toggle without deploy. */
    maintenanceMode:        false,
    enableSelfServeRefunds: false,
    enableImpersonation:    false,
    enable2FA:              false,
  },
};

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ section: 1 }, { unique: true });
    indexed = true;
  } catch (err) {
    console.warn("[admin-settings] index ensure failed:", err.message);
  }
}

/** Read all settings, falling back to defaults for anything not stored. */
async function getAll() {
  await ensureIndexes();
  const stored = await col().find({}).toArray();
  const byKey = Object.fromEntries(stored.map(s => [s.section, s.values || {}]));
  const out = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    out[section] = { ...defaults, ...(byKey[section] || {}) };
  }
  return out;
}

/** Update a single section. Validates keys exist in DEFAULTS — anything
    unknown is silently dropped to prevent the UI from polluting the store. */
async function patchSection(section, values) {
  await ensureIndexes();
  const known = DEFAULTS[section];
  if (!known) throw new Error(`unknown settings section: ${section}`);

  const sanitised = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (k in known) sanitised[k] = v;
  }

  const before = await col().findOne({ section });
  await col().updateOne(
    { section },
    {
      $set: { values: { ...(before?.values || {}), ...sanitised }, updatedAt: new Date() },
      $setOnInsert: { section, createdAt: new Date() },
    },
    { upsert: true },
  );
  return { before: before?.values || {}, after: { ...(before?.values || {}), ...sanitised } };
}

/** Resolve a single value with the default fallback. Used by other
    services that want config without round-tripping through the API. */
async function getValue(section, key) {
  if (!DEFAULTS[section] || !(key in DEFAULTS[section])) return undefined;
  const doc = await col().findOne({ section });
  if (doc?.values && key in doc.values) return doc.values[key];
  return DEFAULTS[section][key];
}

module.exports = { DEFAULTS, getAll, patchSection, getValue };
