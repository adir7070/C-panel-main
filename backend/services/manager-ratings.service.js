/**
 * manager-ratings.service — durable star ratings (1..5) clients leave
 * for their assigned account manager. One rating per (managerAgentId,
 * clientPhone) pair; calling rate() again updates the existing row
 * (so a client can revise their score over time).
 *
 * Collection: manager_ratings
 *   {
 *     _id,
 *     managerAgentId: string,
 *     clientPhone:    string,
 *     stars:          1..5 (int),
 *     comment:        string | null   (≤500 chars),
 *     createdAt,
 *     updatedAt,
 *   }
 *
 * Indexes: compound unique on { managerAgentId, clientPhone } prevents
 * duplicates and keeps aggregation queries fast.
 */
const { getDB } = require("../config/db");

const COL = "manager_ratings";

let indexesEnsured = false;
async function ensureIndexes() {
  if (indexesEnsured) return;
  try {
    await getDB().collection(COL).createIndex(
      { managerAgentId: 1, clientPhone: 1 },
      { unique: true, name: "uniq_manager_client" },
    );
    await getDB().collection(COL).createIndex(
      { managerAgentId: 1, createdAt: -1 },
      { name: "by_manager_recent" },
    );
    indexesEnsured = true;
  } catch (err) {
    console.warn("[manager-ratings] index create failed:", err.message);
  }
}

function clampStars(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  if (v < 1 || v > 5) return null;
  return v;
}

/* Upsert a rating. Returns { created: true|false, doc }. */
async function rate({ managerAgentId, clientPhone, stars, comment }) {
  await ensureIndexes();
  const s = clampStars(stars);
  if (s === null) throw new Error("stars must be an integer 1..5");
  const c = typeof comment === "string"
    ? comment.trim().slice(0, 500) || null
    : null;
  const now = new Date();

  const filter = { managerAgentId: String(managerAgentId), clientPhone: String(clientPhone) };
  const r = await getDB().collection(COL).findOneAndUpdate(
    filter,
    {
      $set:         { stars: s, comment: c, updatedAt: now },
      $setOnInsert: { ...filter, createdAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  /* Mongo driver v6: r.value contains the doc. Older drivers return
     the doc directly. Handle both shapes defensively. */
  const doc = r?.value || r || null;
  return { doc };
}

/* Aggregated stats for a list of manager IDs in a single round-trip.
   Returns Map<agentIdString, { avg, count }>. */
async function statsForManagers(agentIds) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return new Map();
  const ids = agentIds.map(String);
  const rows = await getDB().collection(COL).aggregate([
    { $match: { managerAgentId: { $in: ids } } },
    { $group: {
        _id:   "$managerAgentId",
        avg:   { $avg: "$stars" },
        count: { $sum: 1 },
    }},
  ]).toArray();
  const m = new Map();
  for (const r of rows) {
    m.set(String(r._id), {
      avg:   Math.round((r.avg || 0) * 10) / 10,    // 1 decimal
      count: r.count || 0,
    });
  }
  return m;
}

/* Recent reviews for a single manager — for the manager's own
   "what my clients are saying" view. */
async function listForManager(agentId, { limit = 50 } = {}) {
  return getDB().collection(COL)
    .find({ managerAgentId: String(agentId) })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200))
    .toArray();
}

module.exports = {
  rate,
  statsForManagers,
  listForManager,
  ensureIndexes,
};
