"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// DynamicConfigService
//
// Fetches WhatsApp marketing operational settings from MongoDB and caches them
// in-process memory. All values are editable at runtime without server restart.
//
// MongoDB collection: wa_marketing_config
// Document shape:     { key: string, value: any, updatedAt: Date }
//
// Usage:
//   const cfg = require('./dynamic-config.service');
//   const delay = await cfg.get('typingDelayPerChar');  // → 40
//   await cfg.set('banRiskThreshold', 3);               // live update
//   const all  = await cfg.getAll();                    // full snapshot
// ─────────────────────────────────────────────────────────────────────────────

const DB = require("../../utils/DB");

const COLLECTION = "wa_marketing_config";

// ── Default values ────────────────────────────────────────────────────────────
// These are used when no document exists in MongoDB for that key.
// Edit here to change the factory defaults (they also seed the DB on first run).
const DEFAULTS = {
  // Typing simulation (Feature 2 — Human Simulator)
  typingDelayPerChar: 40,   // ms added per character of message text
  typingDelayMin: 800,      // ms — floor for typing duration
  typingDelayMax: 6000,     // ms — ceiling for typing duration

  // Inter-message pacing — pause AFTER sending before picking next job
  messageDelayMin: 2000,    // ms
  messageDelayMax: 5000,    // ms

  // Ban-Risk Kill Switch (Feature 29)
  banRiskThreshold: 5,      // number of connectionClosed events before kill switch trips

  // Collision Detection (Feature 13)
  collisionDelayMs: 8000,   // ms to postpone a job when target contact is composing
  collisionMaxRetries: 3,   // how many times a job can be postponed for collision

  // Queue worker
  workerConcurrency: 3,     // how many jobs processed in parallel
  workerEnabled: true,      // master on/off switch

  // Cache
  cacheTtlMs: 60000,        // how long in-memory cache is valid (1 min)
};

// ── In-memory cache ───────────────────────────────────────────────────────────
// { key → { value, expiresAt } }
const _cache = new Map();

// Track whether DB has been seeded with defaults
let _seeded = false;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read one config value. Returns cached value if fresh, otherwise fetches
 * from MongoDB. Falls back to DEFAULTS if no document exists.
 *
 * @param {string} key
 * @returns {Promise<any>}
 */
async function get(key) {
  // 1. Check in-memory cache
  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  // 2. Fetch from MongoDB
  try {
    const doc = await DB.collection(COLLECTION).findOne({ key });
    const value = doc ? doc.value : (DEFAULTS[key] ?? null);
    _setCache(key, value);
    return value;
  } catch (err) {
    console.warn(`[DynamicConfig] MongoDB read failed for "${key}", using default:`, err.message);
    const fallback = DEFAULTS[key] ?? null;
    _setCache(key, fallback);
    return fallback;
  }
}

/**
 * Update (or create) a config value in MongoDB and invalidate its cache entry.
 *
 * @param {string} key
 * @param {any}    value
 * @returns {Promise<void>}
 */
async function set(key, value) {
  await DB.collection(COLLECTION).updateOne(
    { key },
    { $set: { key, value, updatedAt: new Date() } },
    { upsert: true },
  );
  // Invalidate so next get() fetches fresh value
  _cache.delete(key);
  console.log(`[DynamicConfig] Updated "${key}" →`, value);
}

/**
 * Return all config values as a plain object (merged defaults + DB overrides).
 * Results are individually cached.
 *
 * @returns {Promise<object>}
 */
async function getAll() {
  const keys = Object.keys(DEFAULTS);
  const entries = await Promise.all(keys.map(async (k) => [k, await get(k)]));
  return Object.fromEntries(entries);
}

/**
 * Bulk-update multiple keys at once.
 *
 * @param {object} updates  - { key: value, ... }
 * @returns {Promise<void>}
 */
async function setMany(updates) {
  await Promise.all(
    Object.entries(updates).map(([k, v]) => set(k, v)),
  );
}

/**
 * Reset a single key to its factory default (deletes the MongoDB document).
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
async function reset(key) {
  await DB.collection(COLLECTION).deleteOne({ key });
  _cache.delete(key);
  console.log(`[DynamicConfig] Reset "${key}" to default (${DEFAULTS[key]})`);
}

/**
 * Invalidate the entire in-memory cache. Next get() calls will re-fetch from DB.
 */
function invalidateCache() {
  _cache.clear();
  console.log("[DynamicConfig] Cache invalidated");
}

/**
 * Seed MongoDB with default values for any key that doesn't yet have a document.
 * Called once on server startup — safe to call multiple times (idempotent).
 *
 * @returns {Promise<void>}
 */
async function seedDefaults() {
  if (_seeded) return;
  _seeded = true;

  try {
    const existing = await DB.collection(COLLECTION)
      .find({})
      .toArray();

    const existingKeys = new Set(existing.map((d) => d.key));
    const missing = Object.entries(DEFAULTS).filter(([k]) => !existingKeys.has(k));

    if (missing.length === 0) return;

    await DB.collection(COLLECTION).insertMany(
      missing.map(([key, value]) => ({ key, value, updatedAt: new Date() })),
    );

    console.log(`[DynamicConfig] Seeded ${missing.length} default config(s):`, missing.map(([k]) => k));
  } catch (err) {
    console.error("[DynamicConfig] Seed failed:", err.message);
    _seeded = false; // allow retry on next call
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setCache(key, value) {
  // TTL is itself a config key — read from cache or use default to avoid recursion
  const ttl = (_cache.get("cacheTtlMs")?.value) ?? DEFAULTS.cacheTtlMs;
  _cache.set(key, { value, expiresAt: Date.now() + ttl });
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  get,
  set,
  getAll,
  setMany,
  reset,
  invalidateCache,
  seedDefaults,
  DEFAULTS, // exported for reference / tests
};
