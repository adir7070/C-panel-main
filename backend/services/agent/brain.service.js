'use strict';

/**
 * brain.service — the agent's LEARNED brain. v1 ships a hand-seeded playbook
 * (config/agent-brain.seed.json, loaded by system-prompt.js). Shadow-learning
 * (jobs/distill-playbook.job.js) distills the best real human-manager
 * conversations into a versioned `agent_brain` doc; this service serves the
 * latest one to the system prompt, cached in-process so a run never pays a DB
 * round-trip for it.
 *
 * agent_brain doc: { version, source:"distilled", playbookText, stats, createdAt, active }
 */

const { getDB } = require("../../config/db");

const col = () => getDB().collection("agent_brain");
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = { text: null, at: 0 };

let indexed = false;
async function ensureIndexes() {
  if (indexed) return;
  try {
    await col().createIndex({ active: 1, createdAt: -1 });
    indexed = true;
  } catch (e) { console.warn("[brain] index ensure failed:", e.message); }
}

/** Latest active distilled playbook text, or null. Cached ~5min (pass force to bust). */
async function getActiveBrainText(force = false) {
  if (!force && _cache.text !== null && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.text;
  try {
    const doc = await col().find({ active: { $ne: false } }).sort({ createdAt: -1 }).limit(1).next();
    _cache = { text: doc?.playbookText || null, at: Date.now() };
  } catch (e) {
    console.warn("[brain] getActiveBrainText failed:", e.message);
    _cache = { text: null, at: Date.now() };
  }
  return _cache.text;
}

/** Persist a freshly distilled playbook as the new active version. */
async function saveBrain({ playbookText, stats }) {
  await ensureIndexes();
  const last = await col().find({}).sort({ version: -1 }).limit(1).next();
  const version = (last?.version || 0) + 1;
  const doc = {
    version,
    source: "distilled",
    playbookText,
    stats: stats || {},
    createdAt: new Date(),
    active: true,
  };
  // demote older versions, then insert the new active one
  await col().updateMany({ active: true }, { $set: { active: false } });
  await col().insertOne(doc);
  _cache = { text: playbookText, at: Date.now() };
  return { version };
}

async function getActiveBrainDoc() {
  return col().find({ active: { $ne: false } }).sort({ createdAt: -1 }).limit(1).next();
}

module.exports = { getActiveBrainText, saveBrain, getActiveBrainDoc, ensureIndexes };
